import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import type { TradeRecord, PnLStats, EquityPoint, OrderState } from "../types/trade.types.ts";
import { TradeStreamKeys, TradeHashKeys, TradeStreamMaxLen, RiskSnapshotKeys, MdSnapshotKeys } from "../bus/channels.ts";
import { calculatePnLStats } from "./pnl-calculator.ts";
import pino from "pino";

const logger = pino({ name: "trade-journal" });

interface VolatilityData {
  regime: string;
}

interface FundingData {
  rate: number;
}

interface ExposureSnapshot {
  equity: number;
}

interface DrawdownState {
  dailyDrawdownPct: number;
}

export class TradeJournal {
  private bus: RedisBus;
  private openTrades = new Map<string, TradeRecord>();
  private closedTrades: TradeRecord[] = [];
  private equityCurve: EquityPoint[] = [];

  constructor(bus: RedisBus) {
    this.bus = bus;
  }

  /**
   * Record a new trade from an order fill.
   */
  async recordOpen(orderState: OrderState): Promise<TradeRecord> {
    const req = orderState.request;

    // Gather context from snapshots
    const vol = await this.bus.getSnapshot<VolatilityData>(
      RiskSnapshotKeys.volatility(req.exchange, req.symbol)
    );
    const funding = await this.bus.getSnapshot<FundingData>(
      MdSnapshotKeys.funding(req.exchange, req.symbol)
    );
    const exposure = await this.bus.getSnapshot<ExposureSnapshot>(RiskSnapshotKeys.exposure);

    const record: TradeRecord = {
      id: randomUUID(),
      exchange: req.exchange,
      symbol: req.symbol,
      side: req.side === "buy" ? "long" : "short",
      entryPrice: orderState.averagePrice,
      exitPrice: null,
      size: orderState.filledAmount * orderState.averagePrice,
      leverage: req.leverage ?? 1,
      realizedPnl: null,
      fees: orderState.fees,
      fundingPaid: 0,
      netPnl: null,
      stopLoss: req.stopLoss ?? 0,
      takeProfit: req.takeProfit ?? null,
      riskAmount: 0, // Filled by position sizer
      strategy: req.strategy,
      slippage: orderState.slippage,
      volatilityRegime: vol?.regime ?? "UNKNOWN",
      fundingRate: funding?.rate ?? 0,
      portfolioDrawdown: 0,
      openedAt: Date.now(),
      closedAt: null,
      duration: null,
      tags: [],
      notes: "",
    };

    this.openTrades.set(record.id, record);

    // Persist to Redis
    await this.bus.client.hset(TradeHashKeys.open, record.id, JSON.stringify(record));
    await this.bus.publish(
      TradeStreamKeys.journal,
      record as unknown as Record<string, unknown>,
      TradeStreamMaxLen.journal
    );

    logger.info({
      id: record.id,
      exchange: record.exchange,
      symbol: record.symbol,
      side: record.side,
      size: record.size.toFixed(2),
      entry: record.entryPrice,
    }, "Trade opened");

    return record;
  }

  /**
   * Record trade close.
   */
  async recordClose(tradeId: string, exitPrice: number, fees: number = 0): Promise<TradeRecord | null> {
    const record = this.openTrades.get(tradeId);
    if (!record) {
      logger.warn({ tradeId }, "Trade not found for close");
      return null;
    }

    record.exitPrice = exitPrice;
    record.closedAt = Date.now();
    record.duration = record.closedAt - record.openedAt;
    record.fees += fees;

    // Calculate PnL
    const priceDiff = record.side === "long"
      ? exitPrice - record.entryPrice
      : record.entryPrice - exitPrice;
    record.realizedPnl = (priceDiff / record.entryPrice) * record.size;
    record.netPnl = record.realizedPnl - record.fees - record.fundingPaid;

    // Move to closed
    this.openTrades.delete(tradeId);
    this.closedTrades.push(record);

    // Update Redis
    await this.bus.client.hdel(TradeHashKeys.open, tradeId);
    await this.bus.publish(
      TradeStreamKeys.journal,
      record as unknown as Record<string, unknown>,
      TradeStreamMaxLen.journal
    );

    // Update stats
    await this.publishStats();

    // Update equity curve
    const exposure = await this.bus.getSnapshot<ExposureSnapshot>(RiskSnapshotKeys.exposure);
    if (exposure) {
      this.equityCurve.push({ equity: exposure.equity, timestamp: Date.now() });
      await this.bus.publish(
        TradeStreamKeys.equity,
        { equity: exposure.equity, timestamp: Date.now() },
        TradeStreamMaxLen.equity
      );
    }

    logger.info({
      id: tradeId,
      symbol: record.symbol,
      pnl: record.netPnl?.toFixed(2),
      duration: record.duration ? `${(record.duration / 1000).toFixed(0)}s` : "?",
    }, "Trade closed");

    return record;
  }

  getOpenTrades(): TradeRecord[] {
    return [...this.openTrades.values()];
  }

  getOpenTradeCount(): number {
    return this.openTrades.size;
  }

  getClosedTrades(): TradeRecord[] {
    return [...this.closedTrades];
  }

  getStats(period: string = "all"): PnLStats {
    return calculatePnLStats(this.closedTrades, period);
  }

  getEquityCurve(): EquityPoint[] {
    return [...this.equityCurve];
  }

  addNotes(tradeId: string, notes: string, tags: string[]): void {
    const trade = this.openTrades.get(tradeId) ?? this.closedTrades.find((t) => t.id === tradeId);
    if (trade) {
      trade.notes = notes;
      trade.tags = tags;
    }
  }

  private async publishStats(): Promise<void> {
    const stats = this.getStats();
    await this.bus.client.hset(TradeHashKeys.stats, "all", JSON.stringify(stats));
  }
}
