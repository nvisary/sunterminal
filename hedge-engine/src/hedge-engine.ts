import { setTimeout as sleep } from "node:timers/promises";
import type {
  HedgeConfig,
  HedgeState,
  HedgePosition,
  HedgeAction,
  HedgeMode,
  ExitResult,
} from "./types/hedge.types.ts";
import { RedisBus } from "./bus/redis-bus.ts";
import { HedgeExecutor } from "./execution/hedge-executor.ts";
import { OrderTracker } from "./execution/order-tracker.ts";
import { HedgeStateManager } from "./state/hedge-state.ts";
import { ActionLog } from "./state/action-log.ts";
import { EmergencyExitStrategy } from "./strategies/emergency-exit.strategy.ts";
import { AutoHedgeStrategy } from "./strategies/auto-hedge.strategy.ts";
import { DeltaNeutralStrategy } from "./strategies/delta-neutral.strategy.ts";
import { RiskStreamKeys, HEDGE_CONSUMER_GROUP, hedgeConsumerName } from "./bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "hedge-engine" });

export class HedgeEngine {
  private config: HedgeConfig;
  private bus: RedisBus;
  private executor: HedgeExecutor;
  private tracker: OrderTracker;
  private stateManager: HedgeStateManager;
  private actionLog: ActionLog;

  private emergencyExit: EmergencyExitStrategy;
  private autoHedge: AutoHedgeStrategy;
  private deltaNeutral: DeltaNeutralStrategy;

  private abortController: AbortController | null = null;

  constructor(config: HedgeConfig) {
    this.config = config;
    this.bus = new RedisBus(config.redis.url);
    this.executor = new HedgeExecutor(this.bus);
    this.tracker = new OrderTracker();
    this.stateManager = new HedgeStateManager(this.bus, this.tracker, config);
    this.actionLog = new ActionLog();

    this.emergencyExit = new EmergencyExitStrategy(
      this.executor,
      this.stateManager,
      this.actionLog,
      this.tracker,
      config.exchanges,
      config.emergencyExit
    );

    this.autoHedge = new AutoHedgeStrategy(
      this.bus,
      this.executor,
      this.stateManager,
      this.actionLog,
      this.tracker,
      config.autoHedge,
      config.exchanges
    );

    this.deltaNeutral = new DeltaNeutralStrategy();
  }

  async start(): Promise<void> {
    logger.info("Starting Hedge Engine...");

    await this.bus.connect();

    // Start risk signal listener
    this.abortController = new AbortController();
    await this.startRiskSignalListener();

    // Start strategies
    this.autoHedge.start();
    this.deltaNeutral.start();

    // Publish initial state
    await this.stateManager.publish();

    logger.info(
      {
        mode: this.config.globalMode,
        autoHedge: this.config.autoHedge.enabled,
        deltaNeutral: this.config.deltaNeutral.enabled,
        emergencyAutoTrigger: this.config.emergencyExit.autoTriggerEnabled,
      },
      "Hedge Engine started"
    );
  }

  async stop(): Promise<void> {
    logger.info("Stopping Hedge Engine...");

    this.abortController?.abort();
    this.autoHedge.stop();
    this.deltaNeutral.stop();
    await this.bus.disconnect();

    logger.info("Hedge Engine stopped");
  }

  // ═══════════════════════════════════════════════════════════════
  // Mode Control
  // ═══════════════════════════════════════════════════════════════

  setGlobalMode(mode: HedgeMode): void {
    this.config.globalMode = mode;
    this.config.autoHedge.mode = mode;
    this.config.deltaNeutral.mode = mode;

    // Advisor → Controller: immediate exposure check
    if (mode === "controller") {
      this.autoHedge.onExposureSignal();
    }

    this.stateManager.publish();
    logger.info({ mode }, "Global mode changed");
  }

