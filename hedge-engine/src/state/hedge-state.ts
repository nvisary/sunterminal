import type { RedisBus } from "../bus/redis-bus.ts";
import type { HedgeState, HedgeConfig, HedgeStatus } from "../types/hedge.types.ts";
import type { OrderTracker } from "../execution/order-tracker.ts";
import { HedgeStreamKeys, HedgeStreamMaxLen, HedgeSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "hedge-state" });

/**
 * Manages and publishes HedgeState to Redis on every change.
 */
export class HedgeStateManager {
  private bus: RedisBus;
  private tracker: OrderTracker;
  private status: HedgeStatus = "idle";
  private config: HedgeConfig;

  constructor(bus: RedisBus, tracker: OrderTracker, config: HedgeConfig) {
    this.bus = bus;
    this.tracker = tracker;
    this.config = config;
  }

  setStatus(status: HedgeStatus): void {
    this.status = status;
  }

  getStatus(): HedgeStatus {
    return this.status;
  }

  buildState(): HedgeState {
    const hedges = this.tracker.getActiveHedges();
    const totalHedgeSize = this.tracker.getTotalHedgeSize();

    return {
      mode: this.config.globalMode,
      status: this.status,
      strategies: {
        autoHedge: {
          enabled: this.config.autoHedge.enabled,
          mode: this.config.autoHedge.mode,
          activeHedges: hedges,
          totalHedgeSize,
          dailyFundingCost: 0, // Updated by auto-hedge strategy
          lastCheck: Date.now(),
        },
        deltaNeutral: {
          enabled: this.config.deltaNeutral.enabled,
          mode: this.config.deltaNeutral.mode,
          currentDelta: 0,
          targetDelta: this.config.deltaNeutral.targetDelta,
          lastRebalance: 0,
        },
        emergencyExit: {
          enabled: this.config.emergencyExit.autoTriggerEnabled,
          manualButtonActive: true,
          lastTriggered: null,
        },
      },
      timestamp: Date.now(),
    };
  }

  async publish(): Promise<void> {
    const state = this.buildState();
    await this.bus.publish(
      HedgeStreamKeys.state,
      state as unknown as Record<string, unknown>,
      HedgeStreamMaxLen.state
    );
    await this.bus.setSnapshot(HedgeSnapshotKeys.state, state);
  }

  async publishAction(action: Record<string, unknown>): Promise<void> {
    await this.bus.publish(HedgeStreamKeys.actions, action, HedgeStreamMaxLen.actions);
  }

  async publishRecommendation(rec: Record<string, unknown>): Promise<void> {
    await this.bus.publish(HedgeStreamKeys.recommendations, rec, HedgeStreamMaxLen.recommendations);
  }
}
