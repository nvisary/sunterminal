import type {
  TradeConfig,
  OrderRequest,
  OrderState,
  PositionSizeResult,
  TradeRecord,
  PnLStats,
  EquityPoint,
  TradeMode,
} from "./types/trade.types.ts";
import type { SimAccountSnapshot, SimOpenTradeRequest } from "./types/sim.types.ts";
import { RedisBus } from "./bus/redis-bus.ts";
import { CmdConsumer } from "./bus/cmd-consumer.ts";
import { CmdStreamKeys } from "./bus/channels.ts";
import { PositionSizer } from "./position-sizer/position-sizer.ts";
import { PreTradeGuard } from "./guards/pre-trade-guard.ts";
import { OrderManager } from "./smart-order/order-manager.ts";
import { TradeJournal } from "./journal/trade-journal.ts";
import { ExchangeRouter } from "./router/exchange-router.ts";
import { SimEngine } from "./sim/sim-engine.ts";
import pino from "pino";

const logger = pino({ name: "trade-execution" });

export class TradeExecutionService {
  private config: TradeConfig;
  private bus: RedisBus;
  private sizer: PositionSizer;
  private guard: PreTradeGuard;
  private orderManager: OrderManager;
  private liveJournal: TradeJournal;
  private router: ExchangeRouter;
  private simEngine: SimEngine;
  private cmdConsumer: CmdConsumer;

  constructor(config: TradeConfig) {
    this.config = config;
    this.bus = new RedisBus(config.redis.url);
    this.sizer = new PositionSizer(this.bus, config.positionSizer);
    this.liveJournal = new TradeJournal(this.bus, { mode: "live", accountId: "live" });
    this.simEngine = new SimEngine(this.bus, config.sim, config.positionSizer);
    this.guard = new PreTradeGuard(
      this.bus,
      config.guards,
      config.positionSizer,
      (mode, accountId) => {
        if (mode === "live") return this.liveJournal.getOpenTradeCount();
        if (accountId === this.simEngine.getAccountId()) return this.simEngine.getJournal().getOpenTradeCount();
        return 0;
      },
    );
    this.orderManager = new OrderManager(this.bus, config.smartOrder);
    this.router = new ExchangeRouter();
    this.cmdConsumer = new CmdConsumer(this.bus);
  }

  async start(): Promise<void> {
    logger.info("Starting Trade Execution Service...");
    await this.bus.connect();
    this.router.start();
    await this.liveJournal.restore();
    await this.simEngine.start();

    this.registerCmdHandlers();
    await this.cmdConsumer.start();

    logger.info(
      {
        riskPerTrade: this.config.positionSizer.riskPerTrade,
        maxPosition: this.config.positionSizer.maxPositionUSD,
        maxOpen: this.config.positionSizer.maxOpenPositions,
        leverage: this.config.positionSizer.defaultLeverage,
        defaultStrategy: this.config.smartOrder.defaultStrategy,
        simAccount: this.config.sim.accountId,
        simInitialEquity: this.config.sim.initialEquity,
      },
      "Trade Execution Service started"
    );
  }

  async stop(): Promise<void> {
    logger.info("Stopping Trade Execution Service...");
    await this.cmdConsumer.stop();
    await this.simEngine.stop();
    this.router.stop();
    await this.bus.disconnect();
    logger.info("Trade Execution Service stopped");
  }

  // ═══════════════════════════════════════════════════════════════
  // Cmd handlers — bridge gateway commands to in-process methods
  // ═══════════════════════════════════════════════════════════════

