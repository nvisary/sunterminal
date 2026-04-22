/**
 * Real-time microstructure detectors for the Liquidity Heatmap.
 *
 * Two detectors in v1:
 *   - Wall-pull: large resting order disappears quickly
 *   - Absorption: lots of volume traded into a level but the level holds
 *
 * Inputs come from the heatmap's own snapshot buffer (orderbook samples)
 * and the trade tape. Events are emitted with a cooldown so we don't
 * fire repeatedly on the same price.
 */

export interface TradeSample {
  t: number;
  price: number;
  amount: number;
  side: 'buy' | 'sell';
}

export type DetectorEventKind = 'wall-appeared' | 'wall-pull' | 'absorption';

export interface DetectorEvent {
  id: string;
  kind: DetectorEventKind;
  side: 'bid' | 'ask';
  price: number;
  size: number;       // wall size for walls; absorbed volume for absorption
  t: number;          // event timestamp
  meta?: Record<string, unknown>;
}

export interface Snapshot {
  t: number;
  bids: { [price: number]: number };
  asks: { [price: number]: number };
  mid: number;
  bestBid: number;
  bestAsk: number;
}

export interface DetectorConfig {
  // Wall threshold: size must be >= wallMultiplier × median level size
  wallMultiplier: number;
  // Wall must be stable for this long to qualify as "real"
  wallStableMs: number;
  // After wall qualifies, drop of this fraction within pullWindowMs = pull event
  pullDropFraction: number;   // e.g. 0.8 means size fell to 20% of recent max
  pullWindowMs: number;
  // Absorption: cumulative volume traded at a price must exceed this × median level size
  absorbMultiplier: number;
  absorbWindowMs: number;
  // Cooldown per (price, kind) to avoid re-firing
  cooldownMs: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  wallMultiplier: 3,
  wallStableMs: 1500,
  pullDropFraction: 0.75,
  pullWindowMs: 800,
  absorbMultiplier: 4,
  absorbWindowMs: 3000,
  cooldownMs: 4000,
};

interface DetectorStateInternal {
  lastFired: Map<string, number>; // key: `${kind}:${side}:${price}` → timestamp
}

export function createDetectorState(): DetectorStateInternal {
  return { lastFired: new Map() };
}

function canFire(state: DetectorStateInternal, key: string, now: number, cooldownMs: number): boolean {
  const last = state.lastFired.get(key) ?? 0;
  if (now - last < cooldownMs) return false;
  state.lastFired.set(key, now);
  return true;
}

/**
 * Compute median of non-zero level sizes in the most recent snapshot.
 * Used as a baseline for "what's a normal-sized order here".
 */
function medianLevelSize(snap: Snapshot): number {
  const arr: number[] = [];
  for (const k in snap.bids) arr.push(snap.bids[k]!);
  for (const k in snap.asks) arr.push(snap.asks[k]!);
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)] ?? 0;
}

/**
 * For a given price + side, return the history of sizes across snapshots
 * within the given time window.
 */
function sizeHistory(
  snaps: Snapshot[],
  side: 'bid' | 'ask',
  price: number,
  fromT: number,
): Array<{ t: number; size: number }> {
  const out: Array<{ t: number; size: number }> = [];
  for (const s of snaps) {
    if (s.t < fromT) continue;
    const book = side === 'bid' ? s.bids : s.asks;
    out.push({ t: s.t, size: book[price] ?? 0 });
  }
  return out;
}

/**
 * Run detectors over the current state. Returns freshly detected events
 * (only events not yet emitted due to cooldown).
 */
