import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import { MdStreamKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "hedge-executor" });

interface OrderResult {
  success: boolean;
  orderId?: string;
  fillPrice?: number;
  filled?: number;
  error?: string;
}

interface Position {
  symbol: string;
  side: string;
  contracts: number;
  contractSize: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  notional: number;
}

/**
 * Executes hedge orders via market-data's REST command pattern.
 * Sends commands to cmd:rest-request and awaits responses.
 */
export class HedgeExecutor {
  constructor(private bus: RedisBus) {}

  /**
   * Place a market order on an exchange.
   */
  async createMarketOrder(
    exchange: string,
    symbol: string,
    side: "buy" | "sell",
    amount: number
  ): Promise<OrderResult> {
    logger.info({ exchange, symbol, side, amount }, "Creating market order");

    const result = await this.restCommand(exchange, "createOrder", [
      symbol,
      "market",
      side,
      amount,
    ]);

    if (!result || !result.success) {
      const error = result?.data ? String(result.data) : "REST command failed";
      logger.error({ exchange, symbol, side, amount, error }, "Order failed");
      return { success: false, error };
    }

    const order = result.data as Record<string, unknown>;
    return {
      success: true,
      orderId: order.id as string,
      fillPrice: order.average as number | undefined,
      filled: order.filled as number | undefined,
    };
  }

  /**
   * Cancel all open orders on an exchange.
   */
  async cancelAllOrders(exchange: string, symbol?: string): Promise<{ success: boolean; error?: string }> {
    logger.info({ exchange, symbol }, "Cancelling all orders");

    const result = await this.restCommand(exchange, "cancelAllOrders", symbol ? [symbol] : []);

    if (!result || !result.success) {
      return { success: false, error: String(result?.data ?? "Cancel failed") };
    }
    return { success: true };
  }

  /**
   * Fetch all open positions on an exchange.
   */
  async fetchPositions(exchange: string): Promise<Position[]> {
    const result = await this.restCommand(exchange, "fetchPositions", []);
    if (!result || !result.success) return [];

    const positions = result.data as Position[];
    return positions.filter((p) => p.contracts !== 0);
  }

  /**
   * Fetch balance for an exchange.
   */
  async fetchBalance(exchange: string): Promise<Record<string, unknown> | null> {
    const result = await this.restCommand(exchange, "fetchBalance", []);
    if (!result || !result.success) return null;
    return result.data as Record<string, unknown>;
  }

  /**
   * Close a specific position with a market order.
   */
  async closePosition(
    exchange: string,
    symbol: string,
    side: string,
    contracts: number
  ): Promise<OrderResult> {
    // To close: sell if long, buy if short
    const orderSide = side === "long" || side === "buy" ? "sell" : "buy";
    return this.createMarketOrder(exchange, symbol, orderSide as "buy" | "sell", Math.abs(contracts));
  }

  // ─── Private ──────────────────────────────────────────────────

  private async restCommand(
    exchange: string,
    method: string,
    args: unknown[]
  ): Promise<{ success: boolean; data: unknown } | null> {
    const reqId = randomUUID();
    const replyTo = MdStreamKeys.restResponse(reqId);

    await this.bus.publish(MdStreamKeys.restRequest, { method, exchange, args, replyTo }, 1000);

    const timeoutMs = 15_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const messages = await this.bus.readLatest(replyTo, 1);
      if (messages.length > 0) {
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
