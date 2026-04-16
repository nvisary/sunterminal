import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import type { SignalPublisher } from "../signal-bus/signal-publisher.ts";
import type { VolatilityData, VolatilityRegime, RiskEngineConfig } from "../types/risk.types.ts";
import { MdStreamKeys, RiskSnapshotKeys, RiskHistoryKeys } from "../bus/channels.ts";
import { computeATR, computeATRPercent, computeHistoricalVol, computeRealtimeVol } from "./indicators.ts";
import { classifyRegime } from "./regime-classifier.ts";
import pino from "pino";

const logger = pino({ name: "volatility-scanner" });

type OHLCV = [number, number, number, number, number, number];

interface SymbolState {
  tickBuffer: number[];       // circular buffer of recent prices
  volatility: VolatilityData | null;
  prevRegime: VolatilityRegime | null;
}

export class VolatilityScanner {
  private bus: RedisBus;
  private publisher: SignalPublisher;
  private cfg: RiskEngineConfig["volatility"];
  private exchanges: string[];
  private symbols: string[];

  private stateMap = new Map<string, SymbolState>();
  private abortController: AbortController | null = null;
  private ohlcvTimer: ReturnType<typeof setInterval> | null = null;
  private regimeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    bus: RedisBus,
    publisher: SignalPublisher,
    cfg: RiskEngineConfig["volatility"],
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
    this.abortController = new AbortController();

    // Initialize state for each exchange:symbol
    for (const exchange of this.exchanges) {
      for (const symbol of this.symbols) {
        const key = `${exchange}:${symbol}`;
        this.stateMap.set(key, {
          tickBuffer: [],
          volatility: null,
          prevRegime: null,
        });
      }
    }

    // Periodic OHLCV fetch + ATR/vol calculation (every 60s)
    this.ohlcvTimer = setInterval(() => this.updateFromOHLCV(), 60_000);
    // Initial fetch
    this.updateFromOHLCV();

    // Periodic regime reclassification (every 5 min)
    this.regimeTimer = setInterval(() => this.reclassifyRegimes(), 300_000);

    logger.info({ exchanges: this.exchanges, symbols: this.symbols }, "Volatility scanner started");
  }

  stop(): void {
    this.abortController?.abort();
    if (this.ohlcvTimer) clearInterval(this.ohlcvTimer);
    if (this.regimeTimer) clearInterval(this.regimeTimer);
    logger.info("Volatility scanner stopped");
  }

  /**
   * Called by MarketDataConsumer on each trade update.
   */
  onTrade(exchange: string, symbol: string, data: Record<string, unknown>): void {
    const key = `${exchange}:${symbol}`;
    const state = this.stateMap.get(key);
    if (!state) return;

    const price = data.price as number;
    if (!price || price <= 0) return;

    // Add to circular buffer
    state.tickBuffer.push(price);
    if (state.tickBuffer.length > this.cfg.realtimeTickWindow) {
      state.tickBuffer.shift();
    }

    // Update realtime vol
    if (state.volatility && state.tickBuffer.length >= 10) {
      state.volatility.realtimeVol = computeRealtimeVol(state.tickBuffer);
    }
  }

  getVolatility(exchange: string, symbol: string): VolatilityData | null {
    return this.stateMap.get(`${exchange}:${symbol}`)?.volatility ?? null;
  }

  getRegime(exchange: string, symbol: string): VolatilityRegime {
    return this.stateMap.get(`${exchange}:${symbol}`)?.volatility?.regime ?? "NORMAL";
  }

  // ─── Private ──────────────────────────────────────────────────

  private async updateFromOHLCV(): Promise<void> {
    for (const exchange of this.exchanges) {
      for (const symbol of this.symbols) {
        try {
          const candles = await this.fetchOHLCV(exchange, symbol, "1h", 100);
          if (!candles || candles.length < this.cfg.atrPeriod + 1) continue;

          const atr = computeATR(candles, this.cfg.atrPeriod);
          const lastClose = candles[candles.length - 1]![4];
          const atrPercent = computeATRPercent(atr, lastClose);
          const historicalVol = computeHistoricalVol(candles, this.cfg.histVolPeriod, 1);

          const key = `${exchange}:${symbol}`;
          const state = this.stateMap.get(key);
          if (!state) continue;

          const realtimeVol = state.tickBuffer.length >= 10
            ? computeRealtimeVol(state.tickBuffer)
            : 0;

          // Store ATR% in history for percentile calculation
          await this.bus.client.zadd(
            RiskHistoryKeys.atr(exchange, symbol),
            Date.now(),
            String(atrPercent)
          );
          // Trim to last 30 days of 1h values (~720 entries)
          const cutoff = Date.now() - this.cfg.percentileWindowDays * 86_400_000;
          await this.bus.client.zremrangebyscore(
            RiskHistoryKeys.atr(exchange, symbol),
            "-inf",
            cutoff
          );

          // Get history for regime
          const historyRaw = await this.bus.client.zrange(
            RiskHistoryKeys.atr(exchange, symbol),
            0,
            -1
          );
          const history = historyRaw.map(Number);

          const { regime, percentile } = classifyRegime(atrPercent, history);

          state.volatility = {
            exchange,
            symbol,
            atr,
            atrPercent,
            historicalVol,
            realtimeVol,
            regime,
            percentile,
            timestamp: Date.now(),
          };

          // Store snapshot
          await this.bus.setSnapshot(
            RiskSnapshotKeys.volatility(exchange, symbol),
            state.volatility
          );

          // Emit signal on regime change
          if (state.prevRegime !== null && regime !== state.prevRegime) {
            await this.publisher.publishVolatility({
              source: "volatility",
              type: `VOL_${regime}`,
              level: regime === "EXTREME_VOL" ? "danger" : regime === "HIGH_VOL" ? "warning" : "info",
              exchange,
              symbol,
              payload: state.volatility as unknown as Record<string, unknown>,
              action: regime === "EXTREME_VOL" ? "block_new" : "alert",
              timestamp: Date.now(),
            });

            logger.info({ exchange, symbol, prevRegime: state.prevRegime, regime, atrPercent: atrPercent.toFixed(3) }, "Volatility regime changed");
          }
          state.prevRegime = regime;
        } catch (err) {
          logger.error({ exchange, symbol, err }, "OHLCV volatility update failed");
        }
      }
    }
  }

  private async reclassifyRegimes(): Promise<void> {
    // Re-read full history and reclassify (history may have grown)
    await this.updateFromOHLCV();
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
    logger.warn({ exchange, symbol, timeframe }, "OHLCV fetch timed out");
    return null;
  }
}
