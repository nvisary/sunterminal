import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { RedisBus } from "../../bus/redis-bus.ts";
import type { OrderRequest, OrderState } from "../../types/trade.types.ts";
import { MdStreamKeys, MdSnapshotKeys } from "../../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "market-strategy" });

export class MarketStrategy {
  constructor(private bus: RedisBus) {}

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

    // Get expected price for slippage calculation
    const ticker = await this.bus.getSnapshot<{ price: number }>(
      MdSnapshotKeys.ticker(request.exchange, request.symbol)
    );
    const expectedPrice = request.price ?? ticker?.price ?? 0;

    // Execute market order via REST command
    const result = await this.restCommand(request.exchange, "createOrder", [
      request.symbol,
      "market",
      request.side,
      request.amount,
    ]);

    if (!result || !result.success) {
      state.status = "error";
      state.updatedAt = Date.now();
      logger.error({ exchange: request.exchange, error: result?.data }, "Market order failed");
      return state;
    }

    const order = result.data as Record<string, unknown>;
    state.exchangeOrderIds = [order.id as string];
    state.filledAmount = (order.filled as number) ?? request.amount;
    state.averagePrice = (order.average as number) ?? expectedPrice;
    state.fees = (order.fee as Record<string, number>)?.cost ?? 0;
    state.status = "filled";
    state.updatedAt = Date.now();

    // Calculate slippage
    if (expectedPrice > 0 && state.averagePrice > 0) {
      state.slippage = ((state.averagePrice - expectedPrice) / expectedPrice) * 100;
      if (request.side === "sell") state.slippage = -state.slippage;
    }

    // Place SL/TP orders if specified
    if (request.stopLoss) {
      await this.placeSLTP(request.exchange, request.symbol, request.side, request.amount, request.stopLoss, "stop");
    }
    if (request.takeProfit) {
      await this.placeSLTP(request.exchange, request.symbol, request.side, request.amount, request.takeProfit, "take_profit");
    }

    logger.info({
      exchange: request.exchange,
      symbol: request.symbol,
      side: request.side,
      filled: state.filledAmount,
      avgPrice: state.averagePrice,
      slippage: state.slippage.toFixed(3),
    }, "Market order filled");

    return state;
  }

  private async placeSLTP(
    exchange: string,
    symbol: string,
    entrySide: "buy" | "sell",
    amount: number,
    price: number,
    type: "stop" | "take_profit"
  ): Promise<void> {
    const closeSide = entrySide === "buy" ? "sell" : "buy";
    const orderType = type === "stop" ? "stopMarket" : "takeProfitMarket";

    const result = await this.restCommand(exchange, "createOrder", [
      symbol,
      orderType,
      closeSide,
      amount,
      price,
      { reduceOnly: true },
    ]);

    if (!result?.success) {
      logger.warn({ exchange, symbol, type, price }, "Failed to place SL/TP order");
    }
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
