import type { RedisBus } from "../bus/redis-bus.ts";
import type { RiskSignal } from "../types/risk.types.ts";
import { RiskStreamKeys, RiskStreamMaxLen } from "../bus/channels.ts";
import { randomUUID } from "node:crypto";

export class SignalPublisher {
  constructor(private bus: RedisBus) {}

  async publishDrawdown(signal: Omit<RiskSignal, "id">): Promise<void> {
    await this.bus.publish(
      RiskStreamKeys.drawdown,
      { ...signal, id: randomUUID() } as unknown as Record<string, unknown>,
      RiskStreamMaxLen.drawdown
    );
  }

  async publishLevels(signal: Omit<RiskSignal, "id">): Promise<void> {
    await this.bus.publish(
      RiskStreamKeys.levels,
      { ...signal, id: randomUUID() } as unknown as Record<string, unknown>,
      RiskStreamMaxLen.levels
    );
  }

  async publishVolatility(signal: Omit<RiskSignal, "id">): Promise<void> {
    await this.bus.publish(
      RiskStreamKeys.volatility,
      { ...signal, id: randomUUID() } as unknown as Record<string, unknown>,
      RiskStreamMaxLen.volatility
    );
  }

  async publishExposure(signal: Omit<RiskSignal, "id">): Promise<void> {
    await this.bus.publish(
      RiskStreamKeys.exposure,
      { ...signal, id: randomUUID() } as unknown as Record<string, unknown>,
      RiskStreamMaxLen.exposure
    );
  }

  async publishAlert(signal: Omit<RiskSignal, "id">): Promise<void> {
    await this.bus.publish(
      RiskStreamKeys.alerts,
      { ...signal, id: randomUUID() } as unknown as Record<string, unknown>,
      RiskStreamMaxLen.alerts
    );
  }
}
