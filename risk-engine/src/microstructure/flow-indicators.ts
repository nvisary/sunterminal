/**
 * Microstructural flow indicators.
 * Calculations based on orderbook dynamics.
 */

export interface OrderbookSnapshot {
  bids: number[][]; // [price, amount][]
  asks: number[][];
}

export interface OFIState {
  prevBestBid: number;
  prevBestBidVol: number;
  prevBestAsk: number;
  prevBestAskVol: number;
}

/**
 * Calculates Order Flow Imbalance (OFI) for the top level.
 * OFI = (Change in Bid Volume) - (Change in Ask Volume)
 */
export function calculateOFI(
  current: OrderbookSnapshot,
  prev: OFIState | null,
): { ofi: number; nextState: OFIState } {
  const bestBid = current.bids[0]?.[0] ?? 0;
  const bestBidVol = current.bids[0]?.[1] ?? 0;
  const bestAsk = current.asks[0]?.[0] ?? 0;
  const bestAskVol = current.asks[0]?.[1] ?? 0;

  if (!prev) {
    return {
      ofi: 0,
      nextState: {
        prevBestBid: bestBid,
        prevBestBidVol: bestBidVol,
        prevBestAsk: bestAsk,
        prevBestAskVol: bestAskVol,
      },
    };
  }

  let bidChange = 0;
  if (bestBid > prev.prevBestBid) {
    bidChange = bestBidVol;
  } else if (bestBid === prev.prevBestBid) {
    bidChange = bestBidVol - prev.prevBestBidVol;
  } else {
    bidChange = -prev.prevBestBidVol;
  }

  let askChange = 0;
  if (bestAsk < prev.prevBestAsk) {
    askChange = bestAskVol;
  } else if (bestAsk === prev.prevBestAsk) {
    askChange = bestAskVol - prev.prevBestAskVol;
  } else {
    askChange = -prev.prevBestAskVol;
  }

  return {
    ofi: bidChange - askChange,
    nextState: {
      prevBestBid: bestBid,
      prevBestBidVol: bestBidVol,
      prevBestAsk: bestAsk,
      prevBestAskVol: bestAskVol,
    },
  };
}

/**
 * Calculates Orderbook Imbalance (Pressure).
 * Ratio of volume on one side vs total volume within a certain depth.
 * Returns value from -1 (total ask pressure) to 1 (total bid pressure).
 */
export function calculateBookImbalance(
  snapshot: OrderbookSnapshot,
  depthLevels: number = 10,
): number {
  const bids = snapshot.bids.slice(0, depthLevels);
  const asks = snapshot.asks.slice(0, depthLevels);

  const totalBidVol = bids.reduce((sum, l) => sum + (l[1] ?? 0), 0);
  const totalAskVol = asks.reduce((sum, l) => sum + (l[1] ?? 0), 0);

  if (totalBidVol + totalAskVol === 0) return 0;

  return (totalBidVol - totalAskVol) / (totalBidVol + totalAskVol);
}

export interface LiquidityVoid {
  priceFrom: number;
  priceTo: number;
  gapSizePct: number;
  side: "bid" | "ask" | "mid";
}

/**
 * Finds price areas with very low liquidity in the orderbook.
 * Gaps between levels or areas with volume significantly below median.
 */
export function calculateLiquidityVoids(
  snapshot: OrderbookSnapshot,
  thresholdFactor: number = 0.1,
): LiquidityVoid[] {
  const voids: LiquidityVoid[] = [];
  const allLevels = [...snapshot.bids, ...snapshot.asks];
  if (allLevels.length < 2) return [];

  const volumes = allLevels.map((l) => l[1]!).sort((a, b) => a - b);
  const medianVol = volumes[Math.floor(volumes.length / 2)] ?? 0;
  const voidThreshold = medianVol * thresholdFactor;

  // 1. Find gaps between best bid and best ask (Slippage void)
  const bestBid = snapshot.bids[0]?.[0] ?? 0;
  const bestAsk = snapshot.asks[0]?.[0] ?? 0;
  if (bestBid > 0 && bestAsk > 0 && (bestAsk - bestBid) / bestBid > 0.001) {
    voids.push({
      priceFrom: bestBid,
      priceTo: bestAsk,
      gapSizePct: ((bestAsk - bestBid) / bestBid) * 100,
      side: "mid",
    });
  }

  // 2. Scan bid levels for gaps
  for (let i = 0; i < snapshot.bids.length - 1; i++) {
    const p1 = snapshot.bids[i]![0]!;
    const p2 = snapshot.bids[i + 1]![0]!;
    const dist = Math.abs(p1 - p2) / p1;

    // Lowered threshold for sensitivity: 0.05% instead of 0.2%
    if (dist > 0.0005) {
      voids.push({
        priceFrom: p2,
        priceTo: p1,
        gapSizePct: dist * 100,
        side: "bid",
      });
    }
  }

  // 3. Scan ask levels for gaps
  for (let i = 0; i < snapshot.asks.length - 1; i++) {
    const p1 = snapshot.asks[i]![0]!;
    const p2 = snapshot.asks[i + 1]![0]!;
    const dist = Math.abs(p1 - p2) / p1;

    if (dist > 0.0005) {
      voids.push({
        priceFrom: p1,
        priceTo: p2,
        gapSizePct: dist * 100,
        side: "ask",
      });
    }
  }

  return voids.slice(0, 10); // Keep top 10 voids
}
