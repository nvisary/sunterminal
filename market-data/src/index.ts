import { setTimeout as sleep } from "node:timers/promises";
import type {
  MarketDataConfig,
  ConnectorStatus,
  FundingData,
  TickerInfo,
  Trade,
  OrderBook,
  Market,
  Ticker,
  Currency,
  Balances,
  Order,
  Position,
  OHLCV,
  FundingRate,
  OpenInterest,
  RestCommand,
} from "./types/market-data.types.ts";
import { ExchangeManager } from "./exchanges/exchange-manager.ts";
import { RedisBus } from "./bus/redis-bus.ts";
import { CacheLayer } from "./rest/cache-layer.ts";
import { MarketInfoService } from "./rest/market-info.service.ts";
import { AccountService } from "./rest/account.service.ts";
import { AnalyticsService } from "./rest/analytics.service.ts";
import { runPriceFeedLoop } from "./streams/price-feed.stream.ts";
import { runOrderBookLoop } from "./streams/orderbook.stream.ts";
import { runFundingLoop } from "./streams/funding.stream.ts";
import { SnapshotKeys, StreamKeys } from "./bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "market-data-service" });

interface SubscriptionHandle {
  controllers: AbortController[];
  refCount: number;
}

/**
 * MarketDataService — единый фасад модуля Market Data Layer.
 * Управляет WS-подписками, REST-запросами, кэшированием, Redis Streams.
 */
export class MarketDataService {
  private manager: ExchangeManager;
  private bus: RedisBus;
  private cache: CacheLayer;
  private marketInfo: MarketInfoService;
  private account: AccountService;
  private analytics: AnalyticsService;
  private config: MarketDataConfig;

  // Subscription tracking: "exchange:symbol" → handle
  private subscriptions = new Map<string, SubscriptionHandle>();

  // REST command listener controller
  private restCommandController: AbortController | null = null;

  constructor(config: MarketDataConfig) {
    this.config = config;
    this.manager = new ExchangeManager();
    this.bus = new RedisBus(config.redis.url);
    this.cache = new CacheLayer(this.bus);
    this.marketInfo = new MarketInfoService(this.manager, this.cache);
    this.account = new AccountService(this.manager, this.cache);
    this.analytics = new AnalyticsService(this.manager, this.cache);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    logger.info("Starting Market Data Service...");

    // Connect Redis
    await this.bus.connect();

    // Initialize exchanges
    for (const exchangeCfg of this.config.exchanges) {
      try {
        await this.manager.addExchange(exchangeCfg);
        await this.bus.publishStatus(exchangeCfg.id, "connected");

        // Subscribe to default symbols
        for (const symbol of exchangeCfg.defaultSymbols) {
          await this.subscribe(exchangeCfg.id, symbol);
        }
      } catch (err) {
        logger.error({ exchange: exchangeCfg.id, err }, "Failed to start exchange");
        await this.bus.publishStatus(exchangeCfg.id, "error", String(err));
      }
    }

    // Start REST command listener for Python bridge
    this.startRestCommandListener();

    logger.info("Market Data Service started");
  }

  async stop(): Promise<void> {
    logger.info("Stopping Market Data Service...");

    // Stop REST command listener
    this.restCommandController?.abort();

    // Unsubscribe everything
    for (const [key] of this.subscriptions) {
      const [exchange, ...symbolParts] = key.split(":");
      const symbol = symbolParts.join(":");
      await this.forceUnsubscribe(exchange!, symbol);
    }

    // Close exchanges
    await this.manager.closeAll();

    // Disconnect Redis
    await this.bus.disconnect();

    logger.info("Market Data Service stopped");
  }

  // ═══════════════════════════════════════════════════════════════════
  // Dynamic WS subscriptions
  // ═══════════════════════════════════════════════════════════════════

  async subscribe(exchange: string, symbol: string): Promise<void> {
    const key = `${exchange}:${symbol}`;
    const existing = this.subscriptions.get(key);

    if (existing) {
      existing.refCount++;
      logger.debug({ exchange, symbol, refCount: existing.refCount }, "Subscription ref incremented");
      return;
    }

    const ex = this.manager.getExchange(exchange);
    const cfg = this.manager.getConfig(exchange);

    // Create AbortControllers for each stream loop
    const controllers = [
      new AbortController(), // price feed
      new AbortController(), // orderbook
      new AbortController(), // funding
    ];

    this.subscriptions.set(key, { controllers, refCount: 1 });

    // Launch all three watch loops concurrently (fire-and-forget)
    runPriceFeedLoop(ex, symbol, this.bus, controllers[0]!.signal).catch((err) =>
      logger.error({ exchange, symbol, err }, "Price feed loop crashed")
    );
    runOrderBookLoop(ex, symbol, cfg.orderbookDepth, this.bus, controllers[1]!.signal).catch((err) =>
      logger.error({ exchange, symbol, err }, "Orderbook loop crashed")
    );
    runFundingLoop(ex, symbol, this.bus, controllers[2]!.signal).catch((err) =>
      logger.error({ exchange, symbol, err }, "Funding loop crashed")
    );

    logger.info({ exchange, symbol }, "Subscribed");
  }

