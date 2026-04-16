import type { ExchangeConfig, ProExchange, ConnectorStatus } from "../types/market-data.types.ts";
import { createExchange } from "./exchange-factory.ts";
import pino from "pino";

const logger = pino({ name: "exchange-manager" });

/**
 * Manages CCXT Pro exchange instances: lifecycle, market loading, status tracking.
 */
export class ExchangeManager {
  private exchanges = new Map<string, ProExchange>();
  private configs = new Map<string, ExchangeConfig>();
  private statuses = new Map<string, ConnectorStatus>();

  async addExchange(cfg: ExchangeConfig): Promise<void> {
    if (this.exchanges.has(cfg.id)) {
      logger.warn({ id: cfg.id }, "Exchange already registered");
      return;
    }

    this.statuses.set(cfg.id, "connecting");

    try {
      const exchange = await createExchange(cfg);
      await exchange.loadMarkets();

      this.exchanges.set(cfg.id, exchange);
      this.configs.set(cfg.id, cfg);
      this.statuses.set(cfg.id, "connected");

      const marketCount = Object.keys(exchange.markets).length;
      logger.info({ id: cfg.id, markets: marketCount }, "Exchange connected, markets loaded");
    } catch (err) {
      this.statuses.set(cfg.id, "error");
      logger.error({ id: cfg.id, err }, "Failed to initialize exchange");
      throw err;
    }
  }

  getExchange(id: string): ProExchange {
    const exchange = this.exchanges.get(id);
    if (!exchange) throw new Error(`Exchange not found: ${id}`);
    return exchange;
  }

  getConfig(id: string): ExchangeConfig {
    const cfg = this.configs.get(id);
    if (!cfg) throw new Error(`Exchange config not found: ${id}`);
    return cfg;
  }

  getStatus(id: string): ConnectorStatus {
    return this.statuses.get(id) ?? "stopped";
  }

  setStatus(id: string, status: ConnectorStatus): void {
    this.statuses.set(id, status);
  }

  getStatuses(): Map<string, ConnectorStatus> {
    return new Map(this.statuses);
  }

  getExchangeIds(): string[] {
    return [...this.exchanges.keys()];
  }

  hasExchange(id: string): boolean {
    return this.exchanges.has(id);
  }

  async closeAll(): Promise<void> {
    const closers = [...this.exchanges.entries()].map(async ([id, exchange]) => {
      try {
        await exchange.close();
        this.statuses.set(id, "stopped");
        logger.info({ id }, "Exchange closed");
      } catch (err) {
        logger.error({ id, err }, "Error closing exchange");
      }
    });
    await Promise.all(closers);
    this.exchanges.clear();
    this.configs.clear();
  }
}
