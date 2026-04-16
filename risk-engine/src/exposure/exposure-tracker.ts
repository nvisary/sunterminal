import type { RedisBus } from "../bus/redis-bus.ts";
import type { SignalPublisher } from "../signal-bus/signal-publisher.ts";
import type { AccountSnapshot } from "../consumers/account-poller.ts";
import type { ExposureSnapshot, PositionSummary, RiskEngineConfig } from "../types/risk.types.ts";
import { RiskSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "exposure-tracker" });

export class ExposureTracker {
  private bus: RedisBus;
  private publisher: SignalPublisher;
  private cfg: RiskEngineConfig["exposure"];
  private snapshot: ExposureSnapshot | null = null;

  constructor(bus: RedisBus, publisher: SignalPublisher, cfg: RiskEngineConfig["exposure"]) {
    this.bus = bus;
    this.publisher = publisher;
    this.cfg = cfg;
  }

  /**
   * Called by AccountPoller on each update.
   */
  async onAccountUpdate(snapshot: AccountSnapshot, equity: number): Promise<void> {
    if (equity <= 0) return;

    const positions: PositionSummary[] = [];
    const byExchange: Record<string, { long: number; short: number; net: number }> = {};
    const byAsset: Record<string, { long: number; short: number; net: number }> = {};

    let totalLong = 0;
    let totalShort = 0;

    for (const [exchange, exchangePositions] of snapshot.positions) {
      if (!byExchange[exchange]) byExchange[exchange] = { long: 0, short: 0, net: 0 };

      for (const pos of exchangePositions) {
        if (pos.contracts === 0) continue;

        const isLong = pos.side !== "short";
        const notional = Math.abs(pos.notional ?? pos.contracts * (pos.contractSize || 1) * (pos.markPrice || pos.entryPrice));

        positions.push({
          exchange,
          symbol: pos.symbol,
          side: isLong ? "long" : "short",
          notional,
          unrealizedPnl: pos.unrealizedPnl ?? 0,
          leverage: pos.leverage ?? 1,
        });

        if (isLong) {
          totalLong += notional;
          byExchange[exchange]!.long += notional;
        } else {
          totalShort += notional;
          byExchange[exchange]!.short += notional;
        }
        byExchange[exchange]!.net = byExchange[exchange]!.long - byExchange[exchange]!.short;

        // Group by base asset (e.g., "BTC" from "BTC/USDT:USDT")
        const asset = pos.symbol.split("/")[0] ?? pos.symbol;
        if (!byAsset[asset]) byAsset[asset] = { long: 0, short: 0, net: 0 };
        if (isLong) {
          byAsset[asset]!.long += notional;
        } else {
          byAsset[asset]!.short += notional;
        }
        byAsset[asset]!.net = byAsset[asset]!.long - byAsset[asset]!.short;
      }
    }

    const netExposure = totalLong - totalShort;
    const grossExposure = totalLong + totalShort;
    const exposureRatio = equity > 0 ? grossExposure / equity : 0;

    this.snapshot = {
      netExposure,
      grossExposure,
      exposureRatio,
      equity,
      byExchange,
      byAsset,
      positions,
      timestamp: Date.now(),
    };

    // Persist snapshot
    await this.bus.setSnapshot(RiskSnapshotKeys.exposure, this.snapshot);

    // Check thresholds
    await this.checkThresholds(grossExposure, netExposure, exposureRatio, byExchange, byAsset);

    logger.debug({
      net: netExposure.toFixed(2),
      gross: grossExposure.toFixed(2),
      ratio: exposureRatio.toFixed(2),
      positions: positions.length,
    }, "Exposure updated");
  }

  getSnapshot(): ExposureSnapshot | null {
    return this.snapshot;
  }

  // ─── Private ──────────────────────────────────────────────────

  private async checkThresholds(
    gross: number,
    net: number,
    ratio: number,
    byExchange: Record<string, { long: number; short: number; net: number }>,
    byAsset: Record<string, { long: number; short: number; net: number }>
  ): Promise<void> {
    // EXP_HIGH: exposure ratio too high
    if (ratio > this.cfg.highRatio) {
      await this.emitSignal("EXP_HIGH", "warning", {
        exposureRatio: ratio,
        threshold: this.cfg.highRatio,
      });
    }

    // EXP_IMBALANCE: portfolio too one-directional
    if (gross > 0 && Math.abs(net / gross) > this.cfg.imbalanceThreshold) {
      await this.emitSignal("EXP_IMBALANCE", "warning", {
        imbalance: Math.abs(net / gross),
        threshold: this.cfg.imbalanceThreshold,
        direction: net > 0 ? "long" : "short",
      });
    }

    // EXP_CONCENTRATED: single asset > threshold of gross
    if (gross > 0) {
      for (const [asset, data] of Object.entries(byAsset)) {
        const assetGross = data.long + data.short;
        const concentration = assetGross / gross;
        if (concentration > this.cfg.concentrationThreshold) {
          await this.emitSignal("EXP_CONCENTRATED", "warning", {
            asset,
            concentration,
            threshold: this.cfg.concentrationThreshold,
          });
        }
      }
    }

    // EXP_EXCHANGE_RISK: single exchange > threshold of gross
    if (gross > 0) {
      for (const [exchange, data] of Object.entries(byExchange)) {
        const exchangeGross = data.long + data.short;
        const concentration = exchangeGross / gross;
        if (concentration > this.cfg.exchangeRiskThreshold) {
          await this.emitSignal("EXP_EXCHANGE_RISK", "warning", {
            exchange,
            concentration,
            threshold: this.cfg.exchangeRiskThreshold,
          });
        }
      }
    }
  }

  private async emitSignal(
    type: string,
    level: "info" | "warning" | "danger" | "critical",
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.publisher.publishExposure({
      source: "exposure",
      type,
      level,
      payload,
      action: "alert",
      timestamp: Date.now(),
    });

    logger.warn({ type, ...payload }, "Exposure threshold breached");
  }
}
