import { useEffect, useRef } from 'react';
import { bidColor, askColor, normSize } from './heatmap-utils';

/**
 * Tick-bucketed orderbook snapshot used by the DOM heatmap strip.
 * Keys are aggregated prices (snapped to current tickSize), values are sizes.
 */
export interface DomSnapshot {
  t: number;
  bids: Map<number, number>;
  asks: Map<number, number>;
}

export interface DomLadderRow {
  price: number;
  side: 'ask' | 'bid' | 'spread';
}

interface Props {
  /**
   * Live snapshot buffer. Read each frame via .current — parent owns the array
   * so we don't trigger re-renders on every snapshot push.
   */
  snapshotsRef: React.MutableRefObject<DomSnapshot[]>;
  /** Current visible rows in the DOM ladder, in render order (top → bottom). */
  rowsRef: React.MutableRefObject<DomLadderRow[]>;
  rowH: number;
  spreadRowH: number;
  windowMs: number;
}

export function HeatmapStrip({ snapshotsRef, rowsRef, rowH, spreadRowH, windowMs }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let alive = true;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const tick = () => {
      if (!alive) return;
      drawStrip(
        ctx, canvas,
        snapshotsRef.current, rowsRef.current,
        rowH, spreadRowH, windowMs,
      );
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [snapshotsRef, rowsRef, rowH, spreadRowH, windowMs]);

  return <canvas ref={canvasRef} className="block w-full h-full" />;
}

function drawStrip(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  snaps: DomSnapshot[],
  rows: DomLadderRow[],
  rowH: number,
  spreadRowH: number,
  windowMs: number,
) {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (W <= 0 || H <= 0) return;

  ctx.fillStyle = '#05050a';
  ctx.fillRect(0, 0, W, H);

  if (snaps.length === 0 || rows.length === 0) return;

  const now = Date.now();
  const t0 = now - windowMs;
  const timeToX = (t: number) => ((t - t0) / windowMs) * W;

  // Quantile normalization across all sizes in current window. Drawing only
  // p50+ keeps noisy small levels from washing out the colormap.
  const allSizes: number[] = [];
  for (const s of snaps) {
    s.bids.forEach((v) => { if (v > 0) allSizes.push(v); });
    s.asks.forEach((v) => { if (v > 0) allSizes.push(v); });
  }
  if (allSizes.length === 0) return;
  allSizes.sort((a, b) => a - b);
  const p50 = allSizes[Math.floor(allSizes.length * 0.5)] ?? 0;
  const p95 = allSizes[Math.floor(allSizes.length * 0.95)] ?? 0;
  const q50log = Math.log(1 + p50);
  const q95log = Math.log(1 + p95);

  // Right edge anchored to "now" — last snapshot stretches up to current time
  // so users see live activity flush against the DOM ladder.
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    if (s.t < t0) continue;
    const x = timeToX(s.t);
    const nextX = i < snaps.length - 1 ? timeToX(snaps[i + 1]!.t) : W;
    const w = Math.max(1, nextX - x);

    let y = 0;
    for (const row of rows) {
      if (row.side === 'spread') {
        y += spreadRowH;
        continue;
      }
      const isBid = row.side === 'bid';
      const v = isBid ? (s.bids.get(row.price) ?? 0) : (s.asks.get(row.price) ?? 0);
      if (v > 0) {
        const t = normSize(v, q50log, q95log);
        if (t >= 0) {
          ctx.fillStyle = isBid ? bidColor(t) : askColor(t);
          ctx.fillRect(x, y, w + 0.5, rowH);
        }
      }
      y += rowH;
    }
  }
}