export function runDetectors(
  snaps: Snapshot[],
  trades: TradeSample[],
  state: DetectorStateInternal,
  cfg: DetectorConfig,
): DetectorEvent[] {
  if (snaps.length < 3) return [];
  const now = Date.now();
  const latest = snaps[snaps.length - 1]!;
  const prev = snaps[snaps.length - 2]!;
  const median = medianLevelSize(latest);
  if (median <= 0) return [];

  const wallThreshold = median * cfg.wallMultiplier;
  const events: DetectorEvent[] = [];

  // ─── Wall appeared / Wall pull ────────────────────────────────────
  // Gather union of price levels seen in recent snapshots
  const pullWindowStart = now - cfg.pullWindowMs - cfg.wallStableMs;
  const recent = snaps.filter((s) => s.t >= pullWindowStart);
  if (recent.length >= 2) {
    const allPrices = new Map<string, { side: 'bid' | 'ask'; price: number }>();
    for (const s of recent) {
      for (const k in s.bids) allPrices.set(`b${k}`, { side: 'bid', price: Number(k) });
      for (const k in s.asks) allPrices.set(`a${k}`, { side: 'ask', price: Number(k) });
    }

    for (const { side, price } of allPrices.values()) {
      const hist = sizeHistory(recent, side, price, pullWindowStart);
      if (hist.length < 2) continue;

      let maxSize = 0;
      let maxAt = 0;
      for (const h of hist) {
        if (h.size > maxSize) { maxSize = h.size; maxAt = h.t; }
      }
      if (maxSize < wallThreshold) continue;

      // Was the wall stable? Count time it stayed above threshold.
      let stableStart = -1, stableEnd = -1;
      for (const h of hist) {
        if (h.size >= wallThreshold * 0.85) {
          if (stableStart < 0) stableStart = h.t;
          stableEnd = h.t;
        }
      }
      const stableMs = stableEnd - stableStart;

      // Current size (from latest snap)
      const currentBook = side === 'bid' ? latest.bids : latest.asks;
      const currentSize = currentBook[price] ?? 0;

      // WALL PULL: had a stable wall, now it's gone (or shrunk a lot)
      if (
        stableMs >= cfg.wallStableMs
        && currentSize < maxSize * (1 - cfg.pullDropFraction)
        && now - maxAt < cfg.pullWindowMs + cfg.wallStableMs
      ) {
        const key = `wall-pull:${side}:${price}`;
        if (canFire(state, key, now, cfg.cooldownMs)) {
          events.push({
            id: `wp-${now}-${price}`,
            kind: 'wall-pull',
            side, price,
            size: maxSize,
            t: now,
            meta: { stableMs, droppedFrom: maxSize, droppedTo: currentSize },
          });
        }
      }

      // WALL APPEARED: wall just became stable in the last snapshot transition
      // Fire once when a new wall crosses the threshold
      const prevBook = side === 'bid' ? prev.bids : prev.asks;
      const prevSize = prevBook[price] ?? 0;
      if (currentSize >= wallThreshold && prevSize < wallThreshold) {
        const key = `wall-appeared:${side}:${price}`;
        if (canFire(state, key, now, cfg.cooldownMs)) {
          events.push({
            id: `wa-${now}-${price}`,
            kind: 'wall-appeared',
            side, price,
            size: currentSize,
            t: now,
            meta: { multiple: currentSize / median },
          });
        }
      }
    }
  }

  // ─── Absorption ───────────────────────────────────────────────────
  // For each price that saw significant trading volume in the window,
  // check that the level still holds (size hasn't collapsed).
  const absorbFrom = now - cfg.absorbWindowMs;
  const volByPrice = new Map<string, { price: number; vol: number; buyVol: number; sellVol: number }>();
  for (const t of trades) {
    if (t.t < absorbFrom) continue;
    const k = `${t.price.toFixed(8)}`;
    const rec = volByPrice.get(k) ?? { price: t.price, vol: 0, buyVol: 0, sellVol: 0 };
    rec.vol += t.amount;
    if (t.side === 'buy') rec.buyVol += t.amount;
    else rec.sellVol += t.amount;
    volByPrice.set(k, rec);
  }

  const absorbThreshold = median * cfg.absorbMultiplier;

  for (const rec of volByPrice.values()) {
    if (rec.vol < absorbThreshold) continue;

    // Determine which side is being eaten (if buy-aggressor ate asks, the ask side held)
    // If buys dominate, check ask-side; if sells, check bid-side.
    const side: 'bid' | 'ask' = rec.buyVol >= rec.sellVol ? 'ask' : 'bid';

    // Match to nearest aggregated level in the latest snap
    const book = side === 'bid' ? latest.bids : latest.asks;
    const bookPrices = Object.keys(book).map(Number);
    if (bookPrices.length === 0) continue;
    let best = bookPrices[0]!;
    let bestDist = Math.abs(best - rec.price);
    for (const p of bookPrices) {
      const d = Math.abs(p - rec.price);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    // Require reasonably close match (within 1 tick, approximated)
    const tickApprox = bestDist; // using distance as proxy; allow up to 0.1% of price
    if (tickApprox > latest.mid * 0.001) continue;

    const currentSize = book[best] ?? 0;
    // Absorption = level still has material size despite heavy trading
    if (currentSize < median * 0.5) continue;

    // And mid price hasn't crossed through the level in the meaningful direction
    // (for asks: mid should still be below the level; for bids: above)
    if (side === 'ask' && latest.mid >= best) continue;
    if (side === 'bid' && latest.mid <= best) continue;

    const key = `absorption:${side}:${best}`;
    if (canFire(state, key, now, cfg.cooldownMs)) {
      events.push({
        id: `ab-${now}-${best}`,
        kind: 'absorption',
        side,
        price: best,
        size: rec.vol,
        t: now,
        meta: {
          traded: rec.vol,
          buyVol: rec.buyVol,
          sellVol: rec.sellVol,
          restingSize: currentSize,
        },
      });
    }
  }

  return events;
}

/**
 * Prune events older than maxAgeMs.
 */
export function pruneEvents(events: DetectorEvent[], maxAgeMs: number): DetectorEvent[] {
  const cutoff = Date.now() - maxAgeMs;
  return events.filter((e) => e.t >= cutoff);
}
