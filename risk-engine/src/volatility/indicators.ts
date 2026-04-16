/**
 * Pure calculation functions for volatility indicators.
 * No side effects, no Redis, no logging.
 */

type OHLCV = [number, number, number, number, number, number]; // [timestamp, open, high, low, close, volume]

/**
 * Average True Range (ATR).
 * TR = max(high - low, |high - prevClose|, |low - prevClose|)
 * ATR = SMA(TR, period)
 */
export function computeATR(candles: OHLCV[], period: number): number {
  if (candles.length < period + 1) return 0;

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i]![2];
    const low = candles[i]![3];
    const prevClose = candles[i - 1]![4];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  // SMA of last `period` true ranges
  const recent = trueRanges.slice(-period);
  return recent.reduce((sum, v) => sum + v, 0) / recent.length;
}

/**
 * ATR as percentage of the last close price.
 */
export function computeATRPercent(atr: number, close: number): number {
  if (close === 0) return 0;
  return (atr / close) * 100;
}

/**
 * Historical volatility (annualized).
 * Stddev of log returns over `period` candles, annualized.
 */
export function computeHistoricalVol(
  candles: OHLCV[],
  period: number,
  timeframeHours: number = 1
): number {
  if (candles.length < period + 1) return 0;

  const closes = candles.slice(-(period + 1)).map((c) => c[4]);
  const logReturns: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1]! > 0 && closes[i]! > 0) {
      logReturns.push(Math.log(closes[i]! / closes[i - 1]!));
    }
  }

  if (logReturns.length === 0) return 0;

  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / logReturns.length;
  const stddev = Math.sqrt(variance);

  // Annualize: multiply by sqrt(periods_per_year)
  const periodsPerYear = (365 * 24) / timeframeHours;
  return stddev * Math.sqrt(periodsPerYear);
}

/**
 * Realtime volatility from tick prices.
 * Stddev of log returns across the tick buffer (not annualized).
 */
export function computeRealtimeVol(prices: number[]): number {
  if (prices.length < 2) return 0;

  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0 && prices[i]! > 0) {
      logReturns.push(Math.log(prices[i]! / prices[i - 1]!));
    }
  }

  if (logReturns.length === 0) return 0;

  const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
  const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance);
}
