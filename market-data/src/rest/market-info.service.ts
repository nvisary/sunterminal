import type { ExchangeManager } from "../exchanges/exchange-manager.ts";
import type { CacheLayer } from "./cache-layer.ts";
import type { TickerInfo, Market, Ticker, Currency } from "../types/market-data.types.ts";
import { CacheKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "market-info" });

/**
 * Reference data service: markets, tickers, currencies.
 * Loaded at startup and refreshed by TTL.
 */
export class MarketInfoService {
  constructor(
    private manager: ExchangeManager,
    private cache: CacheLayer
  ) {}

  async getMarkets(exchangeId: string): Promise<Market[]> {
    return this.cache.getOrFetch(
      CacheKeys.markets(exchangeId),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const markets = await exchange.fetchMarkets();
        logger.debug({ exchangeId, count: markets.length }, "Fetched markets");
        return markets;
      },
      { ttl: 3600 } // 1 hour
    );
  }

  async getAllTickers(exchangeId: string): Promise<Record<string, Ticker>> {
    return this.cache.getOrFetch(
      CacheKeys.tickers(exchangeId),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const tickers = await exchange.fetchTickers();
        logger.debug({ exchangeId, count: Object.keys(tickers).length }, "Fetched all tickers");
        return tickers;
      },
      { ttl: 5 } // 5 seconds
    );
  }

  async getTickerInfo(exchangeId: string, symbol: string): Promise<TickerInfo> {
    return this.cache.getOrFetch(
      CacheKeys.ticker(exchangeId, symbol),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const ticker = await exchange.fetchTicker(symbol);
        const market = exchange.market(symbol);

        return {
          symbol: ticker.symbol,
          last: ticker.last,
          bid: ticker.bid,
          ask: ticker.ask,
          baseVolume: ticker.baseVolume,
          quoteVolume: ticker.quoteVolume,
          change: ticker.change,
          percentage: ticker.percentage,
          timestamp: ticker.timestamp,
          minAmount: market.limits.amount?.min,
          pricePrecision: market.precision.price,
          amountPrecision: market.precision.amount,
          makerFee: market.maker,
          takerFee: market.taker,
          contractSize: market.contractSize,
          type: market.type,
        } satisfies TickerInfo;
      },
      { ttl: 3 } // 3 seconds
    );
  }

  async getCurrencies(exchangeId: string): Promise<Record<string, Currency>> {
    return this.cache.getOrFetch(
      CacheKeys.currencies(exchangeId),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const currencies = await exchange.fetchCurrencies();
        logger.debug({ exchangeId, count: Object.keys(currencies).length }, "Fetched currencies");
        return currencies;
      },
      { ttl: 3600 } // 1 hour
    );
  }
}
