import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { RedisBus } from "../../bus/redis-bus.ts";
import type { OrderRequest, OrderState } from "../../types/trade.types.ts";
import { MdStreamKeys } from "../../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "limit-strategy" });

export class LimitStrategy {
  private timeout: number;

  constructor(private bus: RedisBus, timeoutMs: number) {
    this.timeout = timeoutMs;
  }

  async execute(request: OrderRequest): Promise<OrderState> {
    const orderId = randomUUID();
    const state: OrderState = {
      id: orderId,
      request,
      status: "pending",
      exchangeOrderIds: [],
      filledAmount: 0,
      averagePrice: 0,
      slippage: 0,
      fees: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (!request.price) {
      state.status = "rejected";
      logger.error("Limit order requires a price");
      return state;
    }

    // Place limit order
    const result = await this.restCommand(request.exchange, "createOrder", [
      request.symbol,
      "limit",
      request.side,
      request.amount,
      request.price,
    ]);

    if (!result || !result.success) {
      state.status = "error";
      state.updatedAt = Date.now();
      logger.error({ exchange: request.exchange, error: result?.data }, "Limit order failed");
      return state;
    }

    const order = result.data as Record<string, unknown>;
    const exchangeOrderId = order.id as string;
    state.exchangeOrderIds = [exchangeOrderId];
    state.updatedAt = Date.now();

    // Poll for fill with timeout
    const deadline = Date.now() + this.timeout;

    while (Date.now() < deadline) {
      await sleep(2000);

      const checkResult = await this.restCommand(request.exchange, "fetchOrder", [
        exchangeOrderId,
        request.symbol,
      ]);

      if (!checkResult?.success) continue;

      const updatedOrder = checkResult.data as Record<string, unknown>;
      const status = updatedOrder.status as string;
      state.filledAmount = (updatedOrder.filled as number) ?? 0;
      state.averagePrice = (updatedOrder.average as number) ?? request.price;
      state.fees = (updatedOrder.fee as Record<string, number>)?.cost ?? 0;

      if (status === "closed") {
        state.status = "filled";
        state.updatedAt = Date.now();

        // Slippage for limit orders (should be ≤ 0 since we set the price)
        if (request.price > 0) {
          state.slippage = ((state.averagePrice - request.price) / request.price) * 100;
          if (request.side === "sell") state.slippage = -state.slippage;
        }

        // Place SL/TP
        if (request.stopLoss) {
          await this.placeSLTP(request, request.stopLoss, "stop");
        }
        if (request.takeProfit) {
          await this.placeSLTP(request, request.takeProfit, "take_profit");
        }

        logger.info({ exchange: request.exchange, symbol: request.symbol, avgPrice: state.averagePrice }, "Limit order filled");
        return state;
      }

      if (status === "canceled" || status === "expired" || status === "rejected") {
        state.status = "cancelled";
        state.updatedAt = Date.now();
        return state;
      }

      // Partial fill
      if (state.filledAmount > 0) {
        state.status = "partial";
        state.updatedAt = Date.now();
      }
    }

    // Timeout: cancel unfilled order
    logger.info({ exchangeOrderId, timeout: this.timeout }, "Limit order timed out, cancelling");
    await this.restCommand(request.exchange, "cancelOrder", [exchangeOrderId, request.symbol]);

    state.status = state.filledAmount > 0 ? "partial" : "cancelled";
    state.updatedAt = Date.now();
    return state;
  }

  private async placeSLTP(request: OrderRequest, price: number, type: "stop" | "take_profit"): Promise<void> {
    const closeSide = request.side === "buy" ? "sell" : "buy";
    const orderType = type === "stop" ? "stopMarket" : "takeProfitMarket";

    await this.restCommand(request.exchange, "createOrder", [
      request.symbol, orderType, closeSide, request.amount, price, { reduceOnly: true },
    ]);
  }

  private async restCommand(
    exchange: string,
    method: string,
    args: unknown[]
  ): Promise<{ success: boolean; data: unknown } | null> {
    const reqId = randomUUID();
    const replyTo = MdStreamKeys.restResponse(reqId);
    await this.bus.publish(MdStreamKeys.restRequest, { method, exchange, args, replyTo }, 1000);

    const start = Date.now();
    while (Date.now() - start < 15_000) {
      const msgs = await this.bus.readLatest(replyTo, 1);
      if (msgs.length > 0) {
        await this.bus.client.del(replyTo);
        return msgs[0]!.data as { success: boolean; data: unknown };
      }
      await sleep(200);
    }
    await this.bus.client.del(replyTo);
    return null;
  }
}
