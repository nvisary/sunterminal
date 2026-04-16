import type { TradeRecord, PnLStats } from "../types/trade.types.ts";

export function calculatePnLStats(trades: TradeRecord[], period: string = "all"): PnLStats {
  const closed = trades.filter((t) => t.closedAt !== null && t.realizedPnl !== null);

  const wins = closed.filter((t) => (t.netPnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.netPnl ?? 0) <= 0);

  const totalPnl = closed.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const totalFees = closed.reduce((s, t) => s + t.fees, 0);
  const totalFunding = closed.reduce((s, t) => s + t.fundingPaid, 0);
  const netPnl = totalPnl - totalFees - totalFunding;

  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.netPnl ?? 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.netPnl ?? 0), 0) / losses.length) : 0;

  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const profitFactor = avgLoss > 0
    ? wins.reduce((s, t) => s + (t.netPnl ?? 0), 0) / Math.abs(losses.reduce((s, t) => s + (t.netPnl ?? 0), 0) || 1)
    : wins.length > 0 ? Infinity : 0;

  const loseRate = closed.length > 0 ? losses.length / closed.length : 0;
  const expectancy = (winRate / 100) * avgWin - loseRate * avgLoss;

  // Max consecutive losses
  let maxStreak = 0;
  let currentStreak = 0;
  for (const t of closed) {
    if ((t.netPnl ?? 0) <= 0) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  const avgSlippage = closed.length > 0
    ? closed.reduce((s, t) => s + Math.abs(t.slippage), 0) / closed.length
    : 0;

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    expectancy,
    maxConsecutiveLosses: maxStreak,
    totalPnl,
    totalFees,
    totalFunding,
    netPnl,
    avgSlippage,
    period,
  };
}
