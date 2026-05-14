import type { RedisBus } from "../bus/redis-bus.ts";
import type {
  FootprintCandle,
  FootprintLevel,
  FootprintSnapshot,
  RiskEngineConfig,
} from "../types/risk.types.ts";
import { RiskSnapshotKeys, MdStreamKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "footprint-scanner" });

interface SymbolState {
  candles: FootprintCandle[]; // newest last
  // Per-candle level dicts kept separately so we can mutate in place
  // without copying the whole array each trade.
  levelMaps: Array<Map<number, FootprintLevel>>;
  tickSize: number;
}

const PUBLISH_INTERVAL_MS = 500; // coalesce republish; trades may arrive at >100Hz

export class FootprintScanner {
  private bus: RedisBus;
  private cfg: RiskEngineConfig["footprint"];
  private exchanges: string[];
  private symbols: string[];

  private state = new Map<string, SymbolState>();
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    bus: RedisBus,
    cfg: RiskEngineConfig["footprint"],
    exchanges: string[],
    symbols: string[],
  ) {
    this.bus = bus;
    this.cfg = cfg;
    this.exchanges = exchanges;
    this.symbols = symbols;
  }

  start(): void {
    for (const exchange of this.exchanges) {
      for (const symbol of this.symbols) {
        this.prepareSymbol(exchange, symbol);
      }
    }
    this.flushTimer = setInterval(() => this.flush(), PUBLISH_INTERVAL_MS);
    logger.info("Footprint scanner started");
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.state.clear();
    this.dirty.clear();
    logger.info("Footprint scanner stopped");
  }

  prepareSymbol(exchange: string, symbol: string): void {
    const key = `${exchange}:${symbol}`;
    if (this.state.has(key)) return;
    this.state.set(key, {
      candles: [],
      levelMaps: [],
      tickSize: 0,
    });
    // Try to hydrate from md:trades stream so the chart isn't empty after
    // a service restart or a fresh widget mount.
    this.hydrate(exchange, symbol).catch((err) =>
      logger.warn({ err, exchange, symbol }, "Footprint hydration failed"),
    );
  }

  releaseSymbol(exchange: string, symbol: string): void {
    const key = `${exchange}:${symbol}`;
    if (!this.state.delete(key)) return;
    this.dirty.delete(key);
    void this.bus
      .cacheDel(RiskSnapshotKeys.footprint(exchange, symbol))
      .catch((err) =>
        logger.warn({ err, exchange, symbol }, "Failed to drop footprint snap"),
      );
  }

  onTrade(exchange: string, symbol: string, data: Record<string, unknown>): void {
    const price = Number(data.price);
    const amount = Number(data.amount);
    const ts = Number(data.timestamp);
    const side = data.side === "buy" ? "buy" : data.side === "sell" ? "sell" : null;
    if (!Number.isFinite(price) || !Number.isFinite(amount) || !Number.isFinite(ts) || !side) {
      return;
    }
    const key = `${exchange}:${symbol}`;
    let s = this.state.get(key);
    if (!s) {
      this.prepareSymbol(exchange, symbol);
      s = this.state.get(key)!;
    }
    if (s.tickSize === 0) s.tickSize = this.deriveTickSize(price);

    const candleStart = Math.floor(ts / this.cfg.timeframeMs) * this.cfg.timeframeMs;
    let lastIdx = s.candles.length - 1;
    let candle = s.candles[lastIdx];
    if (!candle || candle.startMs !== candleStart) {
      candle = {
        startMs: candleStart,
        open: price,
        high: price,
        low: price,
        close: price,
        poc: price,
        levels: [],
      };
      s.candles.push(candle);
      s.levelMaps.push(new Map());
      if (s.candles.length > this.cfg.maxCandles) {
        s.candles.shift();
        s.levelMaps.shift();
      }
      lastIdx = s.candles.length - 1;
    }
    candle.high = Math.max(candle.high, price);
    candle.low = Math.min(candle.low, price);
    candle.close = price;

    const bucket = this.bucketPrice(price, s.tickSize);
    const m = s.levelMaps[lastIdx]!;
    const lvl = m.get(bucket) ?? { price: bucket, buy: 0, sell: 0 };
    if (side === "buy") lvl.buy += amount;
    else lvl.sell += amount;
    m.set(bucket, lvl);

    this.dirty.add(key);
  }

  private flush(): void {
    if (this.dirty.size === 0) return;
    const keys = Array.from(this.dirty);
    this.dirty.clear();
    for (const key of keys) {
      const s = this.state.get(key);
      if (!s) continue;
      this.refreshCandleLevels(s);
      void this.publish(key, s);
    }
  }

  private refreshCandleLevels(s: SymbolState): void {
    for (let i = 0; i < s.candles.length; i++) {
      const m = s.levelMaps[i]!;
      const levels: FootprintLevel[] = [];
      let pocPrice = s.candles[i]!.close;
      let pocVol = 0;
      for (const lvl of m.values()) {
        levels.push(lvl);
        const v = lvl.buy + lvl.sell;
        if (v > pocVol) {
          pocVol = v;
          pocPrice = lvl.price;
        }
      }
      levels.sort((a, b) => a.price - b.price);
      s.candles[i]!.levels = levels;
      s.candles[i]!.poc = pocPrice;
    }
  }

  private async publish(key: string, s: SymbolState): Promise<void> {
    const [exchange, ...rest] = key.split(":");
    const symbol = rest.join(":");
    const snapshot: FootprintSnapshot = {
      exchange: exchange!,
      symbol,
      timeframeMs: this.cfg.timeframeMs,
      tickSize: s.tickSize,
      candles: s.candles,
      timestamp: Date.now(),
    };
    await this.bus.setSnapshot(
      RiskSnapshotKeys.footprint(exchange!, symbol),
      snapshot,
    );
  }

  private bucketPrice(price: number, tick: number): number {
    const step = tick * this.cfg.tickMultiplier;
    return Math.round((Math.floor(price / step) * step) * 1e8) / 1e8;
  }

  private deriveTickSize(price: number): number {
    // Same heuristic the UI uses when marketInfo isn't loaded. Good enough
    // for footprint bucketing across the whole supported price range.
    if (price > 10000) return 1;
    if (price > 1000) return 0.1;
    if (price > 100) return 0.01;
    if (price > 10) return 0.001;
    if (price > 1) return 0.0001;
    return 0.00001;
  }

  private async hydrate(exchange: string, symbol: string): Promise<void> {
    const streamKey = MdStreamKeys.trades(exchange, symbol);
    // Pull enough trades to cover ~maxCandles*timeframeMs worth of activity.
    const recent = await this.bus.readLatest(streamKey, 5000);
    if (recent.length === 0) return;
    const cutoff = Date.now() - this.cfg.maxCandles * this.cfg.timeframeMs;
    // readLatest returns newest-first; replay oldest-first.
    for (let i = recent.length - 1; i >= 0; i--) {
      const data = recent[i]!.data;
      const ts = Number(data.timestamp);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      this.onTrade(exchange, symbol, data);
    }
    logger.debug(
      { exchange, symbol, hydrated: recent.length },
      "Footprint hydrated",
    );
  }
}
