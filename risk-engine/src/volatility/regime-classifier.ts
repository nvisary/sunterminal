import type { VolatilityRegime } from "../types/risk.types.ts";

interface RegimeThresholds {
  low: number;   // percentile (default 25)
  high: number;  // percentile (default 75)
  extreme: number; // percentile (default 95)
}

const DEFAULT_THRESHOLDS: RegimeThresholds = { low: 25, high: 75, extreme: 95 };

/**
 * Classify volatility regime based on where current ATR% sits
 * in the historical distribution.
 */
export function classifyRegime(
  currentAtrPct: number,
  history: number[],
  thresholds: RegimeThresholds = DEFAULT_THRESHOLDS
): { regime: VolatilityRegime; percentile: number } {
  if (history.length === 0) {
    return { regime: "NORMAL", percentile: 50 };
  }

  const sorted = [...history].sort((a, b) => a - b);
  const percentile = computePercentile(sorted, currentAtrPct);

  let regime: VolatilityRegime;
  if (percentile < thresholds.low) {
    regime = "LOW_VOL";
  } else if (percentile >= thresholds.extreme) {
    regime = "EXTREME_VOL";
  } else if (percentile >= thresholds.high) {
    regime = "HIGH_VOL";
  } else {
    regime = "NORMAL";
  }

  return { regime, percentile };
}

/**
 * Compute percentile rank of value within a sorted array.
 * Returns 0–100.
 */
function computePercentile(sorted: number[], value: number): number {
  let count = 0;
  for (const v of sorted) {
    if (v < value) count++;
    else break;
  }
  return (count / sorted.length) * 100;
}
