import pino from "pino";

const logger = pino({ name: "delta-neutral" });

/**
 * Delta Neutral Strategy — P1 placeholder.
 * Maintains net delta ~ 0 to profit from funding without directional risk.
 * Requires spot + futures on same exchange or cross-exchange.
 */
export class DeltaNeutralStrategy {
  start(): void {
    logger.warn("Delta Neutral strategy not implemented (P1) -- requires spot + futures positions");
  }

  stop(): void {}
}
