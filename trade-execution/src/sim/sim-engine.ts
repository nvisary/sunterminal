import { randomUUID } from "node:crypto";
import type { RedisBus } from "../bus/redis-bus.ts";
import type {
  TradeConfig,
  OrderRequest,
  OrderState,
  TradeRecord,
} from "../types/trade.types.ts";
import type {
  SimAccountSnapshot,
  SimFillResult,
  SimOpenTradeRequest,
  SimOpenOrder,
} from "../types/sim.types.ts";
import { TradeJournal } from "../journal/trade-journal.ts";
import { SimAccount } from "./sim-account.ts";
import { SimMatchingEngine } from "./sim-matching-engine.ts";
import {
  MdSnapshotKeys,
  SimSnapshotKeys,
  SimStreamKeys,
  SimStreamMaxLen,
  SimHashKeys,
} from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "sim-engine" });

interface TickerSnapshot {
  price?: number;
  last?: number;
}

export interface SimEngineCallbacks {
  /** Called whenever sim drawdown crosses CRITICAL/MAX_PEAK so a UI can react. */
  onCritical?: (state: SimDrawdownLevel) => void;
}

export type SimDrawdownLevel = "NORMAL" | "WARNING" | "DANGER" | "CRITICAL" | "MAX_PEAK";

interface SimDrawdownState {
  equity: number;
  peakEquity: number;
  dailyDrawdownPct: number;
  peakDrawdownPct: number;
  currentLevel: SimDrawdownLevel;
  isTradeBlocked: boolean;
}

/**
 * SimEngine — paper-trading runtime.
 * Owns: per-account `SimAccount`, in-memory journal, matching engine, periodic loops:
 *   • mark-to-market (1Hz default) — recompute uPnL, publish exposure/drawdown.
 *   • limit matcher — subscribed via per-tick polling on md:trades streams (Phase 2).
 *   • funding accrual — slow loop applying funding payments (Phase 2).
 *
 * MVP only implements market orders.
 */
export class SimEngine {
  private bus: RedisBus;
  private cfg: TradeConfig["sim"];
  private positionSizerCfg: TradeConfig["positionSizer"];
  private account!: SimAccount;
  private journal!: TradeJournal;
  private matcher: SimMatchingEngine;
  private mtmTimer: ReturnType<typeof setInterval> | null = null;
  private fundingTimer: ReturnType<typeof setInterval> | null = null;
  private limitTimer: ReturnType<typeof setInterval> | null = null;
  private tradesLastIds = new Map<string, string>(); // streamKey -> last id
  private callbacks: SimEngineCallbacks;
  private running = false;

  constructor(
    bus: RedisBus,
    cfg: TradeConfig["sim"],
    positionSizerCfg: TradeConfig["positionSizer"],
    callbacks: SimEngineCallbacks = {},
  ) {
    this.bus = bus;
    this.cfg = cfg;
    this.positionSizerCfg = positionSizerCfg;
    this.matcher = new SimMatchingEngine(bus, cfg);
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.account = await SimAccount.load(this.bus, this.cfg.accountId, this.cfg.initialEquity);
    this.journal = new TradeJournal(this.bus, { mode: "sim", accountId: this.cfg.accountId });
    await this.journal.restore();

    // Initial publish so UI sees something on connect
    await this.markToMarket();

    this.mtmTimer = setInterval(() => {
      void this.markToMarket().catch((err) => logger.error({ err }, "MTM error"));
    }, this.cfg.markToMarketIntervalMs);

    // Limit-matcher polls md:trades for any symbol with a resting order. Cheap:
    // hash lookup → unique exchange:symbol pairs → XREAD per stream every 250ms.
    this.limitTimer = setInterval(() => {
      void this.matchLimitOrders().catch((err) => logger.error({ err }, "Limit matcher error"));
    }, 250);

    // Funding accrual — slow loop, applies funding payments to open perp positions.
    this.fundingTimer = setInterval(() => {
      void this.accrueFunding().catch((err) => logger.error({ err }, "Funding accrual error"));
    }, this.cfg.fundingIntervalMs);

    logger.info(
      {
        accountId: this.cfg.accountId,
        initialEquity: this.cfg.initialEquity,
        mtmIntervalMs: this.cfg.markToMarketIntervalMs,
      },
      "SimEngine started",
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.mtmTimer) { clearInterval(this.mtmTimer); this.mtmTimer = null; }
    if (this.limitTimer) { clearInterval(this.limitTimer); this.limitTimer = null; }
    if (this.fundingTimer) { clearInterval(this.fundingTimer); this.fundingTimer = null; }
    logger.info("SimEngine stopped");
  }

