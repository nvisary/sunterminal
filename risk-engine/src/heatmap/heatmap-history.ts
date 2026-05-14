import type { RedisBus } from "../bus/redis-bus.ts";
import type { RiskEngineConfig } from "../types/risk.types.ts";
import { RiskSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "heatmap-history" });

export interface HeatmapSnapshot {
  t: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

export interface HeatmapHistoryPayload {
  exchange: string;
  symbol: string;
  intervalMs: number;
  snapshots: HeatmapSnapshot[];
  timestamp: number;
}

interface SymbolState {
  latestBids: Array<[number, number]>;
  latestAsks: Array<[number, number]>;
  history: HeatmapSnapshot[];
  hasOrderbook: boolean;
}

/**
 * Records a rolling window of orderbook snapshots for the Liquidity Heatmap
 * widget. The UI used to accumulate these on the client; doing it on the
 * server means a freshly mounted widget has historical context immediately
 * and multiple clients share one ring buffer instead of paying the memory
 * cost N times.
 */
export class HeatmapHistoryRecorder {
  private bus: RedisBus;
  private cfg: RiskEngineConfig["heatmap"];
  private exchanges: string[];
  private symbols: string[];

  private state = new Map<string, SymbolState>();
  private sampleTimer: NodeJS.Timeout | null = null;

  constructor(
    bus: RedisBus,
    cfg: RiskEngineConfig["heatmap"],
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
      for (const symbol of this.symbols) this.prepareSymbol(exchange, symbol);
    }
    this.sampleTimer = setInterval(
      () => this.sampleAll(),
      this.cfg.intervalMs,
    );
    logger.info("Heatmap history recorder started");
  }

  stop(): void {
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    this.state.clear();
    logger.info("Heatmap history recorder stopped");
  }

  prepareSymbol(exchange: string, symbol: string): void {
    const key = `${exchange}:${symbol}`;
    if (this.state.has(key)) return;
    this.state.set(key, {
      latestBids: [],
      latestAsks: [],
      history: [],
      hasOrderbook: false,
    });
  }

  releaseSymbol(exchange: string, symbol: string): void {
    const key = `${exchange}:${symbol}`;
    if (!this.state.delete(key)) return;
    void this.bus
      .cacheDel(RiskSnapshotKeys.heatmapHistory(exchange, symbol))
      .catch((err) =>
        logger.warn({ err, exchange, symbol }, "Failed to drop heatmap snap"),
      );
  }

  onOrderbook(
    exchange: string,
    symbol: string,
    data: Record<string, unknown>,
  ): void {
    const key = `${exchange}:${symbol}`;
    let s = this.state.get(key);
    if (!s) {
      this.prepareSymbol(exchange, symbol);
      s = this.state.get(key)!;
    }
    s.latestBids = (data.bids as Array<[number, number]>) ?? [];
    s.latestAsks = (data.asks as Array<[number, number]>) ?? [];
    s.hasOrderbook = s.latestBids.length > 0 || s.latestAsks.length > 0;
  }

  private sampleAll(): void {
    const now = Date.now();
    const cutoff = now - this.cfg.windowMs;
    for (const [key, s] of this.state) {
      if (!s.hasOrderbook) continue;
      s.history.push({
        t: now,
        bids: s.latestBids,
        asks: s.latestAsks,
      });
      // Drop snapshots older than the window. The window has a hard size
      // cap too so a misconfigured (huge) window can't OOM the service.
      const maxKeep = Math.ceil(this.cfg.windowMs / this.cfg.intervalMs) + 4;
      while (s.history.length > maxKeep) s.history.shift();
      while (s.history.length > 0 && s.history[0]!.t < cutoff) s.history.shift();

      void this.publish(key, s);
    }
  }

  private async publish(key: string, s: SymbolState): Promise<void> {
    const [exchange, ...rest] = key.split(":");
    const symbol = rest.join(":");
    const payload: HeatmapHistoryPayload = {
      exchange: exchange!,
      symbol,
      intervalMs: this.cfg.intervalMs,
      snapshots: s.history,
      timestamp: Date.now(),
    };
    await this.bus.setSnapshot(
      RiskSnapshotKeys.heatmapHistory(exchange!, symbol),
      payload,
    );
  }
}
