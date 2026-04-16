import type { PriceLevel, LiquidityZone } from "../types/risk.types.ts";

interface OrderbookData {
  bids: number[][];
  asks: number[][];
  symbol: string;
  exchange: string;
}

/**
 * Analyzes orderbook for significant volume clusters.
 * Finds levels where volume > median * wallThreshold and clusters adjacent levels.
 */
export function analyzeOrderbook(
  data: OrderbookData,
  wallThreshold: number,
  clusterTolerance: number
): { levels: PriceLevel[]; zones: LiquidityZone[] } {
  const allLevels = [...data.bids, ...data.asks];
  if (allLevels.length === 0) return { levels: [], zones: [] };

  // Compute median volume
  const volumes = allLevels.map((l) => l[1]!).sort((a, b) => a - b);
  const medianVol = volumes[Math.floor(volumes.length / 2)]!;
  if (medianVol === 0) return { levels: [], zones: [] };

  const threshold = medianVol * wallThreshold;
  const now = Date.now();
  const levels: PriceLevel[] = [];

  // Find significant bid levels (support)
  for (const [price, volume] of data.bids) {
    if (volume! >= threshold) {
      levels.push({
        price: price!,
        type: "support",
        source: "orderbook",
        strength: Math.min(volume! / medianVol, 20),
        volume: volume!,
        touches: 1,
        lastTouchTime: now,
        isSuspectedSpoof: false,
        exchange: data.exchange,
        symbol: data.symbol,
      });
    }
  }

  // Find significant ask levels (resistance)
  for (const [price, volume] of data.asks) {
    if (volume! >= threshold) {
      levels.push({
        price: price!,
        type: "resistance",
        source: "orderbook",
        strength: Math.min(volume! / medianVol, 20),
        volume: volume!,
        touches: 1,
        lastTouchTime: now,
        isSuspectedSpoof: false,
        exchange: data.exchange,
        symbol: data.symbol,
      });
    }
  }

  // Cluster adjacent levels
  const clustered = clusterLevels(levels, clusterTolerance);

  // Build liquidity zones from clusters
  const zones = buildZones(clustered, data.exchange, data.symbol);

  return { levels: clustered, zones };
}

/**
 * Merge levels within tolerance into clusters.
 * Volume-weighted average price, summed volumes.
 */
function clusterLevels(levels: PriceLevel[], tolerance: number): PriceLevel[] {
  if (levels.length === 0) return [];

  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters: PriceLevel[] = [];

  let current = { ...sorted[0]! };
  let count = 1;
  let totalVolPrice = current.price * (current.volume ?? 0);
  let totalVol = current.volume ?? 0;

  for (let i = 1; i < sorted.length; i++) {
    const level = sorted[i]!;
    const priceDiff = Math.abs(level.price - current.price) / current.price;

    if (priceDiff <= tolerance && level.type === current.type) {
      // Merge into current cluster
      const vol = level.volume ?? 0;
      totalVolPrice += level.price * vol;
      totalVol += vol;
      current.strength = Math.max(current.strength, level.strength);
      count++;
    } else {
      // Finalize current cluster
      if (totalVol > 0) current.price = totalVolPrice / totalVol;
      current.volume = totalVol;
      clusters.push(current);

      // Start new cluster
      current = { ...level };
      count = 1;
      totalVolPrice = current.price * (current.volume ?? 0);
      totalVol = current.volume ?? 0;
    }
  }

  // Don't forget last cluster
  if (totalVol > 0) current.price = totalVolPrice / totalVol;
  current.volume = totalVol;
  clusters.push(current);

  return clusters;
}

function buildZones(levels: PriceLevel[], exchange: string, symbol: string): LiquidityZone[] {
  const zones: LiquidityZone[] = [];
  const tolerance = 0.002; // 0.2% for zone grouping

  const sorted = [...levels].sort((a, b) => a.price - b.price);
  let i = 0;

  while (i < sorted.length) {
    const zone: PriceLevel[] = [sorted[i]!];
    let j = i + 1;

    while (j < sorted.length) {
      const priceDiff = Math.abs(sorted[j]!.price - sorted[j - 1]!.price) / sorted[j - 1]!.price;
      if (priceDiff <= tolerance) {
        zone.push(sorted[j]!);
        j++;
      } else {
        break;
      }
    }

    if (zone.length > 0) {
      const prices = zone.map((l) => l.price);
      zones.push({
        priceFrom: Math.min(...prices),
        priceTo: Math.max(...prices),
        side: zone[0]!.type === "support" ? "bid" : "ask",
        totalVolume: zone.reduce((s, l) => s + (l.volume ?? 0), 0),
        levelCount: zone.length,
        exchange,
        symbol,
      });
    }

    i = j;
  }

  return zones;
}
