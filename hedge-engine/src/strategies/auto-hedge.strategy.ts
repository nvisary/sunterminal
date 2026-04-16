import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import type { HedgeExecutor } from "../execution/hedge-executor.ts";
import type { HedgeStateManager } from "../state/hedge-state.ts";
import type { ActionLog } from "../state/action-log.ts";
import type { OrderTracker } from "../execution/order-tracker.ts";
import type { HedgeConfig, HedgePosition, HedgeAction } from "../types/hedge.types.ts";
import { RiskSnapshotKeys, MdSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "auto-hedge" });

interface ExposureSnapshot {
  netExposure: number;
  grossExposure: number;
  equity: number;
  byAsset: Record<string, { long: number; short: number; net: number }>;
}

interface FundingData {
  exchange: string;
  symbol: string;
  rate: number;
  interval: number;
}

/**
 * Auto-Hedge Strategy.
 * Opens opposite futures positions when exposure exceeds threshold.
 * Works in advisor (recommend) or controller (execute) mode.
 */
export class AutoHedgeStrategy {
  private bus: RedisBus;
  private executor: HedgeExecutor;
  private stateManager: HedgeStateManager;
  private actionLog: ActionLog;
  private tracker: OrderTracker;
  private cfg: HedgeConfig["autoHedge"];
  private exchanges: string[];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    bus: RedisBus,
    executor: HedgeExecutor,
    stateManager: HedgeStateManager,
    actionLog: ActionLog,
    tracker: OrderTracker,
    cfg: HedgeConfig["autoHedge"],
    exchanges: string[]
  ) {
    this.bus = bus;
    this.executor = executor;
    this.stateManager = stateManager;
    this.actionLog = actionLog;
    this.tracker = tracker;
    this.cfg = cfg;
    this.exchanges = exchanges;
  }

  start(): void {
    if (!this.cfg.enabled) {
      logger.info("Auto-hedge disabled");
      return;
    }

    this.timer = setInterval(() => this.check(), this.cfg.checkInterval);
    logger.info(
      { mode: this.cfg.mode, threshold: this.cfg.hedgeThreshold, ratio: this.cfg.hedgeRatio, interval: this.cfg.checkInterval },
      "Auto-hedge started"
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    logger.info("Auto-hedge stopped");
  }

  /**
   * Can also be triggered by exposure signal from risk engine.
   */
  async onExposureSignal(): Promise<void> {
    await this.check();
  }

  private async check(): Promise<void> {
    try {
      const exposure = await this.bus.getSnapshot<ExposureSnapshot>(RiskSnapshotKeys.exposure);
      if (!exposure) return;

      const net = exposure.netExposure;
      const absNet = Math.abs(net);

      // Should we open a hedge?
      if (absNet > this.cfg.hedgeThreshold) {
        const existingHedgeSize = this.tracker.getTotalHedgeSize();
        const targetHedgeSize = absNet * this.cfg.hedgeRatio;
        const neededSize = targetHedgeSize - existingHedgeSize;

        if (neededSize > 1) { // $1 minimum
          const cappedSize = Math.min(neededSize, this.cfg.maxHedgeSize);
          const hedgeSide: "long" | "short" = net > 0 ? "short" : "long";

          // Find best exchange
          const bestExchange = await this.selectExchange(hedgeSide, Object.keys(exposure.byAsset)[0] ?? "BTC");

          // Determine symbol — use the dominant asset
          const dominantAsset = this.findDominantAsset(exposure.byAsset);
          const symbol = `${dominantAsset}/USDT:USDT`;

          // Get current price for amount calculation
          const ticker = await this.bus.getSnapshot<{ price: number }>(
            MdSnapshotKeys.ticker(bestExchange, symbol)
          );
          const price = ticker?.price ?? 0;
          if (price <= 0) {
            logger.warn({ exchange: bestExchange, symbol }, "No price data, skipping hedge");
            return;
          }

          const amount = cappedSize / price;

          // Estimate cost
          const costInfo = await this.estimateCost(bestExchange, symbol, cappedSize);

          const action: HedgeAction = {
            id: randomUUID(),
            type: "open_hedge",
            strategy: "auto_hedge",
            mode: this.cfg.mode === "controller" ? "executed" : "recommended",
            details: {
              exchange: bestExchange,
              symbol,
              side: hedgeSide === "short" ? "sell" : "buy",
              amount,
            },
            reason: `Net exposure $${absNet.toFixed(0)} > threshold $${this.cfg.hedgeThreshold}`,
            timestamp: Date.now(),
          };

          if (this.cfg.mode === "controller") {
            // Execute
            const result = await this.executor.createMarketOrder(
              bestExchange,
              symbol,
              hedgeSide === "short" ? "sell" : "buy",
              amount
            );

            if (result.success) {
              action.details.orderId = result.orderId;
              action.details.fillPrice = result.fillPrice;

              const hedge: HedgePosition = {
                id: randomUUID(),
                exchange: bestExchange,
                symbol,
                side: hedgeSide,
                size: cappedSize,
                entryPrice: result.fillPrice ?? price,
                currentPrice: price,
                unrealizedPnl: 0,
                fundingPaid: 0,
                openedAt: Date.now(),
                reason: action.reason,
              };
              this.tracker.addHedge(hedge);
              this.stateManager.setStatus("active");
            } else {
              logger.error({ exchange: bestExchange, error: result.error }, "Hedge order failed");
            }
          } else {
            // Advisor mode: publish recommendation
            await this.stateManager.publishRecommendation(action as unknown as Record<string, unknown>);
            logger.info({ exchange: bestExchange, symbol, size: cappedSize, side: hedgeSide }, "Hedge recommended");
          }

          this.actionLog.add(action);
          await this.stateManager.publishAction(action as unknown as Record<string, unknown>);
          await this.stateManager.publish();
        }
      }

      // Should we close hedges? (exposure below unhedge threshold)
      if (absNet < this.cfg.unhedgeThreshold && this.tracker.getTotalHedgeSize() > 0) {
        await this.closeAllHedges(`Net exposure $${absNet.toFixed(0)} < unhedge threshold $${this.cfg.unhedgeThreshold}`);
      }
    } catch (err) {
      logger.error({ err }, "Auto-hedge check failed");
    }
  }

  private async closeAllHedges(reason: string): Promise<void> {
    const hedges = this.tracker.getActiveHedges();

    for (const hedge of hedges) {
      const action: HedgeAction = {
        id: randomUUID(),
        type: "close_hedge",
        strategy: "auto_hedge",
        mode: this.cfg.mode === "controller" ? "executed" : "recommended",
        details: {
          exchange: hedge.exchange,
          symbol: hedge.symbol,
          side: hedge.side === "long" ? "sell" : "buy",
          amount: hedge.size / hedge.entryPrice,
        },
        reason,
        timestamp: Date.now(),
      };

      if (this.cfg.mode === "controller") {
        const result = await this.executor.closePosition(
          hedge.exchange,
          hedge.symbol,
          hedge.side,
          hedge.size / hedge.entryPrice
        );

        if (result.success) {
          action.details.orderId = result.orderId;
          action.details.fillPrice = result.fillPrice;
          this.tracker.removeHedge(hedge.id);
        }
      } else {
        await this.stateManager.publishRecommendation(action as unknown as Record<string, unknown>);
      }

      this.actionLog.add(action);
      await this.stateManager.publishAction(action as unknown as Record<string, unknown>);
    }

    if (this.tracker.getActiveHedges().length === 0) {
      this.stateManager.setStatus("idle");
    }
    await this.stateManager.publish();
  }

  private async selectExchange(hedgeSide: "long" | "short", asset: string): Promise<string> {
    if (this.cfg.hedgeExchange !== "auto") {
      return this.cfg.hedgeExchange;
    }

    // Compare funding rates: pick exchange that pays us
    let bestExchange = this.exchanges[0]!;
    let bestScore = -Infinity;
    const symbol = `${asset}/USDT:USDT`;

    for (const exchange of this.exchanges) {
      const funding = await this.bus.getSnapshot<FundingData>(
        MdSnapshotKeys.funding(exchange, symbol)
      );
      if (!funding) continue;

      // Short hedge: want positive funding (shorts get paid)
      // Long hedge: want negative funding (longs get paid)
      const score = hedgeSide === "short" ? funding.rate : -funding.rate;

      if (score > bestScore) {
        bestScore = score;
        bestExchange = exchange;
      }
    }

    return bestExchange;
  }

  private findDominantAsset(byAsset: Record<string, { long: number; short: number; net: number }>): string {
    let maxNet = 0;
    let dominant = "BTC";

    for (const [asset, data] of Object.entries(byAsset)) {
      if (Math.abs(data.net) > maxNet) {
        maxNet = Math.abs(data.net);
        dominant = asset;
      }
    }

    return dominant;
  }

  private async estimateCost(
    exchange: string,
    symbol: string,
    size: number
  ): Promise<{ dailyCost: number; costPercent: number }> {
    const funding = await this.bus.getSnapshot<FundingData>(
      MdSnapshotKeys.funding(exchange, symbol)
    );

    if (!funding) return { dailyCost: 0, costPercent: 0 };

    const dailyCost = size * Math.abs(funding.rate) * (24 / funding.interval);
    const exposure = await this.bus.getSnapshot<ExposureSnapshot>(RiskSnapshotKeys.exposure);
    const equity = exposure?.equity ?? 1;
    const costPercent = (dailyCost / equity) * 100;

    if (costPercent > this.cfg.maxCostPercent) {
      logger.warn({ dailyCost, costPercent, maxCostPercent: this.cfg.maxCostPercent }, "Hedge cost exceeds limit");
    }

    return { dailyCost, costPercent };
  }
}
