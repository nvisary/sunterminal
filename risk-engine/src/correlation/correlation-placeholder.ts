import type { CorrelationMatrix } from "../types/risk.types.ts";
import pino from "pino";

const logger = pino({ name: "correlation" });

/**
 * Placeholder for P1 Correlation Matrix.
 * Recommended implementation: Python with numpy.corrcoef.
 */
export class CorrelationPlaceholder {
  start(): void {
    logger.warn("Correlation matrix not implemented -- recommended for Python (numpy.corrcoef)");
  }

  stop(): void {}

  getMatrix(): CorrelationMatrix {
    return {
      symbols: [],
      matrix: [],
      timeframe: "1h",
      periods: 100,
      timestamp: Date.now(),
    };
  }

  getCorrelation(_symbolA: string, _symbolB: string): number {
    return 0;
  }
}
