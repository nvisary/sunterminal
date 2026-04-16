import type { ExchangeManager } from "../exchanges/exchange-manager.ts";
import type { CacheLayer } from "./cache-layer.ts";
import type { Order, Position, Trade } from "../types/market-data.types.ts";
import type { Balances } from "ccxt";
import { CacheKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "account" });

/**
 * Account/trading data service: balances, positions, orders.
 * Requires API keys. Most methods skip cache (critical freshness).
 */
export class AccountService {
  constructor(
    private manager: ExchangeManager,
    private cache: CacheLayer
  ) {}

  async getBalance(exchangeId: string): Promise<Balances> {
    const exchange = this.manager.getExchange(exchangeId);
    const balance = await exchange.fetchBalance();
    logger.debug({ exchangeId }, "Fetched balance");
    return balance;
  }

  async getOpenOrders(exchangeId: string, symbol?: string): Promise<Order[]> {
    const exchange = this.manager.getExchange(exchangeId);
    const orders = await exchange.fetchOpenOrders(symbol);
    logger.debug({ exchangeId, symbol, count: orders.length }, "Fetched open orders");
    return orders;
  }

  async getOrder(exchangeId: string, id: string, symbol: string): Promise<Order> {
    const exchange = this.manager.getExchange(exchangeId);
    return exchange.fetchOrder(id, symbol);
  }

  async getMyTrades(exchangeId: string, symbol: string): Promise<Trade[]> {
    return this.cache.getOrFetch(
      CacheKeys.myTrades(exchangeId, symbol),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const trades = await exchange.fetchMyTrades(symbol);
        logger.debug({ exchangeId, symbol, count: trades.length }, "Fetched my trades");
        return trades;
      },
      { ttl: 30 } // 30 seconds
    );
  }

  async getPositions(exchangeId: string): Promise<Position[]> {
    const exchange = this.manager.getExchange(exchangeId);
    const positions = await exchange.fetchPositions();
    logger.debug({ exchangeId, count: positions.length }, "Fetched positions");
    return positions;
  }

  async getLeverage(exchangeId: string, symbol: string): Promise<number> {
    return this.cache.getOrFetch(
      CacheKeys.leverage(exchangeId, symbol),
      async () => {
        const exchange = this.manager.getExchange(exchangeId);
        const response = await exchange.fetchLeverage(symbol);
        const leverage =
          typeof response === "number"
            ? response
            : (response as unknown as Record<string, unknown>).leverage as number;
        return leverage;
      },
      { ttl: 60 } // 1 minute
    );
  }

  async setLeverage(exchangeId: string, leverage: number, symbol: string): Promise<void> {
    const exchange = this.manager.getExchange(exchangeId);
    await exchange.setLeverage(leverage, symbol);
    await this.cache.invalidate(CacheKeys.leverage(exchangeId, symbol));
    logger.info({ exchangeId, symbol, leverage }, "Leverage set");
  }
}