  getJournal(): TradeJournal {
    return this.journal;
  }

  getAccountId(): string {
    return this.cfg.accountId;
  }

  // ─── Account API ──────────────────────────────────────────────

  async getAccountSnapshot(): Promise<SimAccountSnapshot> {
    const open = this.journal.getOpenTrades();
    const unrealized = await this.computeUnrealized(open);
    const equity = this.account.cash + unrealized.total;
    return {
      ...this.account.snapshot,
      equity,
      unrealizedPnl: unrealized.total,
      openPositions: open.length,
    };
  }

  async resetAccount(initialEquity?: number): Promise<void> {
    // Wipe positions + open orders for this account, but keep historical journal stream
    const openHash = SimHashKeys.open(this.cfg.accountId);
    const ordersHash = SimHashKeys.openOrders(this.cfg.accountId);
    await Promise.all([this.bus.client.del(openHash), this.bus.client.del(ordersHash)]);

    await this.account.reset(initialEquity);
    // Rebuild journal in-memory state (keep persisted stream)
    this.journal = new TradeJournal(this.bus, { mode: "sim", accountId: this.cfg.accountId });
    await this.markToMarket();
  }

  // ─── Trading API ──────────────────────────────────────────────

  /**
   * Open a sim trade. Caller is expected to have run the position sizer beforehand
   * (so `request.amount` / SL / leverage are already filled in).
   * Performs market fill via matching engine; does NOT run pre-trade guard
   * (that's the caller's responsibility — see TradeExecutionService.openSimTrade).
   */
  async openMarket(request: OrderRequest, riskAmount: number): Promise<{ orderState: OrderState; trade: TradeRecord | null }> {
    const fill = await this.matcher.executeMarket({
      exchange: request.exchange,
      symbol: request.symbol,
      side: request.side,
      amount: request.amount,
    });

    const orderState = this.fillToOrderState(request, fill);

    if (!fill.filled || orderState.filledAmount <= 0) {
      logger.warn({ symbol: request.symbol, reason: fill.reason }, "Sim market not filled");
      return { orderState, trade: null };
    }

    // Charge fee (perps: notional doesn't lock cash, only fees & realized PnL move it)
    await this.account.chargeFee(orderState.fees);

    const trade = await this.journal.recordOpen(orderState, { riskAmount });
    return { orderState, trade };
  }

  async closeMarket(tradeId: string): Promise<{ orderState: OrderState; trade: TradeRecord | null }> {
    const trade = this.journal.getOpenTrade(tradeId);
    if (!trade) {
      logger.warn({ tradeId }, "Sim trade not found");
      return { orderState: emptyRejected("not_found"), trade: null };
    }

    const closeSide = trade.side === "long" ? "sell" : "buy";
    const baseAmount = trade.size / trade.entryPrice;

    const fill = await this.matcher.executeMarket({
      exchange: trade.exchange,
      symbol: trade.symbol,
      side: closeSide,
      amount: baseAmount,
    });

    const closeRequest: OrderRequest = {
      exchange: trade.exchange,
      symbol: trade.symbol,
      side: closeSide,
      type: "market",
      amount: baseAmount,
      strategy: "market",
      reduceOnly: true,
    };
    const orderState = this.fillToOrderState(closeRequest, fill);

    if (!fill.filled) {
      return { orderState, trade: null };
    }

    await this.account.chargeFee(orderState.fees);

    const closed = await this.journal.recordClose(tradeId, orderState.averagePrice, orderState.fees);
    if (closed?.realizedPnl !== null && closed?.realizedPnl !== undefined) {
      // realizedPnl already accounts for entry/exit price diff; fees charged separately above
      await this.account.applyRealizedPnl(closed.realizedPnl);
    }

    return { orderState, trade: closed };
  }

