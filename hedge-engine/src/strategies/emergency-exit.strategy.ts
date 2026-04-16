import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { HedgeExecutor } from "../execution/hedge-executor.ts";
import type { HedgeStateManager } from "../state/hedge-state.ts";
import type { ActionLog } from "../state/action-log.ts";
import type { OrderTracker } from "../execution/order-tracker.ts";
import type { ExitResult, HedgeConfig } from "../types/hedge.types.ts";
import pino from "pino";

const logger = pino({ name: "emergency-exit" });

/**
 * Emergency Exit — the Kill Switch.
 * Closes ALL positions on ALL exchanges with market orders.
 * Works ALWAYS, even in Advisor mode.
 */
export class EmergencyExitStrategy {
  private executor: HedgeExecutor;
  private stateManager: HedgeStateManager;
  private actionLog: ActionLog;
  private tracker: OrderTracker;
  private exchanges: string[];
  private cfg: HedgeConfig["emergencyExit"];
  private isRunning = false;

  constructor(
    executor: HedgeExecutor,
    stateManager: HedgeStateManager,
    actionLog: ActionLog,
    tracker: OrderTracker,
    exchanges: string[],
    cfg: HedgeConfig["emergencyExit"]
  ) {
    this.executor = executor;
    this.stateManager = stateManager;
    this.actionLog = actionLog;
    this.tracker = tracker;
    this.exchanges = exchanges;
    this.cfg = cfg;
  }

  /**
   * Execute emergency exit. Can be called manually or automatically.
   */
  async execute(reason: string): Promise<ExitResult> {
    if (this.isRunning) {
      logger.warn("Emergency exit already in progress");
      return { success: false, closedPositions: 0, cancelledOrders: 0, failedPositions: [], timestamp: Date.now() };
    }

    this.isRunning = true;
    logger.warn({ reason }, "EMERGENCY EXIT TRIGGERED");

    // Set state to EMERGENCY immediately
    this.stateManager.setStatus("emergency");
    await this.stateManager.publish();

    let closedPositions = 0;
    let cancelledOrders = 0;
    const failedPositions: Array<{ exchange: string; symbol: string; error: string }> = [];

    try {
      // Step 1: Cancel all open orders on all exchanges (parallel)
      const cancelResults = await Promise.allSettled(
        this.exchanges.map(async (ex) => {
          const result = await this.executor.cancelAllOrders(ex);
          if (result.success) cancelledOrders++;
          return result;
        })
      );

      logger.info({ cancelledOrders }, "Orders cancelled");

      // Step 2: Close all positions with market orders (with retries)
      for (let attempt = 1; attempt <= this.cfg.retryAttempts; attempt++) {
        const allPositions: Array<{ exchange: string; position: Record<string, unknown> }> = [];

        for (const exchange of this.exchanges) {
          const positions = await this.executor.fetchPositions(exchange);
          for (const pos of positions) {
            allPositions.push({ exchange, position: pos as unknown as Record<string, unknown> });
          }
        }

        if (allPositions.length === 0) {
          logger.info("No open positions to close");
          break;
        }

        logger.info({ attempt, positions: allPositions.length }, "Closing positions");

        const closeResults = await Promise.allSettled(
          allPositions.map(async ({ exchange, position }) => {
            const pos = position as { symbol: string; side: string; contracts: number };
            const result = await this.executor.closePosition(
              exchange,
              pos.symbol,
              pos.side,
              pos.contracts
            );

            if (result.success) {
              closedPositions++;
              this.actionLog.add({
                id: randomUUID(),
                type: "emergency_exit",
                strategy: "emergency",
                mode: "executed",
                details: {
                  exchange,
                  symbol: pos.symbol,
                  side: pos.side === "long" ? "sell" : "buy",
                  amount: Math.abs(pos.contracts),
                  orderId: result.orderId,
                  fillPrice: result.fillPrice,
                },
                reason,
                timestamp: Date.now(),
              });
            } else {
              failedPositions.push({ exchange, symbol: pos.symbol, error: result.error ?? "Unknown" });
            }

            return result;
          })
        );

        // Check if any failed positions remain
        const remainingFailed = failedPositions.filter(
          (fp) => !closeResults.some((r) => r.status === "fulfilled")
        );

        if (remainingFailed.length === 0 || attempt === this.cfg.retryAttempts) break;

        logger.warn({ attempt, remaining: remainingFailed.length }, "Retrying failed positions");
        await sleep(this.cfg.retryDelay);
      }
    } catch (err) {
      logger.fatal({ err, reason }, "Emergency exit encountered critical error");
    } finally {
      this.isRunning = false;
    }

    // Clear tracked hedges
    this.tracker.clear();

    // Set state to LOCKED — new trades blocked, manual unlock required
    this.stateManager.setStatus("locked");
    await this.stateManager.publish();

    const result: ExitResult = {
      success: failedPositions.length === 0,
      closedPositions,
      cancelledOrders,
      failedPositions,
      timestamp: Date.now(),
    };

    if (failedPositions.length > 0) {
      logger.fatal({ failedPositions }, "EMERGENCY EXIT INCOMPLETE — manual intervention required");
    } else {
      logger.warn({ closedPositions, cancelledOrders }, "Emergency exit complete, system LOCKED");
    }

    return result;
  }

  /**
   * Check if a risk signal should trigger emergency exit.
   */
  shouldTrigger(signalType: string): boolean {
    if (!this.cfg.autoTriggerEnabled) return false;

    switch (signalType) {
      case "DD_CRITICAL":
        return this.cfg.triggers.ddCritical;
      case "DD_MAX_PEAK":
        return this.cfg.triggers.ddMaxPeak;
      default:
        return false;
    }
  }
}
