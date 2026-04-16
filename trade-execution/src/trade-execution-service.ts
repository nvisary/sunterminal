import type {
  TradeConfig,
  OrderRequest,
  OrderState,
  PositionSizeResult,
  TradeRecord,
  PnLStats,
  EquityPoint,
} from "./types/trade.types.ts";
import { RedisBus } from "./bus/redis-bus.ts";
import { PositionSizer } from "./position-sizer/position-sizer.ts";
import { PreTradeGuard } from "./guards/pre-trade-guard.ts";
import { OrderManager } from "./smart-order/order-manager.ts";
import { TradeJournal } from "./journal/trade-journal.ts";
import { ExchangeRouter } from "./router/exchange-router.ts";
import pino from "pino";

const logger = pino({ name: "trade-execution" });

export class TradeExecutionService {
  private config: TradeConfig;
  private bus: RedisBus;
  private sizer: PositionSizer;
  private guard: PreTradeGuard;
  private orderManager: OrderManager;
  private journal: TradeJournal;
  private router: ExchangeRouter;

  constructor(config: TradeConfig) {
    this.config = config;
    this.bus = new RedisBus(config.redis.url);
    this.sizer = new PositionSizer(this.bus, config.positionSizer);
    this.journal = new TradeJournal(this.bus);
    this.guard = new PreTradeGuard(
      this.bus,
      config.guards,
      config.positionSizer,
      () => this.journal.getOpenTradeCount()
    );
    this.orderManager = new OrderManager(this.bus, config.smartOrder);
    this.router = new ExchangeRouter();
  }

  async start(): Promise<void> {
    logger.info("Starting Trade Execution Service...");
    await this.bus.connect();
    this.router.start();

    logger.info(
      {
        riskPerTrade: this.config.positionSizer.riskPerTrade,
        maxPosition: this.config.positionSizer.maxPositionUSD,
        maxOpen: this.config.positionSizer.maxOpenPositions,
        leverage: this.config.positionSizer.defaultLeverage,
        defaultStrategy: this.config.smartOrder.defaultStrategy,
      },
      "Trade Execution Service started"
    );
  }

  async stop(): Promise<void> {
    logger.info("Stopping Trade Execution Service...");
    this.router.stop();
    await this.bus.disconnect();
    logger.info("Trade Execution Service stopped");
  }

  // ═══════════════════════════════════════════════════════════════
  // Open Trade
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
    price?: number; // For limit orders
  }): Promise<OrderState> {
    // 1. Calculate position size
    const sizing = await this.sizer.calculate({
      exchange: params.exchange,
      symbol: params.symbol,
      side: params.side,
      stopLoss: params.stopLoss,
      takeProfit: params.takeProfit,
      leverage: params.leverage,
      riskPercent: params.riskPercent,
    });

    if (sizing.positionSizeBase <= 0) {
      logger.error({ warnings: sizing.warnings }, "Position size is 0, cannot open trade");
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
    }

    // 2. Build order request
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

    // 3. Pre-trade guard
    const guardResult = await this.guard.check(request);

    if (!guardResult.allowed) {
      logger.warn({ blocks: guardResult.blocks }, "Trade rejected by pre-trade guard");
      return {
        id: "",
        request,
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

    if (guardResult.warnings.length > 0) {
      logger.warn({ warnings: guardResult.warnings.map((w) => w.message) }, "Trade warnings");
    }

    // 4. Execute order
    const orderState = await this.orderManager.execute(request);

    // 5. Record in journal if filled
    if (orderState.status === "filled" || orderState.status === "partial") {
      await this.journal.recordOpen(orderState);
    }

    return orderState;
  }

  // ═══════════════════════════════════════════════════════════════
  // Close Positions
  // ═══════════════════════════════════════════════════════════════

  async closeTrade(tradeId: string): Promise<OrderState | null> {
    const openTrades = this.journal.getOpenTrades();
    const trade = openTrades.find((t) => t.id === tradeId);
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
      await this.journal.recordClose(tradeId, orderState.averagePrice, orderState.fees);
    }

    return orderState;
  }

  async closeAll(exchange?: string): Promise<OrderState[]> {
    const openTrades = this.journal.getOpenTrades();
    const toClose = exchange ? openTrades.filter((t) => t.exchange === exchange) : openTrades;

    const results: OrderState[] = [];
    for (const trade of toClose) {
      const result = await this.closeTrade(trade.id);
      if (result) results.push(result);
    }
    return results;
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
  }): Promise<PositionSizeResult> {
    return this.sizer.calculate(params);
  }

  // ═══════════════════════════════════════════════════════════════
  // Journal
  // ═══════════════════════════════════════════════════════════════

  getOpenTrades(): TradeRecord[] {
    return this.journal.getOpenTrades();
  }

  getTradeHistory(): TradeRecord[] {
    return this.journal.getClosedTrades();
  }

  getStats(period?: string): PnLStats {
    return this.journal.getStats(period);
  }

  getEquityCurve(): EquityPoint[] {
    return this.journal.getEquityCurve();
  }

  addTradeNotes(tradeId: string, notes: string, tags: string[]): void {
    this.journal.addNotes(tradeId, notes, tags);
  }

  // ═══════════════════════════════════════════════════════════════
  // Config
  // ═══════════════════════════════════════════════════════════════

  updateConfig(partial: Partial<TradeConfig>): void {
    Object.assign(this.config, partial);
    logger.info("Config updated");
  }
}