  async unsubscribe(exchange: string, symbol: string): Promise<void> {
    const key = `${exchange}:${symbol}`;
    const handle = this.subscriptions.get(key);

    if (!handle) {
      logger.warn({ exchange, symbol }, "No subscription to unsubscribe");
      return;
    }

    handle.refCount--;

    if (handle.refCount <= 0) {
      await this.forceUnsubscribe(exchange, symbol);
    } else {
      logger.debug({ exchange, symbol, refCount: handle.refCount }, "Subscription ref decremented");
    }
  }

  private async forceUnsubscribe(exchange: string, symbol: string): Promise<void> {
    const key = `${exchange}:${symbol}`;
    const handle = this.subscriptions.get(key);
    if (!handle) return;

    for (const ctrl of handle.controllers) {
      ctrl.abort();
    }
    this.subscriptions.delete(key);
    logger.info({ exchange, symbol }, "Unsubscribed");
  }

  getSubscriptions(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [key] of this.subscriptions) {
      const [exchange, ...symbolParts] = key.split(":");
      const symbol = symbolParts.join(":");
      if (!result.has(exchange!)) result.set(exchange!, new Set());
      result.get(exchange!)!.add(symbol);
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════
  // WS Snapshot access (via Redis)
  // ═══════════════════════════════════════════════════════════════════

  async getLastPrice(exchange: string, symbol: string): Promise<Trade | null> {
    return this.bus.getSnapshot<Trade>(SnapshotKeys.ticker(exchange, symbol));
  }

  async getOrderBook(exchange: string, symbol: string): Promise<OrderBook | null> {
    return this.bus.getSnapshot<OrderBook>(SnapshotKeys.orderbook(exchange, symbol));
  }

  async getFunding(exchange: string, symbol: string): Promise<FundingData | null> {
    return this.bus.getSnapshot<FundingData>(SnapshotKeys.funding(exchange, symbol));
  }

  async getBestPrice(symbol: string): Promise<{ exchange: string; price: number } | null> {
    let bestAsk: number | null = null;
    let bestExchange: string | null = null;

    for (const exchangeId of this.manager.getExchangeIds()) {
      const ob = await this.bus.getSnapshot<OrderBook>(
        SnapshotKeys.orderbook(exchangeId, symbol)
      );
      if (ob && ob.asks && ob.asks.length > 0) {
        const ask = ob.asks[0]![0]!;
        if (bestAsk === null || ask < bestAsk) {
          bestAsk = ask;
          bestExchange = exchangeId;
        }
      }
    }

    if (bestExchange === null || bestAsk === null) return null;
    return { exchange: bestExchange, price: bestAsk };
  }

  // ═══════════════════════════════════════════════════════════════════
  // REST: Reference data
  // ═══════════════════════════════════════════════════════════════════

  async getMarkets(exchange: string): Promise<Market[]> {
    return this.marketInfo.getMarkets(exchange);
  }

  async getAllTickers(exchange: string): Promise<Record<string, Ticker>> {
    return this.marketInfo.getAllTickers(exchange);
  }

  async getTickerInfo(exchange: string, symbol: string): Promise<TickerInfo> {
    return this.marketInfo.getTickerInfo(exchange, symbol);
  }

  async getCurrencies(exchange: string): Promise<Record<string, Currency>> {
    return this.marketInfo.getCurrencies(exchange);
  }

  // ═══════════════════════════════════════════════════════════════════
  // REST: Account / Trading
  // ═══════════════════════════════════════════════════════════════════

  async getBalance(exchange: string): Promise<Balances> {
    return this.account.getBalance(exchange);
  }

  async getOpenOrders(exchange: string, symbol?: string): Promise<Order[]> {
    return this.account.getOpenOrders(exchange, symbol);
  }

  async getOrder(exchange: string, id: string, symbol: string): Promise<Order> {
    return this.account.getOrder(exchange, id, symbol);
  }

  async getMyTrades(exchange: string, symbol: string): Promise<Trade[]> {
    return this.account.getMyTrades(exchange, symbol);
  }

  async getPositions(exchange: string): Promise<Position[]> {
    return this.account.getPositions(exchange);
  }

  async getLeverage(exchange: string, symbol: string): Promise<number> {
    return this.account.getLeverage(exchange, symbol);
  }

  async setLeverage(exchange: string, leverage: number, symbol: string): Promise<void> {
    return this.account.setLeverage(exchange, leverage, symbol);
  }

  // ═══════════════════════════════════════════════════════════════════
  // REST: Analytics
  // ═══════════════════════════════════════════════════════════════════

  async getCandles(
    exchange: string,
    symbol: string,
    tf: string = "1h",
    limit?: number
  ): Promise<OHLCV[]> {
    return this.analytics.getCandles(exchange, symbol, tf, limit);
  }

  async getFundingHistory(exchange: string, symbol: string): Promise<FundingRate[]> {
    return this.analytics.getFundingHistory(exchange, symbol);
  }

  async getOpenInterest(exchange: string, symbol: string): Promise<OpenInterest> {
    return this.analytics.getOpenInterest(exchange, symbol);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Diagnostics
  // ═══════════════════════════════════════════════════════════════════

  getConnectorStatuses(): Map<string, ConnectorStatus> {
    return this.manager.getStatuses();
  }

  getAvailableExchanges(): string[] {
    return this.manager.getExchangeIds();
  }

  // ═══════════════════════════════════════════════════════════════════
  // REST command listener (Python bridge)
  // ═══════════════════════════════════════════════════════════════════

  private startRestCommandListener(): void {
    this.restCommandController = new AbortController();
    const signal = this.restCommandController.signal;

    (async () => {
      const groupName = "md-rest-handler";
      const consumerName = `md-${process.pid}`;
      const streamKey = StreamKeys.restRequest;

      await this.bus.ensureConsumerGroup(streamKey, groupName);

      while (!signal.aborted) {
        try {
          const messages = await this.bus.readGroup(
            groupName,
            consumerName,
            streamKey,
            5,
            2000
          );

          for (const msg of messages) {
            const cmd = msg.data as unknown as RestCommand;
            await this.handleRestCommand(cmd);
            await this.bus.ack(streamKey, groupName, msg.id);
          }
        } catch (err) {
          if (signal.aborted) break;
          logger.error({ err }, "REST command listener error");
          await sleep(1000);
        }
      }
    })().catch((err) => logger.error({ err }, "REST command listener crashed"));
  }

  private async handleRestCommand(cmd: RestCommand): Promise<void> {
    try {
      // Handle subscribe/unsubscribe as special commands
      if (cmd.method === "subscribe" && cmd.args[0]) {
        await this.subscribe(cmd.exchange, cmd.args[0] as string);
        if (cmd.replyTo) {
          await this.bus.publish(cmd.replyTo, { success: true, data: null, timestamp: Date.now() }, 1);
        }
        return;
      }
      if (cmd.method === "unsubscribe" && cmd.args[0]) {
        await this.unsubscribe(cmd.exchange, cmd.args[0] as string);
        if (cmd.replyTo) {
          await this.bus.publish(cmd.replyTo, { success: true, data: null, timestamp: Date.now() }, 1);
        }
        return;
      }

      const exchange = this.manager.getExchange(cmd.exchange);
      const method = exchange[cmd.method as keyof typeof exchange];
      if (typeof method !== "function") {
        throw new Error(`Unknown method: ${cmd.method}`);
      }

      const result = await (method as (...args: unknown[]) => Promise<unknown>).apply(
        exchange,
        cmd.args
      );

      if (cmd.replyTo) {
        await this.bus.publish(
          cmd.replyTo,
          { success: true, data: result, timestamp: Date.now() },
          1
        );
      }
    } catch (err) {
      logger.error({ cmd, err }, "REST command failed");
      if (cmd.replyTo) {
        await this.bus.publish(
          cmd.replyTo,
          { success: false, error: String(err), timestamp: Date.now() },
          1
        );
      }
    }
  }
}

// Re-exports
export { RedisBus } from "./bus/redis-bus.ts";
export { CacheLayer } from "./rest/cache-layer.ts";
export { ExchangeManager } from "./exchanges/exchange-manager.ts";
export { StreamKeys, SnapshotKeys, CacheKeys, ConsumerGroups, StreamMaxLen } from "./bus/channels.ts";
export type * from "./types/market-data.types.ts";