  private registerCmdHandlers(): void {
    this.cmdConsumer.on(CmdStreamKeys.tradeOpen, async (data) => {
      // Live trading wiring placeholder — currently performs a real openTrade,
      // but ccxt-side execution requires API keys. Calling without them logs an
      // error inside the strategy and returns a rejected order, which is fine.
      try {
        await this.openTrade(data as Parameters<TradeExecutionService["openTrade"]>[0]);
      } catch (err) {
        logger.error({ err }, "live openTrade failed");
      }
    });
    this.cmdConsumer.on(CmdStreamKeys.tradeClose, async (data) => {
      const { tradeId } = data as { tradeId: string };
      if (tradeId) await this.closeTrade(tradeId);
    });
    this.cmdConsumer.on(CmdStreamKeys.tradeCloseAll, async (data) => {
      const { exchange } = data as { exchange?: string };
      await this.closeAll(exchange);
    });
    this.cmdConsumer.on(CmdStreamKeys.tradeCalcSize, async () => {
      // Calc-size is a query, not a state mutation. UI uses sync REST instead.
    });

    this.cmdConsumer.on(CmdStreamKeys.simOpen, async (data) => {
      try {
        await this.openSimTrade(data as unknown as SimOpenTradeRequest);
      } catch (err) {
        logger.error({ err }, "sim openTrade failed");
      }
    });
    this.cmdConsumer.on(CmdStreamKeys.simClose, async (data) => {
      const { tradeId } = data as { tradeId: string };
      if (tradeId) await this.closeSimTrade(tradeId);
    });
    this.cmdConsumer.on(CmdStreamKeys.simCloseAll, async () => {
      const open = this.simEngine.getJournal().getOpenTrades();
      for (const t of open) {
        await this.closeSimTrade(t.id);
      }
    });
    this.cmdConsumer.on(CmdStreamKeys.simReset, async (data) => {
      const { initialEquity } = data as { initialEquity?: number };
      await this.simEngine.resetAccount(initialEquity);
    });
    this.cmdConsumer.on(CmdStreamKeys.simConfig, async (data) => {
      // Persist runtime overrides into config:sim so UI sees them after refresh
      // and so subsequent restarts can read them. We don't reload SimEngine here
      // (Phase 2: hot-reload). Settings panel applies them via reset which uses
      // the new initialEquity.
      await this.bus.client.set("sim:config", JSON.stringify(data));
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // Open Trade (LIVE)
  // ═══════════════════════════════════════════════════════════════

  async openTrade(params: {
    exchange: string;
    symbol: string;
    side: "buy" | "sell";
    stopLoss?: number;
    takeProfit?: number;
    riskPercent?: number;
    leverage?: number;
    strategy?: "market" | "limit" | "twap" | "iceberg";
    price?: number;
  }): Promise<OrderState> {
    const sizing = await this.sizer.calculate({
      exchange: params.exchange,
      symbol: params.symbol,
      side: params.side,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      leverage: params.leverage,
      riskPercent: params.riskPercent,
      mode: "live",
    });

    if (sizing.positionSizeBase <= 0) {
      logger.error({ warnings: sizing.warnings }, "Position size is 0, cannot open trade");
      return rejected();
    }

    const request: OrderRequest = {
      exchange: params.exchange,
      symbol: params.symbol,
      side: params.side,
      type: (params.strategy === "limit" || (!params.strategy && this.config.smartOrder.defaultStrategy === "limit")) ? "limit" : "market",
      amount: sizing.positionSizeBase,
      price: params.price,
      stopLoss: sizing.stopLoss,
      takeProfit: params.takeProfit,
      strategy: params.strategy ?? this.config.smartOrder.defaultStrategy,
      leverage: sizing.leverage,
    };

    const guardResult = await this.guard.check(request, {
      mode: "live",
      accountId: "live",
      requiredMarginUSD: sizing.requiredMargin,
    });

    if (!guardResult.allowed) {
      logger.warn({ blocks: guardResult.blocks }, "Trade rejected by pre-trade guard");
      return rejected(request);
    }

    if (guardResult.warnings.length > 0) {
      logger.warn({ warnings: guardResult.warnings.map((w) => w.message) }, "Trade warnings");
    }

    const orderState = await this.orderManager.execute(request);

    if (orderState.status === "filled" || orderState.status === "partial") {
      await this.liveJournal.recordOpen(orderState, { riskAmount: sizing.riskAmount });
    }

    return orderState;
  }

  async closeTrade(tradeId: string): Promise<OrderState | null> {
    const trade = this.liveJournal.getOpenTrade(tradeId);
    if (!trade) {
      logger.warn({ tradeId }, "Trade not found");
      return null;
    }

    const closeSide = trade.side === "long" ? "sell" : "buy";
    const amount = trade.size / trade.entryPrice;

    const request: OrderRequest = {
      exchange: trade.exchange,
      symbol: trade.symbol,
      side: closeSide as "buy" | "sell",
      type: "market",
      amount,
      strategy: "market",
      reduceOnly: true,
    };

    const orderState = await this.orderManager.execute(request);

    if (orderState.status === "filled") {
      await this.liveJournal.recordClose(tradeId, orderState.averagePrice, orderState.fees);
    }

    return orderState;
  }

  async closeAll(exchange?: string): Promise<OrderState[]> {
    const openTrades = this.liveJournal.getOpenTrades();
    const toClose = exchange ? openTrades.filter((t) => t.exchange === exchange) : openTrades;

    const results: OrderState[] = [];
    for (const trade of toClose) {
      const result = await this.closeTrade(trade.id);
      if (result) results.push(result);
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════
  // Open Trade (SIM)
  // ═══════════════════════════════════════════════════════════════

  async openSimTrade(req: SimOpenTradeRequest): Promise<OrderState> {
    const accountId = req.accountId || this.simEngine.getAccountId();

    const sizing = await this.sizer.calculate({
      exchange: req.exchange,
      symbol: req.symbol,
      side: req.side,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      leverage: req.leverage,
      riskPercent: req.riskPercent,
      mode: "sim",
      accountId,
    });

    if (sizing.positionSizeBase <= 0) {
      logger.error({ warnings: sizing.warnings }, "Sim position size is 0");
      return rejected();
    }

    const orderRequest = this.simEngine.buildOpenTradeRequest(req, {
      positionSizeBase: sizing.positionSizeBase,
      stopLoss: sizing.stopLoss,
      leverage: sizing.leverage,
    });

    const sim = await this.simEngine.getAccountSnapshot();
    const guardResult = await this.guard.check(orderRequest, {
      mode: "sim",
      accountId,
      freeBalanceUSD: sim.cashUSDT,
      requiredMarginUSD: sizing.requiredMargin,
    });

    if (!guardResult.allowed) {
      logger.warn({ blocks: guardResult.blocks }, "Sim trade rejected by pre-trade guard");
      return rejected(orderRequest);
    }

    if (orderRequest.strategy === "limit") {
      if (!req.price) {
        logger.warn({ symbol: req.symbol }, "Sim limit order requires price");
        return rejected(orderRequest);
      }
      const { randomUUID } = await import("node:crypto");
      const orderId = randomUUID();
      await this.simEngine.placeLimit({
        id: orderId,
        accountId,
        exchange: req.exchange,
        symbol: req.symbol,
        side: req.side,
        price: req.price,
        amount: sizing.positionSizeBase,
        reduceOnly: false,
        stopLoss: sizing.stopLoss,
        takeProfit: sizing.takeProfit,
        leverage: sizing.leverage,
        riskAmount: sizing.riskAmount,
        createdAt: Date.now(),
      });
      // Return a synthetic "pending" order state — fill arrives async via matcher
      return {
        id: orderId,
        request: orderRequest,
        status: "pending",
        exchangeOrderIds: [],
        filledAmount: 0,
        averagePrice: 0,
        slippage: 0,
        fees: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    const { orderState } = await this.simEngine.openMarket(orderRequest, sizing.riskAmount);
    return orderState;
  }

  async closeSimTrade(tradeId: string): Promise<OrderState | null> {
    const { orderState } = await this.simEngine.closeMarket(tradeId);
    return orderState;
  }

  async getSimAccount(): Promise<SimAccountSnapshot> {
    return this.simEngine.getAccountSnapshot();
  }

  async resetSimAccount(initialEquity?: number): Promise<void> {
    await this.simEngine.resetAccount(initialEquity);
  }

  // ═══════════════════════════════════════════════════════════════
  // Position Sizer (preview)
  // ═══════════════════════════════════════════════════════════════

  async calculateSize(params: {
    exchange: string;
    symbol: string;
    side: "buy" | "sell";
    stopLoss?: number;
    leverage?: number;
    mode?: TradeMode;
    accountId?: string;
  }): Promise<PositionSizeResult> {
    return this.sizer.calculate(params);
  }

  // ═══════════════════════════════════════════════════════════════
  // Journal
  // ═══════════════════════════════════════════════════════════════

  getOpenTrades(mode: TradeMode = "live"): TradeRecord[] {
    return mode === "live"
      ? this.liveJournal.getOpenTrades()
      : this.simEngine.getJournal().getOpenTrades();
  }

  getTradeHistory(mode: TradeMode = "live"): TradeRecord[] {
    return mode === "live"
      ? this.liveJournal.getClosedTrades()
      : this.simEngine.getJournal().getClosedTrades();
  }

  getStats(period?: string, mode: TradeMode = "live"): PnLStats {
    return mode === "live"
      ? this.liveJournal.getStats(period)
      : this.simEngine.getJournal().getStats(period);
  }

  getEquityCurve(mode: TradeMode = "live"): EquityPoint[] {
    return mode === "live"
      ? this.liveJournal.getEquityCurve()
      : this.simEngine.getJournal().getEquityCurve();
  }

  addTradeNotes(tradeId: string, notes: string, tags: string[], mode: TradeMode = "live"): void {
    if (mode === "live") this.liveJournal.addNotes(tradeId, notes, tags);
    else this.simEngine.getJournal().addNotes(tradeId, notes, tags);
  }

  // ═══════════════════════════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════════════════════════

  updateConfig(partial: Partial<TradeConfig>): void {
    Object.assign(this.config, partial);
    logger.info("Config updated");
  }
}

function rejected(request?: OrderRequest): OrderState {
  return {
    id: "",
    request: (request ?? {}) as OrderRequest,
    status: "rejected",
    exchangeOrderIds: [],
    filledAmount: 0,
    averagePrice: 0,
    slippage: 0,
    fees: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
