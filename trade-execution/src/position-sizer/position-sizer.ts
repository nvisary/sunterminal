import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import type { PositionSizeResult, TradeConfig, TradeMode } from "../types/trade.types.ts";
import type { SimAccountSnapshot } from "../types/sim.types.ts";
import { MdStreamKeys, MdSnapshotKeys, RiskSnapshotKeys, SimSnapshotKeys } from "../bus/channels.ts";
import { calculatePositionSize, calculateAutoStop, calculateRiskReward } from "./risk-calculator.ts";
import pino from "pino";

const logger = pino({ name: "position-sizer" });

interface VolatilityData {
  atr: number;
  regime: string;
}

export class PositionSizer {
  private bus: RedisBus;
  private cfg: TradeConfig["positionSizer"];

  constructor(bus: RedisBus, cfg: TradeConfig["positionSizer"]) {
    this.bus = bus;
    this.cfg = cfg;
  }

  async calculate(params: {
    exchange: string;
    symbol: string;
    side: "buy" | "sell";
    stopLoss?: number;
    takeProfit?: number;
    leverage?: number;
    riskPercent?: number;
    mode?: TradeMode;
    accountId?: string;
  }): Promise<PositionSizeResult> {
    const warnings: string[] = [];
    const leverage = params.leverage ?? this.cfg.defaultLeverage;
    const riskPct = params.riskPercent ?? this.cfg.riskPerTrade;

    // Get current price
    const ticker = await this.bus.getSnapshot<{ price: number }>(
      MdSnapshotKeys.ticker(params.exchange, params.symbol)
    );
    const entryPrice = ticker?.price ?? 0;
    if (entryPrice <= 0) {
      return this.emptyResult("No price data available");
    }

    const mode: TradeMode = params.mode ?? "live";
    let equity = 0;
    let freeBalance = 0;

    if (mode === "sim") {
      const accountId = params.accountId ?? "default";
      const sim = await this.bus.getSnapshot<SimAccountSnapshot>(SimSnapshotKeys.exposure(accountId));
      const acct = await this.bus.getSnapshot<SimAccountSnapshot>(SimSnapshotKeys.account(accountId));
      equity = sim?.equity ?? acct?.cashUSDT ?? 0;
      freeBalance = acct?.cashUSDT ?? equity;
      if (equity <= 0) return this.emptyResult("Sim account not initialized");
    } else {
      // Live: equity from exposure snapshot, balance via REST
      const exposure = await this.bus.getSnapshot<{ equity: number }>(RiskSnapshotKeys.exposure);
      equity = exposure?.equity ?? 0;
      if (equity <= 0) return this.emptyResult("No equity data available");

      const balance = await this.fetchBalance(params.exchange);
      const free = balance?.free as Record<string, number> | undefined;
      freeBalance = free?.USDT ?? free?.usdt ?? equity;
    }

    // Determine stop loss
    let stopLoss = params.stopLoss;
    if (!stopLoss) {
      // Auto-stop by ATR
      const vol = await this.bus.getSnapshot<VolatilityData>(
        RiskSnapshotKeys.volatility(params.exchange, params.symbol)
      );

      if (vol && vol.atr > 0) {
        stopLoss = calculateAutoStop(entryPrice, vol.atr, this.cfg.atrMultiplier, params.side);
        warnings.push(`Auto SL by ATR: $${stopLoss.toFixed(2)} (ATR×${this.cfg.atrMultiplier})`);
      } else {
        // Fallback: 2% from entry
        const fallbackDist = entryPrice * 0.02;
        stopLoss = params.side === "buy" ? entryPrice - fallbackDist : entryPrice + fallbackDist;
        warnings.push("No ATR data, using 2% fallback stop");
      }
    }

    // Calculate size
    const result = calculatePositionSize({
      equity,
      riskPerTrade: riskPct,
      entryPrice,
      stopLossPrice: stopLoss,
      leverage,
      maxPositionUSD: this.cfg.maxPositionUSD,
      marginReserve: this.cfg.marginReserve,
      freeBalance,
    });

    if (result.capped) {
      warnings.push(`Position capped to max $${this.cfg.maxPositionUSD}`);
    }
    if (!result.marginOk) {
      warnings.push(`Insufficient margin: need $${result.requiredMargin.toFixed(2)}, available $${(freeBalance * (1 - this.cfg.marginReserve / 100)).toFixed(2)}`);
    }

    // Check volatility regime
    const vol = await this.bus.getSnapshot<VolatilityData>(
      RiskSnapshotKeys.volatility(params.exchange, params.symbol)
    );
    if (vol?.regime === "EXTREME_VOL") {
      warnings.push("EXTREME volatility regime — consider reducing size");
    }

    // Calculate R:R if TP provided
    let riskRewardRatio: number | undefined;
    if (params.takeProfit) {
      riskRewardRatio = calculateRiskReward(entryPrice, stopLoss, params.takeProfit);
      if (riskRewardRatio < 1) {
        warnings.push(`Low R:R ratio: ${riskRewardRatio.toFixed(2)} (< 1.0)`);
      }
    }

    return {
      positionSizeUSD: result.positionSizeUSD,
      positionSizeBase: result.positionSizeBase,
      riskAmount: result.riskAmount,
      stopLoss,
      takeProfit: params.takeProfit,
      leverage,
      requiredMargin: result.requiredMargin,
      riskRewardRatio,
      warnings,
    };
  }

  private emptyResult(warning: string): PositionSizeResult {
    return {
      positionSizeUSD: 0,
      positionSizeBase: 0,
      riskAmount: 0,
      stopLoss: 0,
      leverage: this.cfg.defaultLeverage,
      requiredMargin: 0,
      warnings: [warning],
    };
  }

  private async fetchBalance(exchange: string): Promise<Record<string, unknown> | null> {
    const reqId = randomUUID();
    const replyTo = MdStreamKeys.restResponse(reqId);
    await this.bus.publish(MdStreamKeys.restRequest, { method: "fetchBalance", exchange, args: [], replyTo }, 1000);

    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const msgs = await this.bus.readLatest(replyTo, 1);
      if (msgs.length > 0) {
        await this.bus.client.del(replyTo);
        const res = msgs[0]!.data as { success: boolean; data: unknown };
        return res.success ? (res.data as Record<string, unknown>) : null;
      }
      await sleep(200);
    }
    await this.bus.client.del(replyTo);
    return null;
  }
}
