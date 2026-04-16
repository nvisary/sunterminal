import { setTimeout as sleep } from "node:timers/promises";
import type { ProExchange, FundingData } from "../types/market-data.types.ts";
import type { RedisBus } from "../bus/redis-bus.ts";
import { StreamKeys, SnapshotKeys, StreamMaxLen } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "funding" });

/**
 * Watches ticker via CCXT Pro watchTicker() to extract funding rate data.
 * Publishes to Redis Streams + snapshot.
 */
export async function runFundingLoop(
  exchange: ProExchange,
  symbol: string,
  bus: RedisBus,
  signal: AbortSignal
): Promise<void> {
  const exchangeId = exchange.id;
  const streamKey = StreamKeys.funding(exchangeId, symbol);
  const snapshotKey = SnapshotKeys.funding(exchangeId, symbol);

  logger.info({ exchangeId, symbol }, "Starting funding rate stream");

  let lastFundingTime: number | null = null;

  while (!signal.aborted) {
    try {
      const ticker = await exchange.watchTicker(symbol);

      const info = ticker.info as Record<string, string | undefined>;
      const rate = parseFloat(info.fundingRate ?? info.lastFundingRate ?? "0");
      const predictedRate = info.predictedFundingRate
        ? parseFloat(info.predictedFundingRate)
        : null;
      const nextFundingTime = parseInt(info.nextFundingTime ?? info.fundingTimestamp ?? "0", 10);

      // Only publish when funding time changes (avoid flooding)
      if (nextFundingTime === lastFundingTime && lastFundingTime !== null) {
        continue;
      }
      lastFundingTime = nextFundingTime;

      const interval = detectFundingInterval(exchangeId, info);
      const annualizedRate = rate * ((365 * 24) / interval);

      const fundingData: FundingData = {
        exchange: exchangeId,
        symbol,
        rate,
        predictedRate,
        nextFundingTime,
        interval,
        annualizedRate,
        timestamp: ticker.timestamp ?? Date.now(),
      };

      await bus.publish(streamKey, fundingData as unknown as Record<string, unknown>, StreamMaxLen.funding);
      await bus.setSnapshot(snapshotKey, fundingData);

      // Emit signals for extreme values
      if (Math.abs(rate) > 0.0005) {
        const signal_type = rate > 0 ? "FUNDING_EXTREME_HIGH" : "FUNDING_EXTREME_LOW";
        await bus.publish(
          StreamKeys.status,
          { type: signal_type, exchange: exchangeId, symbol, rate, timestamp: Date.now() },
          StreamMaxLen.status
        );
      }
    } catch (err) {
      if (signal.aborted) break;
      logger.error({ exchangeId, symbol, err }, "Funding stream error, retrying...");
      await sleep(5000);
    }
  }

  logger.info({ exchangeId, symbol }, "Funding stream stopped");
}

function detectFundingInterval(
  _exchangeId: string,
  info: Record<string, string | undefined>
): 1 | 4 | 8 {
  const intervalMs = parseInt(info.fundingIntervalHours ?? info.fundingInterval ?? "0", 10);
  if (intervalMs === 1) return 1;
  if (intervalMs === 4) return 4;
  return 8; // default
}
