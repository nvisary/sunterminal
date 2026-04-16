import type { RedisBus } from "../bus/redis-bus.ts";
import type { OrderRequest, PreTradeResult, GuardCheck, TradeConfig } from "../types/trade.types.ts";
import { RiskSnapshotKeys, HedgeSnapshotKeys, MdSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "pre-trade-guard" });

interface DrawdownState {
  isTradeBlocked: boolean;
  currentLevel: string;
}

interface HedgeState {
  status: string;
}

interface VolatilityData {
  regime: string;
  atrPercent: number;
}

interface PriceLevel {
  price: number;
  type: string;
  strength: number;
}

interface FundingData {
  rate: number;
  interval: number;
}

export class PreTradeGuard {
  private bus: RedisBus;
  private cfg: TradeConfig["guards"];
  private sizerCfg: TradeConfig["positionSizer"];
  private openTradeCount: () => number;

  constructor(
    bus: RedisBus,
    cfg: TradeConfig["guards"],
    sizerCfg: TradeConfig["positionSizer"],
    openTradeCount: () => number
  ) {
    this.bus = bus;
    this.cfg = cfg;
    this.sizerCfg = sizerCfg;
    this.openTradeCount = openTradeCount;
  }

  async check(request: OrderRequest): Promise<PreTradeResult> {
    const checks = await Promise.all([
      this.checkRiskEngineBlock(),
      this.checkHedgeLock(),
      this.checkMaxPositions(),
      this.checkVolatilityRegime(request.exchange, request.symbol),
      this.checkLevelProximity(request.exchange, request.symbol, request.price),
      this.checkFundingCost(request.exchange, request.symbol),
    ]);

    const blocks: GuardCheck[] = [];
    const warnings: GuardCheck[] = [];

    for (const check of checks) {
      if (!check) continue;
      if (check.type === "block") blocks.push(check);
      else if (check.type === "warning") warnings.push(check);
    }

    const allowed = blocks.length === 0;

    if (!allowed) {
      logger.warn({ blocks: blocks.map((b) => b.message) }, "Trade blocked by pre-trade guard");
    }

    return { allowed, blocks, warnings };
  }

  private async checkRiskEngineBlock(): Promise<GuardCheck | null> {
    if (this.cfg.riskEngineBlock === "off") return null;

    const drawdown = await this.bus.getSnapshot<DrawdownState>("risk:state:peak-equity");
    // Check via exposure snapshot which has equity info
    const exposure = await this.bus.getSnapshot<{ equity: number }>(RiskSnapshotKeys.exposure);

    // A simple heuristic: if no exposure data, can't determine — skip
    if (!exposure) return null;

    // Check drawdown state from snapshot
    const ddState = await this.bus.getSnapshot<string>("risk:state:trade-blocked");
    if (ddState === "true") {
      return {
        name: "riskEngineBlock",
        type: this.cfg.riskEngineBlock,
        message: "Trading blocked by Risk Engine (drawdown threshold exceeded)",
      };
    }

    return null;
  }

  private async checkHedgeLock(): Promise<GuardCheck | null> {
    if (this.cfg.hedgeLock === "off") return null;

    const hedgeState = await this.bus.getSnapshot<HedgeState>(HedgeSnapshotKeys.state);
    if (hedgeState?.status === "locked" || hedgeState?.status === "emergency") {
      return {
        name: "hedgeLock",
        type: this.cfg.hedgeLock,
        message: `Trading locked by Hedge Engine (status: ${hedgeState.status})`,
      };
    }

    return null;
  }

  private async checkMaxPositions(): Promise<GuardCheck | null> {
    if (this.cfg.maxPositions === "off") return null;

    const count = this.openTradeCount();
    if (count >= this.sizerCfg.maxOpenPositions) {
      return {
        name: "maxPositions",
        type: this.cfg.maxPositions,
        message: `Max open positions reached (${count}/${this.sizerCfg.maxOpenPositions})`,
      };
    }

    return null;
  }

  private async checkVolatilityRegime(exchange: string, symbol: string): Promise<GuardCheck | null> {
    if (this.cfg.volatilityRegime === "off") return null;

    const vol = await this.bus.getSnapshot<VolatilityData>(
      RiskSnapshotKeys.volatility(exchange, symbol)
    );

    if (vol?.regime === "EXTREME_VOL") {
      return {
        name: "volatilityRegime",
        type: this.cfg.volatilityRegime,
        message: `Extreme volatility regime (ATR%: ${vol.atrPercent?.toFixed(2)})`,
      };
    }

    return null;
  }

  private async checkLevelProximity(
    exchange: string,
    symbol: string,
    price?: number
  ): Promise<GuardCheck | null> {
    if (this.cfg.levelProximity === "off" || !price) return null;

    const levels = await this.bus.getSnapshot<PriceLevel[]>(
      RiskSnapshotKeys.levels(exchange, symbol)
    );

    if (!levels || levels.length === 0) return null;

    for (const level of levels) {
      const dist = Math.abs(price - level.price) / price;
      if (dist < 0.003 && level.strength > 3) { // Within 0.3% of strong level
        return {
          name: "levelProximity",
          type: this.cfg.levelProximity,
          message: `Price near ${level.type} level at $${level.price.toFixed(2)} (strength: ${level.strength.toFixed(1)})`,
        };
      }
    }

    return null;
  }

  private async checkFundingCost(exchange: string, symbol: string): Promise<GuardCheck | null> {
    if (this.cfg.fundingCost === "off") return null;

    const funding = await this.bus.getSnapshot<FundingData>(
      MdSnapshotKeys.funding(exchange, symbol)
    );

    if (!funding) return null;

    const annualizedCost = Math.abs(funding.rate) * (365 * 24 / funding.interval) * 100;
    if (annualizedCost > 50) { // > 50% annualized
      return {
        name: "fundingCost",
        type: this.cfg.fundingCost,
        message: `High funding cost: ${(funding.rate * 100).toFixed(4)}% per ${funding.interval}h (${annualizedCost.toFixed(0)}% annualized)`,
      };
    }

    return null;
  }
}
