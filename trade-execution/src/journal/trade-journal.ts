import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import type { TradeRecord, PnLStats, EquityPoint, OrderState, TradeMode } from "../types/trade.types.ts";
import {
  RiskSnapshotKeys,
  MdSnapshotKeys,
  SimSnapshotKeys,
  resolveJournalKeys,
} from "../bus/channels.ts";
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

export interface JournalCtx {
  mode: TradeMode;
  accountId: string;
}

export class TradeJournal {
  private bus: RedisBus;
  private ctx: JournalCtx;
  private keys: ReturnType<typeof resolveJournalKeys>;
  private openTrades = new Map<string, TradeRecord>();
  private closedTrades: TradeRecord[] = [];
  private equityCurve: EquityPoint[] = [];

  constructor(bus: RedisBus, ctx: JournalCtx = { mode: "live", accountId: "live" }) {
    this.bus = bus;
    this.ctx = ctx;
    this.keys = resolveJournalKeys(ctx.mode, ctx.accountId);
  }

  get mode(): TradeMode {
    return this.ctx.mode;
  }

  get accountId(): string {
    return this.ctx.accountId;
  }

  /**
   * Restore in-memory state from Redis (open positions hash + recent journal entries).
   * Useful after restart so sim accounts and live journals survive.
   */
  async restore(closedLimit: number = 500): Promise<void> {
    try {
      const openRaw = await this.bus.client.hgetall(this.keys.openHash);
      const stale: string[] = [];
      for (const [id, payload] of Object.entries(openRaw)) {
        try {
          const rec = JSON.parse(payload) as TradeRecord;
          // Defensive: a previous MTM/close race could leave a record with
          // closedAt set inside the open hash. Treat those as stale and purge.
          if (rec.closedAt) {
            stale.push(id);
            continue;
          }
          this.openTrades.set(id, rec);
        } catch {
          stale.push(id);
        }
      }
      if (stale.length > 0) {
        await this.bus.client.hdel(this.keys.openHash, ...stale);
        logger.warn({ accountId: this.ctx.accountId, count: stale.length }, "Purged stale closed entries from open hash");
      }

      const closed = await this.bus.client.xrevrange(this.keys.journalStream, "+", "-", "COUNT", closedLimit);
      const restored: TradeRecord[] = [];
      for (const [, fields] of closed) {
        const dataIdx = fields.indexOf("data");
        if (dataIdx === -1 || !fields[dataIdx + 1]) continue;
        try {
          const rec = JSON.parse(fields[dataIdx + 1]!) as TradeRecord;
          if (rec.closedAt && !this.openTrades.has(rec.id)) restored.push(rec);
        } catch {
          // ignore
        }
      }
      // xrevrange returns newest first; reverse for chronological order
      this.closedTrades = restored.reverse();

      logger.info(
        { mode: this.ctx.mode, accountId: this.ctx.accountId, open: this.openTrades.size, closed: this.closedTrades.length },
        "Journal restored",
      );
    } catch (err) {
      logger.warn({ err }, "Journal restore failed");
    }
  }

