import { setTimeout as sleep } from "node:timers/promises";
import type { RedisBus } from "../bus/redis-bus.ts";
import type { RiskSignal, AlertRule, RiskEngineConfig } from "../types/risk.types.ts";
import { RiskStreamKeys, RISK_CONSUMER_GROUP, riskConsumerName, RiskSnapshotKeys } from "../bus/channels.ts";
import { TelegramChannel } from "./channels/telegram.channel.ts";
import { UiPushChannel } from "./channels/ui-push.channel.ts";
import pino from "pino";

const logger = pino({ name: "alert-manager" });

// Default alert rules
const DEFAULT_RULES: AlertRule[] = [
  { id: "dd-warning", enabled: true, signalType: "DD_WARNING", channels: ["ui", "telegram"], cooldownMs: 60_000 },
  { id: "dd-danger", enabled: true, signalType: "DD_DANGER", channels: ["ui", "telegram"], cooldownMs: 30_000 },
  { id: "dd-critical", enabled: true, signalType: "DD_CRITICAL", channels: ["ui", "telegram"], cooldownMs: 0 },
  { id: "dd-max-peak", enabled: true, signalType: "DD_MAX_PEAK", channels: ["ui", "telegram"], cooldownMs: 0 },
  { id: "dd-per-trade", enabled: true, signalType: "DD_PER_TRADE", channels: ["ui", "telegram"], cooldownMs: 60_000 },
  { id: "exp-high", enabled: true, signalType: "EXP_HIGH", channels: ["ui", "telegram"], cooldownMs: 300_000 },
  { id: "exp-imbalance", enabled: true, signalType: "EXP_IMBALANCE", channels: ["ui"], cooldownMs: 300_000 },
  { id: "exp-concentrated", enabled: true, signalType: "EXP_CONCENTRATED", channels: ["ui"], cooldownMs: 300_000 },
  { id: "exp-exchange-risk", enabled: true, signalType: "EXP_EXCHANGE_RISK", channels: ["ui"], cooldownMs: 300_000 },
  { id: "vol-extreme", enabled: true, signalType: "VOL_EXTREME_VOL", channels: ["ui", "telegram"], cooldownMs: 300_000 },
  { id: "vol-high", enabled: true, signalType: "VOL_HIGH_VOL", channels: ["ui"], cooldownMs: 600_000 },
];

export class AlertManager {
  private bus: RedisBus;
  private cfg: RiskEngineConfig["alerts"];
  private rules: AlertRule[];
  private cooldowns = new Map<string, number>(); // ruleId -> lastFiredMs
  private activeAlerts: RiskSignal[] = [];
  private abortController: AbortController | null = null;

  private telegram: TelegramChannel | null = null;
  private uiPush: UiPushChannel;

  constructor(bus: RedisBus, cfg: RiskEngineConfig["alerts"]) {
    this.bus = bus;
    this.cfg = cfg;
    this.rules = DEFAULT_RULES;
    this.uiPush = new UiPushChannel(bus);

    if (cfg.telegramBotToken && cfg.telegramChatId) {
      this.telegram = new TelegramChannel(cfg.telegramBotToken, cfg.telegramChatId);
    }
  }

  async start(): Promise<void> {
    this.telegram?.start();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    // Subscribe to all risk signal streams
    const streams = [
      RiskStreamKeys.drawdown,
      RiskStreamKeys.levels,
      RiskStreamKeys.volatility,
      RiskStreamKeys.exposure,
    ];

    const consumerGroup = "alert-manager";
    const consumerName = `alert-${process.pid}`;

    for (const stream of streams) {
      await this.bus.ensureConsumerGroup(stream, consumerGroup);
      this.startReadLoop(stream, consumerGroup, consumerName, signal);
    }

    logger.info(
      { telegram: !!this.telegram, streams: streams.length },
      "Alert manager started"
    );
  }

  stop(): void {
    this.abortController?.abort();
    this.telegram?.stop();
    logger.info("Alert manager stopped");
  }

  getActiveAlerts(): RiskSignal[] {
    return [...this.activeAlerts];
  }

  acknowledgeAlert(id: string): void {
    this.activeAlerts = this.activeAlerts.filter((a) => a.id !== id);
  }

  // ─── Private ──────────────────────────────────────────────────

  private startReadLoop(
    streamKey: string,
    groupName: string,
    consumerName: string,
    signal: AbortSignal
  ): void {
    (async () => {
      while (!signal.aborted) {
        try {
          const messages = await this.bus.readGroup(groupName, consumerName, streamKey, 10, 2000);

          for (const msg of messages) {
            const riskSignal = msg.data as unknown as RiskSignal;
            await this.processSignal(riskSignal);
            await this.bus.ack(streamKey, groupName, msg.id);
          }
        } catch (err) {
          if (signal.aborted) break;
          logger.error({ streamKey, err }, "Alert read loop error");
          await sleep(1000);
        }
      }
    })().catch((err) => logger.error({ streamKey, err }, "Alert read loop crashed"));
  }

  private async processSignal(signal: RiskSignal): Promise<void> {
    // Find matching rules
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.signalType !== signal.type) continue;

      // Cooldown check (CRITICAL bypasses)
      const isCritical = signal.level === "critical";
      if (!isCritical && rule.cooldownMs > 0) {
        const lastFired = this.cooldowns.get(rule.id) ?? 0;
        if (Date.now() - lastFired < rule.cooldownMs) continue;
      }

      // Dispatch to channels
      for (const channel of rule.channels) {
        if (channel === "ui") {
          await this.uiPush.send(signal as unknown as Record<string, unknown>);
        }
        if (channel === "telegram" && this.telegram) {
          const message = this.formatTelegramMessage(signal);
          this.telegram.send(message);
        }
      }

      this.cooldowns.set(rule.id, Date.now());

      // Track active alert
      this.activeAlerts.push(signal);
      // Keep only last 100
      if (this.activeAlerts.length > 100) {
        this.activeAlerts = this.activeAlerts.slice(-100);
      }

      logger.info({ type: signal.type, level: signal.level, channels: rule.channels }, "Alert dispatched");
    }
  }

  private formatTelegramMessage(signal: RiskSignal): string {
    if (!this.telegram) return "";

    const payload = signal.payload ?? {};

    if (signal.source === "drawdown") {
      return this.telegram.formatDrawdown(payload);
    }
    if (signal.source === "exposure") {
      return this.telegram.formatExposure({ ...payload, type: signal.type });
    }
    if (signal.source === "volatility") {
      return this.telegram.formatVolatility({ ...payload, symbol: signal.symbol });
    }

    return this.telegram.formatGeneric(signal as unknown as Record<string, unknown>);
  }
}
