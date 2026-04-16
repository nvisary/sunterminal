import type { PriceLevel } from "../types/risk.types.ts";

type OHLCV = [number, number, number, number, number, number];

const TIMEFRAME_STRENGTH: Record<string, number> = {
  "5m": 1,
  "15m": 2,
  "1h": 4,
  "4h": 8,
};

/**
 * Detect swing high/low levels from OHLCV candles.
 * A swing high: candle where high > high of N candles on each side.
 * A swing low: candle where low < low of N candles on each side.
 */
export function detectSwingLevels(
  candles: OHLCV[],
  lookback: number,
  timeframe: string,
  exchange: string,
  symbol: string
): PriceLevel[] {
  if (candles.length < lookback * 2 + 1) return [];

  const levels: PriceLevel[] = [];
  const strengthMultiplier = TIMEFRAME_STRENGTH[timeframe] ?? 1;
  const now = Date.now();

  for (let i = lookback; i < candles.length - lookback; i++) {
    const candle = candles[i]!;
    const high = candle[2];
    const low = candle[3];
    const timestamp = candle[0];

    // Check swing high
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]![2] >= high || candles[i + j]![2] >= high) {
        isSwingHigh = false;
        break;
      }
    }

    if (isSwingHigh) {
      levels.push({
        price: high,
        type: "resistance",
        source: "swing",
        strength: strengthMultiplier,
        timeframe,
        touches: 1,
        lastTouchTime: timestamp,
        isSuspectedSpoof: false,
        exchange,
        symbol,
      });
    }

    // Check swing low
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j]![3] <= low || candles[i + j]![3] <= low) {
        isSwingLow = false;
        break;
      }
    }

    if (isSwingLow) {
      levels.push({
        price: low,
        type: "support",
        source: "swing",
        strength: strengthMultiplier,
        timeframe,
        touches: 1,
        lastTouchTime: timestamp,
        isSuspectedSpoof: false,
        exchange,
        symbol,
      });
    }
  }

  // Count touches: how many times price came within 0.1% of each level
  for (const level of levels) {
    let touches = 0;
    for (const candle of candles) {
      const low = candle[3];
      const high = candle[2];
      if (
        Math.abs(high - level.price) / level.price < 0.001 ||
        Math.abs(low - level.price) / level.price < 0.001
      ) {
        touches++;
      }
    }
    level.touches = touches;
    level.strength *= Math.min(touches, 5); // Boost by touch count (capped)
  }

  return levels;
}

/**
 * Cluster swing levels across multiple timeframes.
 * Merge levels within tolerance, sum strengths.
 */
export function mergeSwingLevels(
  allLevels: PriceLevel[],
  tolerance: number
): PriceLevel[] {
  if (allLevels.length === 0) return [];

  const sorted = [...allLevels].sort((a, b) => a.price - b.price);
  const merged: PriceLevel[] = [];

  let current = { ...sorted[0]! };

  for (let i = 1; i < sorted.length; i++) {
    const level = sorted[i]!;
    const priceDiff = Math.abs(level.price - current.price) / current.price;

    if (priceDiff <= tolerance && level.type === current.type) {
      // Merge: keep highest strength, sum touches, weighted price
      current.strength += level.strength;
      current.touches = Math.max(current.touches, level.touches);
      current.lastTouchTime = Math.max(current.lastTouchTime, level.lastTouchTime);
      // Use price from higher timeframe (higher strength)
      if (level.strength > current.strength / 2) {
        current.price = level.price;
      }
    } else {
      merged.push(current);
      current = { ...level };
    }
  }
  merged.push(current);

  return merged;
}