  /**
   * Record a new trade from an order fill.
   */
  async recordOpen(orderState: OrderState, extra?: Partial<TradeRecord>): Promise<TradeRecord> {
    const req = orderState.request;

    const vol = await this.bus.getSnapshot<VolatilityData>(
      RiskSnapshotKeys.volatility(req.exchange, req.symbol)
    );
    const funding = await this.bus.getSnapshot<FundingData>(
      MdSnapshotKeys.funding(req.exchange, req.symbol)
    );

    const record: TradeRecord = {
      id: randomUUID(),
      mode: this.ctx.mode,
      accountId: this.ctx.accountId,
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
      riskAmount: 0,
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
      ...extra,
    };

    this.openTrades.set(record.id, record);

    await this.bus.client.hset(this.keys.openHash, record.id, JSON.stringify(record));
    await this.bus.publish(
      this.keys.journalStream,
      record as unknown as Record<string, unknown>,
      this.keys.journalMaxLen,
    );

    logger.info({
      mode: record.mode,
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
      logger.warn({ mode: this.ctx.mode, tradeId }, "Trade not found for close");
      return null;
    }

    record.exitPrice = exitPrice;
    record.closedAt = Date.now();
    record.duration = record.closedAt - record.openedAt;
    record.fees += fees;

    const priceDiff = record.side === "long"
      ? exitPrice - record.entryPrice
      : record.entryPrice - exitPrice;
    record.realizedPnl = (priceDiff / record.entryPrice) * record.size;
    record.netPnl = record.realizedPnl - record.fees - record.fundingPaid;

    this.openTrades.delete(tradeId);
    this.closedTrades.push(record);

    await this.bus.client.hdel(this.keys.openHash, tradeId);
    await this.bus.publish(
      this.keys.journalStream,
      record as unknown as Record<string, unknown>,
      this.keys.journalMaxLen,
    );

    await this.publishStats();

    // Equity-curve point sourcing: live → exposure snapshot, sim → sim account snapshot
    const equity = await this.fetchEquity();
    if (equity !== null) {
      const point: EquityPoint = { equity, timestamp: Date.now() };
      this.equityCurve.push(point);
      await this.bus.publish(
        this.keys.equityStream,
        point as unknown as Record<string, unknown>,
        this.keys.equityMaxLen,
      );
    }

    logger.info({
      mode: this.ctx.mode,
      id: tradeId,
      symbol: record.symbol,
      pnl: record.netPnl?.toFixed(2),
      duration: record.duration ? `${(record.duration / 1000).toFixed(0)}s` : "?",
    }, "Trade closed");

    return record;
  }

  /** Update fundingPaid on an open position (sim-only path; live ccxt fills supply this). */
  async updateFunding(tradeId: string, deltaUSD: number): Promise<void> {
    const rec = this.openTrades.get(tradeId);
    if (!rec) return;
    rec.fundingPaid += deltaUSD;
    await this.bus.client.hset(this.keys.openHash, tradeId, JSON.stringify(rec));
  }

  /**
   * Mutate an open position in-place. Used by sim netting to grow an existing
   * position (same-direction fill) or shrink it (opposite-direction fill).
   * Persists to Redis hash so the UI sees the change on next mark.
   */
  async updateOpen(tradeId: string, updates: Partial<TradeRecord>): Promise<TradeRecord | null> {
    const rec = this.openTrades.get(tradeId);
    if (!rec) return null;
    Object.assign(rec, updates);
    await this.bus.client.hset(this.keys.openHash, tradeId, JSON.stringify(rec));
    return rec;
  }

  /** Find one open trade by exchange+symbol (sim assumes one position per symbol). */
  findOpenBySymbol(exchange: string, symbol: string): TradeRecord | undefined {
    for (const t of this.openTrades.values()) {
      if (t.exchange === exchange && t.symbol === symbol) return t;
    }
    return undefined;
  }

  getOpenTrades(): TradeRecord[] {
    return [...this.openTrades.values()];
  }

  getOpenTradeCount(): number {
    return this.openTrades.size;
  }

  getOpenTrade(id: string): TradeRecord | undefined {
    return this.openTrades.get(id);
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
    await this.bus.client.hset(this.keys.statsHash, "all", JSON.stringify(stats));
  }

  private async fetchEquity(): Promise<number | null> {
    if (this.ctx.mode === "live") {
      const exposure = await this.bus.getSnapshot<ExposureSnapshot>(RiskSnapshotKeys.exposure);
      return exposure?.equity ?? null;
    }
    const sim = await this.bus.getSnapshot<{ equity: number }>(SimSnapshotKeys.exposure(this.ctx.accountId));
    return sim?.equity ?? null;
  }
}
