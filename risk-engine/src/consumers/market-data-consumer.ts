import { setTimeout as sleep } from "node:timers/promises";
import type { RedisBus } from "../bus/redis-bus.ts";
import { MdStreamKeys, RISK_CONSUMER_GROUP, riskConsumerName } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "md-consumer" });

export type TradeHandler = (exchange: string, symbol: string, data: Record<string, unknown>) => void;
export type OrderbookHandler = (exchange: string, symbol: string, data: Record<string, unknown>) => void;
export type FundingHandler = (exchange: string, symbol: string, data: Record<string, unknown>) => void;

/**
 * Subscribes to market-data Redis Streams and dispatches to handlers.
 * Runs one read loop per stream (trades, orderbook, funding per exchange:symbol).
 */
export class MarketDataConsumer {
  private bus: RedisBus;
  private controllers: AbortController[] = [];
  private tradeHandlers: TradeHandler[] = [];
  private orderbookHandlers: OrderbookHandler[] = [];
  private fundingHandlers: FundingHandler[] = [];

  constructor(bus: RedisBus) {
    this.bus = bus;
  }

  onTrade(handler: TradeHandler): void {
    this.tradeHandlers.push(handler);
  }

  onOrderbook(handler: OrderbookHandler): void {
    this.orderbookHandlers.push(handler);
  }

  onFunding(handler: FundingHandler): void {
    this.fundingHandlers.push(handler);
  }

  async start(exchanges: string[], symbols: string[]): Promise<void> {
    const consumerName = riskConsumerName();

    for (const exchange of exchanges) {
      for (const symbol of symbols) {
        // Trades stream
        const tradesKey = MdStreamKeys.trades(exchange, symbol);
        await this.bus.ensureConsumerGroup(tradesKey, RISK_CONSUMER_GROUP);
        this.startReadLoop(tradesKey, consumerName, exchange, symbol, this.tradeHandlers);

        // Orderbook stream
        const obKey = MdStreamKeys.orderbook(exchange, symbol);
        await this.bus.ensureConsumerGroup(obKey, RISK_CONSUMER_GROUP);
        this.startReadLoop(obKey, consumerName, exchange, symbol, this.orderbookHandlers);

        // Funding stream
        const fundingKey = MdStreamKeys.funding(exchange, symbol);
        await this.bus.ensureConsumerGroup(fundingKey, RISK_CONSUMER_GROUP);
        this.startReadLoop(fundingKey, consumerName, exchange, symbol, this.fundingHandlers);
      }
    }

    logger.info(
      { exchanges, symbols, streams: exchanges.length * symbols.length * 3 },
      "Market data consumer started"
    );
  }

  private startReadLoop(
    streamKey: string,
    consumerName: string,
    exchange: string,
    symbol: string,
    handlers: Array<(exchange: string, symbol: string, data: Record<string, unknown>) => void>
  ): void {
    const ctrl = new AbortController();
    this.controllers.push(ctrl);
    const signal = ctrl.signal;

    (async () => {
      while (!signal.aborted) {
        try {
          const messages = await this.bus.readGroup(
            RISK_CONSUMER_GROUP,
            consumerName,
            streamKey,
            50,
            2000
          );

          for (const msg of messages) {
            for (const handler of handlers) {
              try {
                handler(exchange, symbol, msg.data);
              } catch (err) {
                logger.error({ streamKey, err }, "Handler error");
              }
            }
            await this.bus.ack(streamKey, RISK_CONSUMER_GROUP, msg.id);
          }
        } catch (err) {
          if (signal.aborted) break;
          logger.error({ streamKey, err }, "Read loop error, retrying...");
          await sleep(1000);
        }
      }
    })().catch((err) => logger.error({ streamKey, err }, "Read loop crashed"));
  }

  stop(): void {
    for (const ctrl of this.controllers) {
      ctrl.abort();
    }
    this.controllers = [];
    logger.info("Market data consumer stopped");
  }
}
