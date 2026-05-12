import type { RedisBus } from "../bus/redis-bus.ts";
import type { TradeConfig } from "../types/trade.types.ts";
import type { SimFillResult } from "../types/sim.types.ts";
import { MdSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "sim-matching-engine" });

interface OrderbookSnapshot {
  bids: Array<[number, number]>; // [price, amount]
  asks: Array<[number, number]>;
  timestamp?: number;
}

interface TickerSnapshot {
  price?: number;
  last?: number;
}

/**
 * Pure-ish matching engine for paper trading.
 * Reads market-data snapshots only (no I/O outside of Redis GET).
 */
export class SimMatchingEngine {
  constructor(private bus: RedisBus, private cfg: TradeConfig["sim"]) {}

  /**
   * Simulate a market order by walking the orderbook.
   * - buy → consumes asks (cheapest first)
   * - sell → consumes bids (most expensive first)
   * Returns VWAP, slippage vs best, and taker fee.
   */
  async executeMarket(params: {
    exchange: string;
    symbol: string;
    side: "buy" | "sell";
    amount: number; // base units
  }): Promise<SimFillResult> {
    const { exchange, symbol, side, amount } = params;

    const ob = await this.bus.getSnapshot<OrderbookSnapshot>(MdSnapshotKeys.orderbook(exchange, symbol));
    const ticker = await this.bus.getSnapshot<TickerSnapshot>(MdSnapshotKeys.ticker(exchange, symbol));
    const lastPrice = ticker?.price ?? ticker?.last ?? 0;

    if (!ob || !ob.bids || !ob.asks || ob.bids.length === 0 || ob.asks.length === 0) {
      // Fallback path: no orderbook → use last price + configured fallback slippage
      if (lastPrice <= 0) {
        return {
          filled: false,
          filledAmount: 0,
          averagePrice: 0,
          slippagePct: 0,
          fees: 0,
          reason: "No market data (orderbook & ticker empty)",
        };
      }
      const slipPct = this.cfg.slippageFallbackPct;
      const direction = side === "buy" ? 1 : -1;
      const fillPrice = lastPrice * (1 + (direction * slipPct) / 100);
      const notional = fillPrice * amount;
      const fees = (notional * this.cfg.takerFeePct) / 100;
      logger.warn({ exchange, symbol }, "Sim market fallback (no orderbook)");
      return {
        filled: true,
        filledAmount: amount,
        averagePrice: fillPrice,
        slippagePct: slipPct * direction,
        fees,
        reason: "fallback:ticker",
      };
    }

    const levels = side === "buy" ? ob.asks : ob.bids;
    const bestPrice = levels[0]![0];

    let remaining = amount;
    let cost = 0;
    let filled = 0;

    for (const [price, levelSize] of levels) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, levelSize);
      cost += take * price;
      filled += take;
      remaining -= take;
    }

    if (filled <= 0) {
      return {
        filled: false,
        filledAmount: 0,
        averagePrice: 0,
        slippagePct: 0,
        fees: 0,
        reason: "Empty orderbook side",
      };
    }

    if (remaining > 0) {
      // Not enough depth → fill what we can but warn
      logger.warn({ exchange, symbol, requested: amount, filled }, "Sim market: insufficient depth");
    }

    const vwap = cost / filled;
    const slippagePct = ((vwap - bestPrice) / bestPrice) * 100 * (side === "buy" ? 1 : -1);
    const fees = (cost * this.cfg.takerFeePct) / 100;

    return {
      filled: true,
      filledAmount: filled,
      averagePrice: vwap,
      slippagePct,
      fees,
    };
  }

  /**
   * Classify how a single trade tick interacts with a resting limit order.
   * - "cross": price moved strictly past the limit → fill now regardless of queue.
   * - "touch": trade printed at the limit AND was on the opposite (aggressor)
   *           side → counts toward consuming the queue ahead of us.
   * - "none": trade doesn't interact (wrong side, or didn't reach the price).
   */
  classifyTradeForLimit(params: {
    side: "buy" | "sell";
    limitPrice: number;
    tradePrice: number;
    tradeSide?: "buy" | "sell";
  }): "cross" | "touch" | "none" {
    const { side, limitPrice, tradePrice, tradeSide } = params;
    // Price-relative epsilon so FP wobble on a $80,770 tick doesn't mis-classify
    // a touch as a cross or vice versa.
    const eps = Math.max(limitPrice * 1e-8, 1e-9);
    const dp = tradePrice - limitPrice;
    if (side === "buy") {
      if (dp < -eps) return "cross";
      if (Math.abs(dp) <= eps && tradeSide === "sell") return "touch";
      return "none";
    }
    if (dp > eps) return "cross";
    if (Math.abs(dp) <= eps && tradeSide === "buy") return "touch";
    return "none";
  }

  /**
   * Build the maker-side fill for a resting limit order. Caller is responsible
   * for deciding (via classifyTradeForLimit + queue accounting) that the order
   * should fill — this helper just computes price/fees.
   */
  computeLimitFill(limitPrice: number, amount: number): SimFillResult {
    const fees = (limitPrice * amount * this.cfg.makerFeePct) / 100;
    return {
      filled: true,
      filledAmount: amount,
      averagePrice: limitPrice,
      slippagePct: 0,
      fees,
    };
  }
}
