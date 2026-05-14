import type { RedisBus } from "../bus/redis-bus.ts";
import type { SignalPublisher } from "../signal-bus/signal-publisher.ts";
import type {
  RiskEngineConfig,
  MicrostructureData,
} from "../types/risk.types.ts";
import { MdStreamKeys, RiskSnapshotKeys } from "../bus/channels.ts";
import {
  calculateOFI,
  calculateBookImbalance,
  calculateLiquidityVoids,
  type OFIState,
} from "./flow-indicators.ts";
import { TradeAnalyzer, type Trade } from "./trade-analyzer.ts";
import { VPINCalculator } from "./vpin.ts";
import pino from "pino";

const logger = pino({ name: "microstructure-scanner" });

// Symbol is "ready" once we have at least this many trades in the window
// or this much time has passed since prepareSymbol — whichever comes first.
const READY_MIN_TRADES = 3;
const READY_MIN_ELAPSED_MS = 5_000;
// Hydration: how many recent trades to pull from the md:trades stream on
// prepareSymbol so the analyzer doesn't sit at zero on quiet symbols.
const HYDRATE_TRADE_COUNT = 200;
// Periodic cleanup interval — drops stale trades on symbols that aren't
// receiving updates, so CVD/avg-size don't show stale values.
const CLEANUP_INTERVAL_MS = 10_000;

interface SymbolState {
  ofiState: OFIState | null;
  tradeAnalyzer: TradeAnalyzer;
  vpinCalculator: VPINCalculator;
  lastData: MicrostructureData;
  createdAt: number;
}

export class MicrostructureScanner {
  private bus: RedisBus;
  private publisher: SignalPublisher;
  private cfg: RiskEngineConfig["microstructure"];
  private exchanges: string[];
  private symbols: string[];