  setStrategyMode(strategy: string, mode: HedgeMode): void {
    if (strategy === "auto_hedge") {
      this.config.autoHedge.mode = mode;
    } else if (strategy === "delta_neutral") {
      this.config.deltaNeutral.mode = mode;
    }
    this.stateManager.publish();
    logger.info({ strategy, mode }, "Strategy mode changed");
  }

  // ═══════════════════════════════════════════════════════════════
  // Manual Actions
  // ═══════════════════════════════════════════════════════════════

  async triggerEmergencyExit(): Promise<ExitResult> {
    return this.emergencyExit.execute("Manual trigger");
  }

  async unlock(): Promise<void> {
    if (this.stateManager.getStatus() !== "locked") {
      logger.warn("System is not locked");
      return;
    }
    this.stateManager.setStatus("idle");
    await this.stateManager.publish();
    logger.info("System unlocked");
  }

  // ═══════════════════════════════════════════════════════════════
  // State Queries
  // ═══════════════════════════════════════════════════════════════

  getState(): HedgeState {
    return this.stateManager.buildState();
  }

  getActiveHedges(): HedgePosition[] {
    return this.tracker.getActiveHedges();
  }

  getActionLog(limit?: number): HedgeAction[] {
    return this.actionLog.getAll(limit);
  }

  // ═══════════════════════════════════════════════════════════════
  // Configuration
  // ═══════════════════════════════════════════════════════════════

  updateConfig(partial: Partial<HedgeConfig>): void {
    Object.assign(this.config, partial);
    this.stateManager.publish();
    logger.info("Config updated");
  }

  // ═══════════════════════════════════════════════════════════════
  // Risk Signal Listener
  // ═══════════════════════════════════════════════════════════════

  private async startRiskSignalListener(): Promise<void> {
    const signal = this.abortController!.signal;
    const consumerName = hedgeConsumerName();

    // Listen to drawdown signals (for emergency exit triggers)
    const drawdownKey = RiskStreamKeys.drawdown;
    await this.bus.ensureConsumerGroup(drawdownKey, HEDGE_CONSUMER_GROUP);

    (async () => {
      while (!signal.aborted) {
        try {
          const messages = await this.bus.readGroup(
            HEDGE_CONSUMER_GROUP,
            consumerName,
            drawdownKey,
            10,
            2000
          );

          for (const msg of messages) {
            const data = msg.data as { type?: string };

            // Emergency exit triggers
            if (data.type && this.emergencyExit.shouldTrigger(data.type)) {
              logger.warn({ signalType: data.type }, "Emergency exit auto-triggered by risk signal");
              await this.emergencyExit.execute(`Risk signal: ${data.type}`);
            }

            await this.bus.ack(drawdownKey, HEDGE_CONSUMER_GROUP, msg.id);
          }
        } catch (err) {
          if (signal.aborted) break;
          logger.error({ err }, "Risk signal listener error");
          await sleep(1000);
        }
      }
    })().catch((err) => logger.error({ err }, "Risk signal listener crashed"));

    // Listen to exposure signals (for auto-hedge triggers)
    const exposureKey = RiskStreamKeys.exposure;
    await this.bus.ensureConsumerGroup(exposureKey, HEDGE_CONSUMER_GROUP);

    (async () => {
      while (!signal.aborted) {
        try {
          const messages = await this.bus.readGroup(
            HEDGE_CONSUMER_GROUP,
            consumerName,
            exposureKey,
            10,
            2000
          );

          for (const msg of messages) {
            // Trigger auto-hedge check on exposure signals
            if (this.config.autoHedge.enabled && this.stateManager.getStatus() !== "locked") {
              await this.autoHedge.onExposureSignal();
            }
            await this.bus.ack(exposureKey, HEDGE_CONSUMER_GROUP, msg.id);
          }
        } catch (err) {
          if (signal.aborted) break;
          logger.error({ err }, "Exposure signal listener error");
          await sleep(1000);
        }
      }
    })().catch((err) => logger.error({ err }, "Exposure signal listener crashed"));

    logger.info("Risk signal listeners started");
  }
}
