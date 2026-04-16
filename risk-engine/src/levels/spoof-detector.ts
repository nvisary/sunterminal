import pino from "pino";

const logger = pino({ name: "spoof-detector" });

interface WallTracker {
  price: number;
  firstSeen: number;
  lastSeen: number;
  seenCount: number;   // times present in orderbook
  goneCount: number;   // times absent after being seen
  volume: number;
}

interface SpoofResult {
  price: number;
  isSuspectedSpoof: boolean;
}

/**
 * Tracks large orderbook walls across updates and detects spoofing behavior.
 *
 * Spoof criteria:
 * - Wall lifetime < spoofLifetimeMs (default 10s)
 * - Flicker count >= spoofFlickerCount (default 3) per minute
 * - Distance from mid price > 0.5%
 */
export class SpoofDetector {
  private walls = new Map<string, WallTracker>();
  private spoofLifetimeMs: number;
  private spoofFlickerCount: number;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(spoofLifetimeMs: number, spoofFlickerCount: number) {
    this.spoofLifetimeMs = spoofLifetimeMs;
    this.spoofFlickerCount = spoofFlickerCount;
  }

  start(): void {
    // Cleanup old entries every 30s
    this.cleanupInterval = setInterval(() => this.cleanup(), 30_000);
  }

  stop(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }

  /**
   * Update wall tracking with current significant levels from the orderbook.
   * @param significantPrices prices with volume > threshold
   * @param allPrices all price levels in orderbook (for median)
   * @param midPrice current mid price of the orderbook
   */
  update(
    significantPrices: Set<number>,
    medianVol: number,
    midPrice: number
  ): SpoofResult[] {
    const now = Date.now();
    const results: SpoofResult[] = [];

    // Update existing walls
    for (const [key, wall] of this.walls) {
      if (significantPrices.has(wall.price)) {
        // Still present
        wall.lastSeen = now;
        wall.seenCount++;
        significantPrices.delete(wall.price); // handled
      } else {
        // Gone
        wall.goneCount++;
      }
    }

    // Add new walls
    for (const price of significantPrices) {
      const key = price.toFixed(8);
      this.walls.set(key, {
        price,
        firstSeen: now,
        lastSeen: now,
        seenCount: 1,
        goneCount: 0,
        volume: 0,
      });
    }

    // Evaluate spoof candidates
    for (const [key, wall] of this.walls) {
      const lifetime = now - wall.firstSeen;
      const distanceFromMid = midPrice > 0 ? Math.abs(wall.price - midPrice) / midPrice : 0;

      // Must have flickered enough and be far from mid price
      const isSpoof =
        lifetime < this.spoofLifetimeMs &&
        wall.goneCount >= this.spoofFlickerCount &&
        distanceFromMid > 0.005; // 0.5%

      if (isSpoof) {
        results.push({ price: wall.price, isSuspectedSpoof: true });
        logger.debug(
          { price: wall.price, lifetime, goneCount: wall.goneCount, distanceFromMid: (distanceFromMid * 100).toFixed(2) },
          "Spoof detected"
        );
      }
    }

    return results;
  }

  private cleanup(): void {
    const cutoff = Date.now() - 60_000; // remove entries older than 60s
    for (const [key, wall] of this.walls) {
      if (wall.lastSeen < cutoff) {
        this.walls.delete(key);
      }
    }
  }
}
