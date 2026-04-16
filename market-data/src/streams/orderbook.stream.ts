import { setTimeout as sleep } from "node:timers/promises";
import type { ProExchange } from "../types/market-data.types.ts";
import type { RedisBus } from "../bus/redis-bus.ts";
import { StreamKeys, SnapshotKeys, StreamMaxLen } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "orderbook" });

/**
 * Watches orderbook via CCXT Pro watchOrderBook() and publishes to Redis Streams.
 */
export async function runOrderBookLoop(
  exchange: ProExchange,
  symbol: string,
  depth: number,
  bus: RedisBus,
  signal: AbortSignal
): Promise<void> {
  const exchangeId = exchange.id;
  const streamKey = StreamKeys.orderbook(exchangeId, symbol);
  const snapshotKey = SnapshotKeys.orderbook(exchangeId, symbol);

  logger.info({ exchangeId, symbol, depth }, "Starting orderbook stream");

  while (!signal.aborted) {
    try {
      const ob = await exchange.watchOrderBook(symbol, depth);

      await bus.publish(
        streamKey,
        {
          exchange: exchangeId,
          symbol: ob.symbol,
          bids: ob.bids,
          asks: ob.asks,
          timestamp: ob.timestamp,
          nonce: ob.nonce,
        },
        StreamMaxLen.orderbook
      );

      await bus.setSnapshot(snapshotKey, ob);
    } catch (err: unknown) {
      if (signal.aborted) break;
      const name = (err as { name?: string })?.name;
      if (name === "BadSymbol") {
        logger.error({ exchangeId, symbol }, "Invalid symbol, stopping orderbook");
        break;
      }
      logger.error({ exchangeId, symbol, err }, "Orderbook error, retrying...");
      await sleep(1000);
    }
  }

  logger.info({ exchangeId, symbol }, "Orderbook stream stopped");
}
