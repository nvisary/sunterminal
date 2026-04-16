import type { ExchangeManager } from "../exchanges/exchange-manager.ts";
import type { CacheLayer } from "./cache-layer.ts";
import type { OHLCV, FundingRate, OpenInterest } from "../types/market-data.types.ts";
import { CacheKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "analytics" });

const TIMEFRAME_TTL: Record<string, number> = {
  "1m": 30,
  "5m": 60,
  "15m": 120,
  "1h": 300,
  "4h": 600,
  "1d": 3600,
};

/**
 * Market analytics service: OHLCV, funding history, open interest.
 * Used by Risk Engine and ML models.
 */
export class AnalyticsService {
  constructor(
    private manager: ExchangeManager,
    private cache: CacheLayer
  ) {}

  async getCandles(
    exchangeId: string,
    symbol: string,
    timeframe: string = "1h",
    limit: number = 500
  ): Promise<OHLCV[]> {
    return this.cache.getOrFetch(
      CacheKeys.ohlcv(exchangeId, symbol, timeframe),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        logger.debug({ exchangeId, symbol, timeframe, count: candles.length }, "Fetched OHLCV");
        return candles;
      },
      { ttl: this.getTTLForTimeframe(timeframe) }
    );
  }

  async getFundingHistory(exchangeId: string, symbol: string): Promise<FundingRate[]> {
    return this.cache.getOrFetch(
      CacheKeys.fundingHistory(exchangeId, symbol),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const history = await exchange.fetchFundingRateHistory(symbol);
        logger.debug({ exchangeId, symbol, count: history.length }, "Fetched funding history");
        return history;
      },
      { ttl: 300 } // 5 minutes
    );
  }

  async getOpenInterest(exchangeId: string, symbol: string): Promise<OpenInterest> {
    return this.cache.getOrFetch(
      CacheKeys.openInterest(exchangeId, symbol),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const oi = await exchange.fetchOpenInterest(symbol);
        logger.debug({ exchangeId, symbol }, "Fetched open interest");
        return oi;
      },
      { ttl: 10 } // 10 seconds
    );
  }

  async getFundingRate(exchangeId: string, symbol: string): Promise<FundingRate> {
    const exchange = this.manager.getExchange(exchangeId);
    return exchange.fetchFundingRate(symbol);
  }

  private getTTLForTimeframe(tf: string): number {
    return TIMEFRAME_TTL[tf] ?? 300;
  }
}