  // ─── Open limit order (Phase 2 hook) ─────────────────────────

  async placeLimit(order: SimOpenOrder): Promise<void> {
    await this.bus.client.hset(
      SimHashKeys.openOrders(this.cfg.accountId),
      order.id,
      JSON.stringify(order),
    );
  }

  async cancelLimit(orderId: string): Promise<boolean> {
    const removed = await this.bus.client.hdel(SimHashKeys.openOrders(this.cfg.accountId), orderId);
    return removed > 0;
  }

  /**
   * Poll md:trades streams for symbols with resting limit orders and try to fill.
   * The first time we touch each stream we resolve "$" → real id (same trick as
   * the gateway's RedisSubscriber) so we don't replay history.
   */
  private async matchLimitOrders(): Promise<void> {
    const ordersHash = SimHashKeys.openOrders(this.cfg.accountId);
    const all = await this.bus.client.hgetall(ordersHash);
    if (!all || Object.keys(all).length === 0) {
      // Nothing resting → also drop any stale lastIds to avoid leaking memory
      this.tradesLastIds.clear();
      return;
    }

    const orders = Object.values(all)
      .map((s) => { try { return JSON.parse(s) as SimOpenOrder; } catch { return null; } })
      .filter((o): o is SimOpenOrder => o !== null);

    // Group by stream
    const byStream = new Map<string, SimOpenOrder[]>();
    for (const o of orders) {
      const stream = `md:trades:${o.exchange}:${o.symbol}`;
      const arr = byStream.get(stream) ?? [];
      arr.push(o);
      byStream.set(stream, arr);
    }

    for (const [stream, symbolOrders] of byStream) {
      let lastId = this.tradesLastIds.get(stream);
      if (!lastId) {
        // Anchor at "now" — only fill against trades that occur AFTER the order rests
        const latest = await this.bus.client.xrevrange(stream, "+", "-", "COUNT", 1);
        lastId = latest.length > 0 ? (latest[0] as [string, string[]])[0] : "0-0";
        this.tradesLastIds.set(stream, lastId);
        continue;
      }

      const result = await this.bus.client.xread("COUNT", 50, "STREAMS", stream, lastId);
      if (!result) continue;

      for (const [, entries] of result as Array<[string, Array<[string, string[]]>]>) {
        for (const [id, fields] of entries) {
          this.tradesLastIds.set(stream, id);
          const dataIdx = fields.indexOf("data");
          if (dataIdx === -1) continue;
          let trade: { price?: number; amount?: number };
          try { trade = JSON.parse(fields[dataIdx + 1]!); } catch { continue; }
          if (!trade.price) continue;

          for (const order of symbolOrders) {
            const fill = this.matcher.matchLimitAgainstTrade({
              side: order.side,
              limitPrice: order.price,
              amount: order.amount,
              tradePrice: trade.price,
            });
            if (!fill) continue;

            await this.fillOpenLimit(order, fill);
            // Order is now closed, remove from list so we don't fill twice
            const idx = symbolOrders.indexOf(order);
            if (idx !== -1) symbolOrders.splice(idx, 1);
          }
        }
      }
    }
  }

  private async fillOpenLimit(order: SimOpenOrder, fill: SimFillResult): Promise<void> {
    // Remove from open orders
    await this.bus.client.hdel(SimHashKeys.openOrders(this.cfg.accountId), order.id);

    if (order.reduceOnly) {
      // Closing an existing position via limit — find the trade by symbol
      const opens = this.journal.getOpenTrades();
      const trade = opens.find((t) => t.exchange === order.exchange && t.symbol === order.symbol);
      if (!trade) {
        logger.warn({ orderId: order.id }, "Limit reduce-only filled but no matching position");
        return;
      }
      await this.account.chargeFee(fill.fees);
      const closed = await this.journal.recordClose(trade.id, fill.averagePrice, fill.fees);
      if (closed?.realizedPnl !== null && closed?.realizedPnl !== undefined) {
        await this.account.applyRealizedPnl(closed.realizedPnl);
      }
      return;
    }

    // Opening order: build the OrderState/Request as if it filled at market
    const request: OrderRequest = {
      exchange: order.exchange,
      symbol: order.symbol,
      side: order.side,
      type: "limit",
      amount: fill.filledAmount,
      price: order.price,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      strategy: "limit",
      leverage: order.leverage,
    };
    const orderState = this.fillToOrderState(request, fill);
    await this.account.chargeFee(orderState.fees);
    await this.journal.recordOpen(orderState, { riskAmount: order.riskAmount ?? 0 });
  }

