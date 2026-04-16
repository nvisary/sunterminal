import { setTimeout as sleep } from "node:timers/promises";
import type { ProExchange } from "../types/market-data.types.ts";
import type { RedisBus } from "../bus/redis-bus.ts";
import { StreamKeys, SnapshotKeys, StreamMaxLen } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "price-feed" });

/**
 * Watches trades via CCXT Pro watchTrades() and publishes to Redis Streams.
 * Runs in an infinite loop — call via AbortController to stop.
 */
export async function runPriceFeedLoop(
  exchange: ProExchange,
  symbol: string,
  bus: RedisBus,
  signal: AbortSignal
): Promise<void> {
  const exchangeId = exchange.id;
  const streamKey = StreamKeys.trades(exchangeId, symbol);
  const snapshotKey = SnapshotKeys.ticker(exchangeId, symbol);

  logger.info({ exchangeId, symbol }, "Starting price feed");

  while (!signal.aborted) {
    try {
      const trades = await exchange.watchTrades(symbol);

      for (const trade of trades) {
        await bus.publish(
          streamKey,
          {
            exchange: exchangeId,
            symbol: trade.symbol,
            id: trade.id,
            side: trade.side,
            price: trade.price,
            amount: trade.amount,
            cost: trade.cost,
            timestamp: trade.timestamp,
          },
          StreamMaxLen.trades
        );
      }

      // Update last price snapshot (from the most recent trade)
      const lastTrade = trades[trades.length - 1];
      if (lastTrade) {
        await bus.setSnapshot(snapshotKey, {
          exchange: exchangeId,
          symbol: lastTrade.symbol,
          price: lastTrade.price,
          side: lastTrade.side,
          amount: lastTrade.amount,
          timestamp: lastTrade.timestamp,
        });
      }
    } catch (err: unknown) {
      if (signal.aborted) break;
      const name = (err as { name?: string })?.name;
      if (name === "BadSymbol") {
        logger.error({ exchangeId, symbol }, "Invalid symbol, stopping price feed");
        break;
      }
      logger.error({ exchangeId, symbol, err }, "Price feed error, retrying...");
      await sleep(1000);
    }
  }

  logger.info({ exchangeId, symbol }, "Price feed stopped");
}
