/**
 * Pure functions for position size / risk calculations.
 */

export interface SizeParams {
  equity: number;
  riskPerTrade: number;      // % (e.g. 1)
  entryPrice: number;
  stopLossPrice: number;
  leverage: number;
  maxPositionUSD: number;
  marginReserve: number;     // % of free balance to keep
  freeBalance: number;
}

export interface SizeResult {
  positionSizeUSD: number;
  positionSizeBase: number;
  riskAmount: number;
  stopDistance: number;       // as fraction (e.g. 0.0045)
  requiredMargin: number;
  leverage: number;
  capped: boolean;           // true if capped to maxPositionUSD
  marginOk: boolean;         // true if margin fits free balance
}

export function calculatePositionSize(params: SizeParams): SizeResult {
  const { equity, riskPerTrade, entryPrice, stopLossPrice, leverage, maxPositionUSD, marginReserve, freeBalance } = params;

  const riskAmount = equity * (riskPerTrade / 100);
  const stopDistance = Math.abs(entryPrice - stopLossPrice) / entryPrice;

  let positionSizeUSD = stopDistance > 0 ? riskAmount / stopDistance : 0;
  let capped = false;

  // Cap to max
  if (positionSizeUSD > maxPositionUSD) {
    positionSizeUSD = maxPositionUSD;
    capped = true;
  }

  const positionSizeBase = entryPrice > 0 ? positionSizeUSD / entryPrice : 0;
  const requiredMargin = positionSizeUSD / leverage;
  const availableMargin = freeBalance * (1 - marginReserve / 100);
  const marginOk = requiredMargin <= availableMargin;

  return {
    positionSizeUSD,
    positionSizeBase,
    riskAmount,
    stopDistance,
    requiredMargin,
    leverage,
    capped,
    marginOk,
  };
}

/**
 * Calculate auto-stop price from ATR.
 */
export function calculateAutoStop(
  entryPrice: number,
  atr: number,
  atrMultiplier: number,
  side: "buy" | "sell"
): number {
  const distance = atr * atrMultiplier;
  // Buy (long) → stop below entry
  // Sell (short) → stop above entry
  return side === "buy" ? entryPrice - distance : entryPrice + distance;
}

/**
 * Calculate risk-reward ratio.
 */
export function calculateRiskReward(
  entryPrice: number,
  stopLoss: number,
  takeProfit: number
): number {
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(takeProfit - entryPrice);
  return risk > 0 ? reward / risk : 0;
}