  /** Apply funding payments to all open perp positions for the configured account. */
  private async accrueFunding(): Promise<void> {
    const open = this.journal.getOpenTrades();
    if (open.length === 0) return;

    const now = Date.now();
    for (const t of open) {
      const funding = await this.bus.getSnapshot<{ rate?: number; interval?: number }>(
        MdSnapshotKeys.funding(t.exchange, t.symbol),
      );
      if (!funding?.rate || !funding.interval) continue;

      const last = (t as TradeRecord & { lastFundingAccrualAt?: number }).lastFundingAccrualAt ?? t.openedAt;
      const elapsedMs = now - last;
      if (elapsedMs <= 0) continue;

      const intervalMs = funding.interval * 60 * 60 * 1000; // funding.interval is hours
      const fraction = elapsedMs / intervalMs;
      // long pays positive rate, short receives. notional ≈ size (USD value at entry)
      const sign = t.side === "long" ? 1 : -1;
      const delta = t.size * funding.rate * fraction * sign;
      if (Math.abs(delta) < 1e-6) continue;

      await this.journal.updateFunding(t.id, delta);
      await this.account.chargeFunding(delta);
      // Mark the position so we don't double-charge next tick
      const updated = { ...t, lastFundingAccrualAt: now };
      await this.bus.client.hset(SimHashKeys.open(this.cfg.accountId), t.id, JSON.stringify(updated));
    }
  }

  // ─── Mark-to-market loop ─────────────────────────────────────

  private async markToMarket(): Promise<void> {
    const open = this.journal.getOpenTrades();
    const unrealized = await this.computeUnrealized(open);
    const equity = this.account.cash + unrealized.total;
    await this.account.updatePeakAndDaily(equity);

    // Persist marks back into open hash so the UI sees uPnL on each position
    if (unrealized.byTrade.size > 0) {
      const openHash = SimHashKeys.open(this.cfg.accountId);
      const updates: string[] = [];
      for (const trade of open) {
        const u = unrealized.byTrade.get(trade.id);
        if (!u) continue;
        const enriched = { ...trade, markPrice: u.markPrice, unrealizedPnl: u.unrealizedPnl };
        updates.push(trade.id, JSON.stringify(enriched));
      }
      if (updates.length > 0) await this.bus.client.hset(openHash, ...updates);
    }

    const dd = this.computeDrawdown(equity);
    await Promise.all([
      this.publishExposure(equity, unrealized.total, unrealized.gross, unrealized.net, open.length),
      this.publishDrawdown(dd),
      this.publishEquityPoint(equity, unrealized.total),
      this.bus.client.set(SimSnapshotKeys.tradeBlocked(this.cfg.accountId), dd.isTradeBlocked ? "true" : "false"),
    ]);

    if (dd.currentLevel === "CRITICAL" || dd.currentLevel === "MAX_PEAK") {
      this.callbacks.onCritical?.(dd.currentLevel);
    }
  }

  private async computeUnrealized(open: TradeRecord[]): Promise<{
    total: number;
    gross: number;
    net: number;
    byTrade: Map<string, { markPrice: number; unrealizedPnl: number }>;
  }> {
    const byTrade = new Map<string, { markPrice: number; unrealizedPnl: number }>();
    let total = 0;
    let gross = 0;
    let net = 0;

    for (const t of open) {
      const ticker = await this.bus.getSnapshot<TickerSnapshot>(MdSnapshotKeys.ticker(t.exchange, t.symbol));
      const markPrice = ticker?.price ?? ticker?.last ?? t.entryPrice;
      const priceDiff = t.side === "long" ? markPrice - t.entryPrice : t.entryPrice - markPrice;
      const upnl = (priceDiff / t.entryPrice) * t.size;

      total += upnl;
      gross += t.size;
      net += t.side === "long" ? t.size : -t.size;
      byTrade.set(t.id, { markPrice, unrealizedPnl: upnl });
    }

    return { total, gross, net, byTrade };
  }

