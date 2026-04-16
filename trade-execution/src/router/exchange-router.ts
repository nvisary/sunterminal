import pino from "pino";

const logger = pino({ name: "exchange-router" });

/**
 * Exchange Router — P1 placeholder.
 * In MVP, user manually selects exchange.
 */
export class ExchangeRouter {
  start(): void {
    logger.warn("Exchange Router not implemented (P1) -- user must select exchange manually");
  }

  stop(): void {}

  selectExchange(_symbol: string, _side: "buy" | "sell"): string | null {
    return null; // User must specify
  }
}
