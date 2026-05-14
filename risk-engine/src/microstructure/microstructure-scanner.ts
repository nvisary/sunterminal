import type { RedisBus } from "../bus/redis-bus.ts";
import type { SignalPublisher } from "../signal-bus/signal-publisher.ts";
import type {
  RiskEngineConfig,
  MicrostructureData,
} from "../types/risk.types.ts";
import { RiskSnapshotKeys } from "../bus/channels.ts";
import {
  calculateOFI,
  calculateBookImbalance,
  calculateLiquidityVoids,
  type OFIState,
} from "./flow-indicators.ts";
import { TradeAnalyzer } from "./trade-analyzer.ts";
import { VPINCalculator } from "./vpin.ts";
import pino from "pino";

const logger = pino({ name: "microstructure-scanner" });

interface SymbolState {
  ofiState: OFIState | null;
  tradeAnalyzer: TradeAnalyzer;
  vpinCalculator: VPINCalculator;
  lastData: MicrostructureData;
}

export class MicrostructureScanner {
  private bus: RedisBus;
  private publisher: SignalPublisher;
  private cfg: RiskEngineConfig["microstructure"];
  private exchanges: string[];
  private symbols: string[];

  private stateMap = new Map<string, SymbolState>();

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
      },
    });
    logger.debug(
      { exchange, symbol },
      "Symbol prepared in microstructure scanner",
    );
  }

  stop(): void {
    logger.info("Microstructure scanner stopped");
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

    const metrics = state.tradeAnalyzer.update(trade);

    // Dynamic bucket adjustment: if price is high (BTC), use 1/10th of base config
    // to ensure buckets fill more frequently for VPIN calculation.
    const vpin = state.vpinCalculator.update(trade);

    state.lastData.cvd = metrics.cvd;
    state.lastData.vpin = vpin;
    state.lastData.buyVolume = metrics.buyVolume;
    state.lastData.sellVolume = metrics.sellVolume;
    state.lastData.buyCount = metrics.buyCount;
    state.lastData.sellCount = metrics.sellCount;
    state.lastData.avgTradeSize = metrics.avgTradeSize;
    state.lastData.timestamp = Date.now();

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
