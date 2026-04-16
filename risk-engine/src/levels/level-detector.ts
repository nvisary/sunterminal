import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import type { SignalPublisher } from "../signal-bus/signal-publisher.ts";
import type { PriceLevel, LiquidityZone, RiskEngineConfig } from "../types/risk.types.ts";
import { MdStreamKeys, RiskSnapshotKeys } from "../bus/channels.ts";
import { analyzeOrderbook } from "./orderbook-analyzer.ts";
import { detectSwingLevels, mergeSwingLevels } from "./swing-detector.ts";
import { SpoofDetector } from "./spoof-detector.ts";
import pino from "pino";

const logger = pino({ name: "level-detector" });

type OHLCV = [number, number, number, number, number, number];

interface SymbolState {
  obLevels: PriceLevel[];
  obZones: LiquidityZone[];
  swingLevels: PriceLevel[];
  merged: PriceLevel[];
  spoofDetector: SpoofDetector;
}

/**
 * Orchestrates orderbook cluster analysis, OHLCV swing detection, and spoof detection.
 * Merges results into unified PriceLevel[] and LiquidityZone[].
 */
export class LevelDetector {
  private bus: RedisBus;
  private publisher: SignalPublisher;
  private cfg: RiskEngineConfig["levels"];
  private exchanges: string[];
  private symbols: string[];

  private stateMap = new Map<string, SymbolState>();
  private swingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    bus: RedisBus,
    publisher: SignalPublisher,
    cfg: RiskEngineConfig["levels"],
    exchanges: string[],
    symbols: string[]
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
        const key = `${exchange}:${symbol}`;
        const spoofDetector = new SpoofDetector(this.cfg.spoofLifetimeMs, this.cfg.spoofFlickerCount);
        spoofDetector.start();

