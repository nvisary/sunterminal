import type { RedisBus } from "../bus/redis-bus.ts";
import type { OrderRequest, OrderState, TradeConfig } from "../types/trade.types.ts";
import { TradeStreamKeys, TradeStreamMaxLen } from "../bus/channels.ts";
import { MarketStrategy } from "./strategies/market.strategy.ts";
import { LimitStrategy } from "./strategies/limit.strategy.ts";
import pino from "pino";

const logger = pino({ name: "order-manager" });

/**
 * Orchestrates order execution, selects strategy, tracks slippage.
 */
export class OrderManager {
  private bus: RedisBus;
  private marketStrategy: MarketStrategy;
  private limitStrategy: LimitStrategy;
  private cfg: TradeConfig["smartOrder"];
  private activeOrders = new Map<string, OrderState>();

  constructor(bus: RedisBus, cfg: TradeConfig["smartOrder"]) {
    this.bus = bus;
    this.cfg = cfg;
    this.marketStrategy = new MarketStrategy(bus);
    this.limitStrategy = new LimitStrategy(bus, cfg.limitTimeout);
  }

  async execute(request: OrderRequest): Promise<OrderState> {
    const strategy = request.strategy ?? this.cfg.defaultStrategy;

    let state: OrderState;

    switch (strategy) {
      case "market":
        state = await this.marketStrategy.execute(request);
        break;
      case "limit":
        state = await this.limitStrategy.execute(request);
        break;
      case "twap":
      case "iceberg":
      case "sniper":
        logger.warn({ strategy }, "Strategy not implemented, falling back to market");
        state = await this.marketStrategy.execute(request);
        break;
      default:
        state = await this.marketStrategy.execute(request);
    }

    // Track
    this.activeOrders.set(state.id, state);

    // Check slippage alert
    if (Math.abs(state.slippage) > this.cfg.maxSlippage && state.status === "filled") {
      logger.warn({
        id: state.id,
        slippage: state.slippage.toFixed(3),
        maxSlippage: this.cfg.maxSlippage,
      }, "Slippage exceeded threshold");
    }

    // Publish order state
    await this.bus.publish(
      TradeStreamKeys.orders,
      state as unknown as Record<string, unknown>,
      TradeStreamMaxLen.orders
    );

    return state;
  }

  getActiveOrders(): OrderState[] {
    return [...this.activeOrders.values()];
  }

  getOrder(id: string): OrderState | undefined {
    return this.activeOrders.get(id);
  }
}
