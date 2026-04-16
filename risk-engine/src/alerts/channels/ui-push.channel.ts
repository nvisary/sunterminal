import type { RedisBus } from "../../bus/redis-bus.ts";
import { RiskStreamKeys, RiskStreamMaxLen } from "../../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "ui-push-channel" });

/**
 * Publishes alerts to risk:alerts Redis stream for UI gateway consumption.
 */
export class UiPushChannel {
  constructor(private bus: RedisBus) {}

  async send(signal: Record<string, unknown>): Promise<void> {
    try {
      await this.bus.publish(
        RiskStreamKeys.alerts,
        signal,
        RiskStreamMaxLen.alerts
      );
    } catch (err) {
      logger.error({ err }, "UI push failed");
    }
  }
}