        this.stateMap.set(key, {
          obLevels: [],
          obZones: [],
          swingLevels: [],
          merged: [],
          spoofDetector,
        });
      }
    }

    // Periodic swing level update (every 5 min)
    this.swingTimer = setInterval(() => this.updateSwingLevels(), 300_000);
    // Initial fetch
    this.updateSwingLevels();

    logger.info({ exchanges: this.exchanges, symbols: this.symbols }, "Level detector started");
  }

  stop(): void {
    if (this.swingTimer) clearInterval(this.swingTimer);
    for (const [, state] of this.stateMap) {
      state.spoofDetector.stop();
    }
    logger.info("Level detector stopped");
  }

  /**
   * Called by MarketDataConsumer on each orderbook update.
   */
  onOrderbookUpdate(exchange: string, symbol: string, data: Record<string, unknown>): void {
    const key = `${exchange}:${symbol}`;
    const state = this.stateMap.get(key);
    if (!state) return;

    const bids = (data.bids as number[][] | undefined) ?? [];
    const asks = (data.asks as number[][] | undefined) ?? [];

    if (bids.length === 0 && asks.length === 0) return;

    // Orderbook cluster analysis
    const { levels, zones } = analyzeOrderbook(
      { bids, asks, exchange, symbol },
      this.cfg.wallThreshold,
      this.cfg.clusterTolerance
    );

    state.obLevels = levels;
    state.obZones = zones;

    // Spoof detection
    const significantPrices = new Set(levels.map((l) => l.price));
    const allVolumes = [...bids, ...asks].map((l) => l[1]!).sort((a, b) => a - b);
    const medianVol = allVolumes.length > 0 ? allVolumes[Math.floor(allVolumes.length / 2)]! : 0;
    const bestBid = bids[0]?.[0] ?? 0;
    const bestAsk = asks[0]?.[0] ?? 0;
    const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0;

    const spoofResults = state.spoofDetector.update(significantPrices, medianVol, midPrice);

    // Mark spoofed levels
    for (const spoof of spoofResults) {
      for (const level of state.obLevels) {
        if (Math.abs(level.price - spoof.price) / level.price < 0.001) {
          level.isSuspectedSpoof = true;
        }
      }
    }

    // Merge with swing levels
    this.mergeLevels(key, exchange, symbol);
  }

  getLevels(exchange: string, symbol: string): PriceLevel[] {
    return this.stateMap.get(`${exchange}:${symbol}`)?.merged ?? [];
  }

  getZones(exchange: string, symbol: string): LiquidityZone[] {
    return this.stateMap.get(`${exchange}:${symbol}`)?.obZones ?? [];
  }

  getNearestLevel(exchange: string, symbol: string, price: number): PriceLevel | null {
    const levels = this.getLevels(exchange, symbol);
    if (levels.length === 0) return null;

    let nearest = levels[0]!;
    let minDist = Math.abs(nearest.price - price);

    for (const level of levels) {
      const dist = Math.abs(level.price - price);
      if (dist < minDist) {
        minDist = dist;
        nearest = level;
      }
    }

    return nearest;
  }

  // ─── Private ──────────────────────────────────────────────────

  private async mergeLevels(key: string, exchange: string, symbol: string): Promise<void> {
    const state = this.stateMap.get(key);
    if (!state) return;

    const allLevels = [...state.obLevels, ...state.swingLevels];

    // Group nearby levels: if ob and swing both identify same price zone, merge
    const merged: PriceLevel[] = [];
    const used = new Set<number>();

    for (let i = 0; i < allLevels.length; i++) {
      if (used.has(i)) continue;

      const level = { ...allLevels[i]! };

      for (let j = i + 1; j < allLevels.length; j++) {
        if (used.has(j)) continue;
        const other = allLevels[j]!;

        if (
          level.type === other.type &&
          Math.abs(level.price - other.price) / level.price < this.cfg.clusterTolerance * 2
        ) {
          level.strength += other.strength;
          level.source = "both";
          level.touches = Math.max(level.touches, other.touches);
          level.lastTouchTime = Math.max(level.lastTouchTime, other.lastTouchTime);
          used.add(j);
        }
      }

      merged.push(level);
    }

    // Sort by strength descending, keep top 20
    merged.sort((a, b) => b.strength - a.strength);
    state.merged = merged.slice(0, 20);

    // Persist
    await this.bus.setSnapshot(RiskSnapshotKeys.levels(exchange, symbol), state.merged);
    await this.bus.setSnapshot(RiskSnapshotKeys.zones(exchange, symbol), state.obZones);
  }

  private async updateSwingLevels(): Promise<void> {
    for (const exchange of this.exchanges) {
      for (const symbol of this.symbols) {
        try {
          const allSwings: PriceLevel[] = [];

          for (const tf of this.cfg.ohlcvTimeframes) {
            const candles = await this.fetchOHLCV(exchange, symbol, tf, 200);
            if (!candles || candles.length < this.cfg.swingLookback * 2 + 1) continue;

            const swings = detectSwingLevels(candles, this.cfg.swingLookback, tf, exchange, symbol);
            allSwings.push(...swings);
          }

          const merged = mergeSwingLevels(allSwings, this.cfg.clusterTolerance);
          const key = `${exchange}:${symbol}`;
          const state = this.stateMap.get(key);
          if (state) {
            state.swingLevels = merged;
            await this.mergeLevels(key, exchange, symbol);
          }

          logger.debug({ exchange, symbol, swingLevels: merged.length }, "Swing levels updated");
        } catch (err) {
          logger.error({ exchange, symbol, err }, "Swing level update failed");
        }
      }
    }
  }

  private async fetchOHLCV(
    exchange: string,
    symbol: string,
    timeframe: string,
    limit: number
  ): Promise<OHLCV[] | null> {
    const reqId = randomUUID();
    const replyTo = MdStreamKeys.restResponse(reqId);

    await this.bus.publish(
      MdStreamKeys.restRequest,
      { method: "fetchOHLCV", exchange, args: [symbol, timeframe, undefined, limit], replyTo },
      1000
    );

    const timeoutMs = 10_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const messages = await this.bus.readLatest(replyTo, 1);
      if (messages.length > 0) {
        await this.bus.client.del(replyTo);
        const response = messages[0]!.data as { success: boolean; data: unknown };
        if (response.success) return response.data as OHLCV[];
        return null;
      }
      await sleep(200);
    }

    await this.bus.client.del(replyTo);
    return null;
  }
}
