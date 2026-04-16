import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import { MdStreamKeys, RISK_CONSUMER_GROUP } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "account-poller" });

interface Balance {
  total: Record<string, number>;
  free: Record<string, number>;
  used: Record<string, number>;
}

interface Position {
  symbol: string;
  side: string;
  contracts: number;
  contractSize: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  notional: number;
}

export interface AccountSnapshot {
  balances: Map<string, Balance>;
  positions: Map<string, Position[]>;
}

export type AccountUpdateHandler = (snapshot: AccountSnapshot) => void;

/**
 * Periodically polls exchange balances and positions via market-data's REST command pattern.
 * Sends commands to cmd:rest-request, reads responses from temporary reply streams.
 */
export class AccountPoller {
  private bus: RedisBus;
  private exchanges: string[];
  private intervalMs: number;
  private handlers: AccountUpdateHandler[] = [];
  private abortController: AbortController | null = null;

  constructor(bus: RedisBus, exchanges: string[], intervalMs: number) {
    this.bus = bus;
    this.exchanges = exchanges;
    this.intervalMs = intervalMs;
  }

  onUpdate(handler: AccountUpdateHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    (async () => {
      // Initial poll
      await this.poll();

      while (!signal.aborted) {
        await sleep(this.intervalMs);
        if (signal.aborted) break;
        await this.poll();
      }
    })().catch((err) => logger.error({ err }, "Account poller loop crashed"));

    logger.info({ exchanges: this.exchanges, intervalMs: this.intervalMs }, "Account poller started");
  }

  stop(): void {
    this.abortController?.abort();
    logger.info("Account poller stopped");
  }

  private async poll(): Promise<void> {
    const balances = new Map<string, Balance>();
    const positions = new Map<string, Position[]>();

    for (const exchange of this.exchanges) {
      try {
        const [bal, pos] = await Promise.all([
          this.restCommand(exchange, "fetchBalance", []),
          this.restCommand(exchange, "fetchPositions", []),
        ]);

        if (bal?.success) {
          balances.set(exchange, bal.data as Balance);
        }
        if (pos?.success) {
          const rawPositions = pos.data as Position[];
          // Filter to open positions only
          const open = rawPositions.filter((p) => p.contracts !== 0);
          positions.set(exchange, open);
        }
      } catch (err) {
        logger.error({ exchange, err }, "Failed to poll account data");
      }
    }

    const snapshot: AccountSnapshot = { balances, positions };

    for (const handler of this.handlers) {
      try {
        handler(snapshot);
      } catch (err) {
        logger.error({ err }, "Account update handler error");
      }
    }
  }

  private async restCommand(
    exchange: string,
    method: string,
    args: unknown[]
  ): Promise<{ success: boolean; data: unknown } | null> {
    const reqId = randomUUID();
    const replyTo = MdStreamKeys.restResponse(reqId);

    // Send command
    await this.bus.publish(
      MdStreamKeys.restRequest,
      { method, exchange, args, replyTo },
      1000
    );

    // Wait for response (poll with timeout)
    const timeoutMs = 10_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const messages = await this.bus.readLatest(replyTo, 1);
      if (messages.length > 0) {
        // Cleanup the temporary stream
        await this.bus.client.del(replyTo);
        return messages[0]!.data as { success: boolean; data: unknown };
      }
      await sleep(200);
    }

    logger.warn({ exchange, method, reqId }, "REST command timed out");
    await this.bus.client.del(replyTo);
    return null;
  }
}
