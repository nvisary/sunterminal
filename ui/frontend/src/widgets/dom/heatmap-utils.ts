/**
 * Shared color/normalization helpers for liquidity heatmaps (full widget + DOM strip).
 */

type Stop = [number, [number, number, number]];

const BID_STOPS: Stop[] = [
  [0.00, [8, 14, 18]],
  [0.25, [8, 46, 48]],
  [0.50, [18, 120, 90]],
  [0.75, [60, 210, 140]],
  [1.00, [220, 255, 210]],
];

const ASK_STOPS: Stop[] = [
  [0.00, [15, 8, 14]],
  [0.25, [55, 10, 30]],
  [0.50, [170, 40, 60]],
  [0.75, [240, 130, 80]],
  [1.00, [255, 240, 200]],
];

function interpStops(stops: Stop[], t: number): string {
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i]!;
    const [b, cb] = stops[i + 1]!;
    if (t >= a && t <= b) {
      const f = (t - a) / (b - a);
      const r = Math.round(ca[0] + (cb[0] - ca[0]) * f);
      const g = Math.round(ca[1] + (cb[1] - ca[1]) * f);
      const bl = Math.round(ca[2] + (cb[2] - ca[2]) * f);
      return `rgb(${r},${g},${bl})`;
    }
  }
  const last = stops[stops.length - 1]![1];
  return `rgb(${last[0]},${last[1]},${last[2]})`;
}

/** Bid gradient: dark → bright green (Bookmap-style). */
export function bidColor(t: number): string {
  if (t <= 0) return 'rgba(0,0,0,0)';
  if (t > 1) t = 1;
  return interpStops(BID_STOPS, t);
}

/** Ask gradient: dark → bright red-orange (Bookmap-style). */
export function askColor(t: number): string {
  if (t <= 0) return 'rgba(0,0,0,0)';
  if (t > 1) t = 1;
  return interpStops(ASK_STOPS, t);
}

/**
 * Quantile-normalize size using p50 threshold and p95 saturation.
 * Returns t in [0, 1] or -1 if below threshold (skip drawing).
 */
export function normSize(size: number, q50log: number, q95log: number): number {
  if (q95log <= q50log) return -1;
  const l = Math.log(1 + size);
  if (l < q50log) return -1;
  return Math.min(1, (l - q50log) / (q95log - q50log));
}
