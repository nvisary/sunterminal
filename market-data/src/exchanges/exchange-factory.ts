import ccxt, { type Exchange } from "ccxt";
import type { ExchangeConfig, ProExchange } from "../types/market-data.types.ts";
import pino from "pino";

const logger = pino({ name: "exchange-factory" });

/**
 * Creates a CCXT Pro exchange instance from config.
 */
export async function createExchange(cfg: ExchangeConfig): Promise<ProExchange> {
  const ExchangeClass = (ccxt.pro as Record<string, new (opts: object) => Exchange>)[cfg.ccxtClass];
  if (!ExchangeClass) {
    throw new Error(`Unknown CCXT exchange class: ${cfg.ccxtClass}`);
  }

  const options: Record<string, unknown> = {
    defaultType: cfg.type,
    watchOrderBook: { limit: cfg.orderbookDepth },
  };

  const exchangeOpts: Record<string, unknown> = {
    options,
    enableRateLimit: true,
  };

  if (cfg.apiKey) exchangeOpts.apiKey = cfg.apiKey;
  if (cfg.secret) exchangeOpts.secret = cfg.secret;
  if (cfg.passphrase) exchangeOpts.password = cfg.passphrase;
  if (cfg.sandbox) exchangeOpts.sandbox = true;

  const exchange = new ExchangeClass(exchangeOpts);

  if (cfg.sandbox) {
    exchange.setSandboxMode(true);
  }

  logger.info({ id: cfg.id, type: cfg.type, sandbox: cfg.sandbox }, "Exchange instance created");

  return exchange as unknown as ProExchange;
}