  private computeDrawdown(equity: number): SimDrawdownState {
    const peak = Math.max(this.account.peakEquity, equity);
    const dailyStart = this.account.dailyStartEquity || this.cfg.initialEquity;
    const dailyDDPct = dailyStart > 0 ? Math.max(0, ((dailyStart - equity) / dailyStart) * 100) : 0;
    const peakDDPct = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0;

    let level: SimDrawdownLevel = "NORMAL";
    if (peakDDPct >= this.cfg.drawdownMaxPeakPct) level = "MAX_PEAK";
    else if (dailyDDPct >= this.cfg.drawdownCriticalPct) level = "CRITICAL";
    else if (dailyDDPct >= this.cfg.drawdownDangerPct) level = "DANGER";
    else if (dailyDDPct >= this.cfg.drawdownWarningPct) level = "WARNING";

    const isTradeBlocked = level === "CRITICAL" || level === "MAX_PEAK";
    return {
      equity,
      peakEquity: peak,
      dailyDrawdownPct: dailyDDPct,
      peakDrawdownPct: peakDDPct,
      currentLevel: level,
      isTradeBlocked,
    };
  }

  private async publishExposure(
    equity: number,
    unrealized: number,
    grossExposure: number,
    netExposure: number,
    openPositions: number,
  ): Promise<void> {
    const exposureRatio = equity > 0 ? grossExposure / equity : 0;
    const snap = {
      equity,
      unrealizedPnl: unrealized,
      grossExposure,
      netExposure,
      exposureRatio,
      openPositions,
      accountId: this.cfg.accountId,
      mode: "sim" as const,
      timestamp: Date.now(),
    };
    await this.bus.setSnapshot(SimSnapshotKeys.exposure(this.cfg.accountId), snap);
    await this.bus.publish(SimStreamKeys.exposure, snap, SimStreamMaxLen.exposure);
  }

  private async publishDrawdown(dd: SimDrawdownState): Promise<void> {
    const payload = { ...dd, accountId: this.cfg.accountId, mode: "sim" as const, timestamp: Date.now() };
    await this.bus.setSnapshot(SimSnapshotKeys.drawdown(this.cfg.accountId), payload);
    await this.bus.publish(SimStreamKeys.drawdown, payload, SimStreamMaxLen.drawdown);
  }

  private async publishEquityPoint(equity: number, unrealizedPnl: number): Promise<void> {
    await this.bus.publish(
      SimStreamKeys.equity(this.cfg.accountId),
      { equity, unrealizedPnl, timestamp: Date.now() },
      SimStreamMaxLen.equity,
    );
  }

  private fillToOrderState(request: OrderRequest, fill: SimFillResult): OrderState {
    return {
      id: randomUUID(),
      request,
      status: fill.filled ? "filled" : "rejected",
      exchangeOrderIds: [],
      filledAmount: fill.filledAmount,
      averagePrice: fill.averagePrice,
      slippage: fill.slippagePct,
      fees: fill.fees,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // For caller code that wants to know sizer cfg without re-injecting it
  getPositionSizerConfig(): TradeConfig["positionSizer"] {
    return this.positionSizerCfg;
  }

  /** Expose a façade for sim-aware open-trade flow (used by service). */
  buildOpenTradeRequest(req: SimOpenTradeRequest, sizing: { positionSizeBase: number; stopLoss: number; leverage: number }): OrderRequest {
    return {
      exchange: req.exchange,
      symbol: req.symbol,
      side: req.side,
      type: req.strategy === "limit" ? "limit" : "market",
      amount: sizing.positionSizeBase,
      price: req.price,
      stopLoss: sizing.stopLoss,
      takeProfit: req.takeProfit,
      strategy: req.strategy ?? "market",
      leverage: sizing.leverage,
    };
  }
}

function emptyRejected(reason: string): OrderState {
  return {
    id: "",
    request: {} as OrderRequest,
    status: "rejected",
    exchangeOrderIds: [],
    filledAmount: 0,
    averagePrice: 0,
    slippage: 0,
    fees: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  void reason;
}
