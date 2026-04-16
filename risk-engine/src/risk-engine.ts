import type {
  RiskEngineConfig,
  DrawdownState,
  PriceLevel,
  LiquidityZone,
  VolatilityData,
  VolatilityRegime,
  CorrelationMatrix,
  ExposureSnapshot,
  RiskSignal,
} from "./types/risk.types.ts";
import { RedisBus } from "./bus/redis-bus.ts";
import { SignalPublisher } from "./signal-bus/signal-publisher.ts";
import { MarketDataConsumer } from "./consumers/market-data-consumer.ts";
import { AccountPoller } from "./consumers/account-poller.ts";
import { DrawdownMonitor } from "./drawdown/drawdown-monitor.ts";
import { ExposureTracker } from "./exposure/exposure-tracker.ts";
import { VolatilityScanner } from "./volatility/volatility-scanner.ts";
import { LevelDetector } from "./levels/level-detector.ts";
import { AlertManager } from "./alerts/alert-manager.ts";
import { CorrelationPlaceholder } from "./correlation/correlation-placeholder.ts";
import pino from "pino";

const logger = pino({ name: "risk-engine" });

export class RiskEngine {
  private config: RiskEngineConfig;
  private bus: RedisBus;
  private publisher: SignalPublisher;
  private consumer: MarketDataConsumer;
  private poller: AccountPoller;
  private drawdown: DrawdownMonitor;
  private exposure: ExposureTracker;
  private volatility: VolatilityScanner;
  private levels: LevelDetector;
  private alerts: AlertManager;
  private correlation: CorrelationPlaceholder;

  constructor(config: RiskEngineConfig) {
    this.config = config;
    this.bus = new RedisBus(config.redis.url);
    this.publisher = new SignalPublisher(this.bus);

    // Consumers
    this.consumer = new MarketDataConsumer(this.bus);
    this.poller = new AccountPoller(this.bus, config.exchanges, config.pollIntervalMs);

    // Sub-modules
    this.drawdown = new DrawdownMonitor(this.bus, this.publisher, config.drawdown);
    this.exposure = new ExposureTracker(this.bus, this.publisher, config.exposure);
    this.volatility = new VolatilityScanner(this.bus, this.publisher, config.volatility, config.exchanges, config.symbols);
    this.levels = new LevelDetector(this.bus, this.publisher, config.levels, config.exchanges, config.symbols);
    this.alerts = new AlertManager(this.bus, config.alerts);
    this.correlation = new CorrelationPlaceholder();

    // Wire handlers
    this.consumer.onTrade((ex, sym, data) => this.volatility.onTrade(ex, sym, data));
    this.consumer.onOrderbook((ex, sym, data) => this.levels.onOrderbookUpdate(ex, sym, data));

    this.poller.onUpdate((snapshot) => {
      this.drawdown.onAccountUpdate(snapshot);
      this.exposure.onAccountUpdate(snapshot, this.drawdown.getCurrentEquity());
    });
  }

  async start(): Promise<void> {
    logger.info("Starting Risk Engine...");

    await this.bus.connect();

    // Restore persisted state
    await this.drawdown.restoreState();

    // Start sub-modules
    await this.consumer.start(this.config.exchanges, this.config.symbols);
    this.poller.start();
    this.drawdown.startDailyReset();
    this.volatility.start();
    this.levels.start();
    await this.alerts.start();
    this.correlation.start();

    logger.info(
      { exchanges: this.config.exchanges, symbols: this.config.symbols },
      "Risk Engine started"
    );
  }

  async stop(): Promise<void> {
    logger.info("Stopping Risk Engine...");

    this.consumer.stop();
    this.poller.stop();
    this.drawdown.stopDailyReset();
    this.volatility.stop();
    this.levels.stop();
    this.alerts.stop();
    this.correlation.stop();
    await this.bus.disconnect();

    logger.info("Risk Engine stopped");
  }

  // ═══════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════

  getCurrentEquity(): number {
    return this.drawdown.getCurrentEquity();
  }

  getDrawdownState(): DrawdownState {
    return this.drawdown.getState();
  }

  isTradeBlocked(): boolean {
    return this.drawdown.getIsTradeBlocked();
  }

  getLevels(exchange: string, symbol: string): PriceLevel[] {
    return this.levels.getLevels(exchange, symbol);
  }

  getLiquidityZones(exchange: string, symbol: string): LiquidityZone[] {
    return this.levels.getZones(exchange, symbol);
  }

  getNearestLevel(exchange: string, symbol: string, price: number): PriceLevel | null {
    return this.levels.getNearestLevel(exchange, symbol, price);
  }

  getVolatility(exchange: string, symbol: string): VolatilityData | null {
    return this.volatility.getVolatility(exchange, symbol);
  }

  getRegime(exchange: string, symbol: string): VolatilityRegime {
    return this.volatility.getRegime(exchange, symbol);
  }

  getCorrelationMatrix(): CorrelationMatrix {
    return this.correlation.getMatrix();
  }

  getCorrelation(symbolA: string, symbolB: string): number {
    return this.correlation.getCorrelation(symbolA, symbolB);
  }

  getExposure(): ExposureSnapshot | null {
    return this.exposure.getSnapshot();
  }

  getActiveAlerts(): RiskSignal[] {
    return this.alerts.getActiveAlerts();
  }

  acknowledgeAlert(id: string): void {
    this.alerts.acknowledgeAlert(id);
  }

  updateConfig(partial: Partial<RiskEngineConfig>): void {
    Object.assign(this.config, partial);
    logger.info("Config updated (runtime)");
  }
}