  private stateMap = new Map<string, SymbolState>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    bus: RedisBus,
    publisher: SignalPublisher,
    cfg: RiskEngineConfig["microstructure"],
    exchanges: string[],
    symbols: string[],
  ) {
    this.bus = bus;
    this.publisher = publisher;
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
    this.cleanupTimer = setInterval(
      () => this.runPeriodicCleanup(),
      CLEANUP_INTERVAL_MS,
    );
    logger.info("Microstructure scanner started");
  }

  prepareSymbol(exchange: string, symbol: string): void {
    const key = `${exchange}:${symbol}`;
    if (this.stateMap.has(key)) return;

    this.stateMap.set(key, {
      ofiState: null,
      tradeAnalyzer: new TradeAnalyzer(this.cfg.tradeWindowMs),
      vpinCalculator: new VPINCalculator(
        this.cfg.vpinBucketVolume,
        this.cfg.vpinBucketCount,
      ),
      lastData: {
        exchange,
        symbol,
        ofi: 0,
        bookImbalance: 0,
        cvd: 0,
        vpin: 0,
        liquidityVoids: [],
        buyVolume: 0,
        sellVolume: 0,
        buyCount: 0,
        sellCount: 0,
        avgTradeSize: 0,
        timestamp: Date.now(),
        ready: false,
      },
      createdAt: Date.now(),
    });
    logger.debug(
      { exchange, symbol },
      "Symbol prepared in microstructure scanner",
    );

    // Fire-and-forget hydration from the md:trades stream so analyzers
    // produce meaningful CVD/avg-size on low-volume symbols immediately.
    this.hydrateFromStream(exchange, symbol).catch((err) =>
      logger.warn({ err, exchange, symbol }, "Microstructure hydration failed"),
    );
  }

  releaseSymbol(exchange: string, symbol: string): void {
    const key = `${exchange}:${symbol}`;
    if (!this.stateMap.delete(key)) return;
    void this.bus
      .cacheDel(RiskSnapshotKeys.microstructure(exchange, symbol))
      .catch((err) =>
        logger.warn(
          { err, exchange, symbol },
          "Failed to drop microstructure snapshot on release",
        ),
      );
    logger.debug({ exchange, symbol }, "Symbol released from microstructure");
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.stateMap.clear();
    logger.info("Microstructure scanner stopped");
  }

  private async hydrateFromStream(
    exchange: string,
    symbol: string,
  ): Promise<void> {
    const streamKey = MdStreamKeys.trades(exchange, symbol);
    const recent = await this.bus.readLatest(streamKey, HYDRATE_TRADE_COUNT);
    if (recent.length === 0) return;

    const state = this.stateMap.get(`${exchange}:${symbol}`);
    if (!state) return; // released while we were fetching

    // readLatest returns newest-first; replay oldest-first into the analyzer.
    for (let i = recent.length - 1; i >= 0; i--) {
      const raw = recent[i]!.data as Partial<Trade>;
      if (
        !raw ||
        typeof raw.amount !== "number" ||
        typeof raw.price !== "number" ||
        typeof raw.timestamp !== "number" ||
        (raw.side !== "buy" && raw.side !== "sell")
      ) {
        continue;
      }
      const trade: Trade = {
        id: typeof raw.id === "string" ? raw.id : "",
        side: raw.side,
        amount: raw.amount,
        price: raw.price,
        timestamp: raw.timestamp,
      };
      state.tradeAnalyzer.update(trade);
      state.vpinCalculator.update(trade);
    }

    this.refreshMetrics(state);
    await this.persist(`${exchange}:${symbol}`);
    logger.debug(
      { exchange, symbol, hydrated: recent.length },
      "Microstructure hydrated from md:trades",
    );
  }

  private runPeriodicCleanup(): void {
    for (const [key, state] of this.stateMap) {
      const beforeCount = state.tradeAnalyzer.tradeCount();
      state.tradeAnalyzer.cleanup();
      if (state.tradeAnalyzer.tradeCount() !== beforeCount) {
        this.refreshMetrics(state);
        void this.persist(key);
      }
    }
  }

  private refreshMetrics(state: SymbolState): void {
    const metrics = state.tradeAnalyzer.getMetrics();
    state.lastData.cvd = metrics.cvd;
    state.lastData.buyVolume = metrics.buyVolume;
    state.lastData.sellVolume = metrics.sellVolume;
    state.lastData.buyCount = metrics.buyCount;
    state.lastData.sellCount = metrics.sellCount;
    state.lastData.avgTradeSize = metrics.avgTradeSize;
    state.lastData.ready = this.computeReady(state);
    state.lastData.timestamp = Date.now();
  }

  private computeReady(state: SymbolState): boolean {
    return (
      state.tradeAnalyzer.tradeCount() >= READY_MIN_TRADES ||
      Date.now() - state.createdAt >= READY_MIN_ELAPSED_MS
    );
  }

  async onOrderbookUpdate(
    exchange: string,
    symbol: string,
    data: any,
  ): Promise<void> {
    const key = `${exchange}:${symbol}`;
    if (!this.stateMap.has(key)) {
      this.prepareSymbol(exchange, symbol);
    }
    const state = this.stateMap.get(key)!;

    const bids = data.bids as number[][];
    const asks = data.asks as number[][];

    const { ofi, nextState } = calculateOFI({ bids, asks }, state.ofiState);
    const imbalance = calculateBookImbalance(
      { bids, asks },
      this.cfg.imbalanceDepth,
    );
    const voids = calculateLiquidityVoids({ bids, asks });

    state.ofiState = nextState;
    state.lastData.ofi = ofi;
    state.lastData.bookImbalance = imbalance;
    state.lastData.liquidityVoids = voids;
    state.lastData.ready = this.computeReady(state);
    state.lastData.timestamp = Date.now();

    await this.persist(key);
  }

  async onTrade(exchange: string, symbol: string, data: any): Promise<void> {
    const key = `${exchange}:${symbol}`;
    if (!this.stateMap.has(key)) {
      this.prepareSymbol(exchange, symbol);
    }
    const state = this.stateMap.get(key)!;

    const trade = {
      id: data.id,
      side: data.side,
      amount: data.amount,
      price: data.price,
      timestamp: data.timestamp,
    };

    state.tradeAnalyzer.update(trade);
    const vpin = state.vpinCalculator.update(trade);

    this.refreshMetrics(state);
    state.lastData.vpin = vpin;

    await this.persist(key);
  }

  getMicrostructure(
    exchange: string,
    symbol: string,
  ): MicrostructureData | null {
    return this.stateMap.get(`${exchange}:${symbol}`)?.lastData ?? null;
  }

  private async persist(key: string): Promise<void> {
    const state = this.stateMap.get(key);
    if (!state) return;

    const parts = key.split(":");
    const exchange = parts[0]!;
    const symbol = parts.slice(1).join(":");

    await this.bus.setSnapshot(
      RiskSnapshotKeys.microstructure(exchange, symbol),
      state.lastData,
    );
  }
}
