import { useEffect, useRef, useState, useMemo } from 'react';
import { wsClient, API_BASE } from '../lib/ws-client';
import type { OrderBook } from '../stores/market.store';
import {
  createDetectorState, runDetectors, pruneEvents,
  DEFAULT_DETECTOR_CONFIG,
  type DetectorEvent,
} from './dom/detectors';

interface Props {
  exchange: string;
  symbol: string;
}

interface LevelMap { [price: number]: number }
interface Snapshot {
  t: number;
  bids: LevelMap;
  asks: LevelMap;
  mid: number;
  bestBid: number;
  bestAsk: number;
}
interface TradeMark {
  t: number;
  price: number;
  amount: number;
  side: 'buy' | 'sell';
}

const WINDOWS: Array<{ label: string; ms: number; snapMs: number }> = [
  { label: '30s', ms: 30_000, snapMs: 150 },
  { label: '1m', ms: 60_000, snapMs: 200 },
  { label: '3m', ms: 180_000, snapMs: 400 },
  { label: '10m', ms: 600_000, snapMs: 1000 },
];

function getTickSteps(price: number): number[] {
  if (price > 10000) return [0.5, 1, 5, 10, 50];
  if (price > 1000) return [0.05, 0.1, 0.5, 1, 5];
  if (price > 100) return [0.01, 0.05, 0.1, 0.5, 1];
  if (price > 10) return [0.001, 0.01, 0.05, 0.1];
  if (price > 1) return [0.0001, 0.001, 0.01, 0.05];
  return [0.00001, 0.0001, 0.001];
}

function roundTick(v: number, tick: number): number {
  const precision = Math.max(0, -Math.floor(Math.log10(tick)));
  const f = 10 ** precision;
  return Math.round(v * f) / f;
}

function aggregate(levels: number[][], tick: number): LevelMap {
  const out: LevelMap = {};
  for (const [p, s] of levels) {
    if (p == null || s == null) continue;
    const k = roundTick(Math.floor(p / tick) * tick, tick);
    out[k] = (out[k] ?? 0) + s;
  }
  return out;
}

export function LiquidityHeatmapWidget({ exchange, symbol }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const snapshotsRef = useRef<Snapshot[]>([]);
  const tradesRef = useRef<TradeMark[]>([]);
  const latestObRef = useRef<OrderBook | null>(null);
  const lastSnapTsRef = useRef(0);
  const [winIdx, setWinIdx] = useState(1); // 1m default
  const [tickIdx, setTickIdx] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuFade, setMenuFade] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  const [autoRange, setAutoRange] = useState(true);
  const [priceCenter, setPriceCenter] = useState<number | null>(null);
  const [priceRange, setPriceRange] = useState(0.005); // ±0.5% around mid by default
  const [detectorsOn, setDetectorsOn] = useState(true);
  const detectorStateRef = useRef(createDetectorState());
  const eventsRef = useRef<DetectorEvent[]>([]);
  const [recentEvents, setRecentEvents] = useState<DetectorEvent[]>([]);

  const win = WINDOWS[winIdx]!;

  // Subscribe to orderbook + trades
  useEffect(() => {
    snapshotsRef.current = [];
    tradesRef.current = [];
    latestObRef.current = null;
    lastSnapTsRef.current = 0;
    detectorStateRef.current = createDetectorState();
    eventsRef.current = [];
    setRecentEvents([]);

    // Warm with snapshot
    fetch(`${API_BASE}/api/snapshot/ob/${exchange}/${encodeURIComponent(symbol)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.bids) latestObRef.current = data as OrderBook; })
      .catch(() => {});

    const unOb = wsClient.subscribe<OrderBook>(`orderbook:${exchange}:${symbol}`, (ob) => {
      latestObRef.current = ob;
    });
    const unTr = wsClient.subscribe<{ price: number; amount: number; side: string; timestamp?: number }>(
      `trades:${exchange}:${symbol}`,
      (t) => {
        if (!t.price || !t.amount) return;
        const side: 'buy' | 'sell' = t.side === 'buy' ? 'buy' : 'sell';
        tradesRef.current.push({ t: Date.now(), price: t.price, amount: t.amount, side });
        // trim old trades (keep 2× window)
        const cutoff = Date.now() - win.ms * 2;
        while (tradesRef.current.length && tradesRef.current[0]!.t < cutoff) tradesRef.current.shift();
      },
    );
    return () => { unOb(); unTr(); };
  }, [exchange, symbol, win.ms]);

  // Snapshot ticker + render loop
  useEffect(() => {
    let alive = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const tick = () => {
      if (!alive) return;
      const now = Date.now();

      // Take snapshot
      if (now - lastSnapTsRef.current >= win.snapMs && latestObRef.current) {
        const ob = latestObRef.current;
        const bestBid = ob.bids[0]?.[0] ?? 0;
        const bestAsk = ob.asks[0]?.[0] ?? 0;
        const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : (bestBid || bestAsk || 0);
        const steps = getTickSteps(mid);
        const t = steps[tickIdx ?? Math.min(2, steps.length - 1)]!;
        const snap: Snapshot = {
          t: now,
          bids: aggregate(ob.bids, t),
          asks: aggregate(ob.asks, t),
          mid, bestBid, bestAsk,
        };
        snapshotsRef.current.push(snap);
        lastSnapTsRef.current = now;
        const cutoff = now - win.ms;
        while (snapshotsRef.current.length && snapshotsRef.current[0]!.t < cutoff) {
          snapshotsRef.current.shift();
        }

        // Run detectors on every fresh snapshot
        if (detectorsOn) {
          const newEvents = runDetectors(
            snapshotsRef.current,
            tradesRef.current,
            detectorStateRef.current,
            DEFAULT_DETECTOR_CONFIG,
          );
          if (newEvents.length > 0) {
            eventsRef.current = pruneEvents(
              [...eventsRef.current, ...newEvents],
              win.ms,
            );
            // Trim recent-events banner to the last 5
            setRecentEvents(eventsRef.current.slice(-5).reverse());
          } else {
            // Periodically prune
            const pruned = pruneEvents(eventsRef.current, win.ms);
            if (pruned.length !== eventsRef.current.length) {
              eventsRef.current = pruned;
            }
          }
        }
      }

      draw(ctx, canvas, snapshotsRef.current, tradesRef.current, {
        windowMs: win.ms,
        showTrades, autoRange, priceCenter, priceRange,
        events: detectorsOn ? eventsRef.current : [],
      });

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    return () => { alive = false; ro.disconnect(); };
  }, [win.ms, win.snapMs, tickIdx, showTrades, autoRange, priceCenter, priceRange, detectorsOn]);

  const baseName = symbol.split('/')[0] ?? symbol;

  // Tick options for current mid
  const tickOptions = useMemo(() => {
    const mid = latestObRef.current?.bids[0]?.[0] ?? 100;
    return getTickSteps(mid);
  }, [menuFade]);

  const handleWheel = (e: React.WheelEvent) => {
    if (autoRange) return;
    e.preventDefault();
    setPriceRange((r) => {
      const next = e.deltaY > 0 ? r * 1.15 : r / 1.15;
      return Math.max(0.0005, Math.min(0.2, next));
    });
  };

  return (
    <div className="bg-[#0c0c14] rounded border border-[#1a1a2a] h-full overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#1a1a2a] shrink-0 text-[10px]">
        <span className="text-gray-400 uppercase tracking-wider">Heatmap — {baseName}</span>
        {detectorsOn && recentEvents.length > 0 && (
          <div className="flex gap-1 items-center overflow-hidden">
            {recentEvents.slice(0, 3).map((e) => (
              <span key={e.id}
                className={`px-1 py-[1px] rounded font-mono text-[9px] whitespace-nowrap ${
                  e.kind === 'wall-appeared'
                    ? (e.side === 'bid' ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300')
                    : e.kind === 'wall-pull'
                      ? 'bg-yellow-900/60 text-yellow-200 animate-pulse'
                      : 'bg-purple-900/50 text-purple-200'
                }`}
                title={e.kind === 'wall-pull' ? `Wall pulled at ${e.price.toFixed(4)}` :
                       e.kind === 'wall-appeared' ? `Wall appeared at ${e.price.toFixed(4)}` :
                       `Absorption at ${e.price.toFixed(4)}`}
              >
                {e.kind === 'wall-pull' ? '⚡ PULL' : e.kind === 'wall-appeared' ? '█ WALL' : '◉ ABSORB'}
                {' '}{e.price.toFixed(Math.abs(e.price) >= 100 ? 2 : 4)}
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-0.5 ml-auto">
          {WINDOWS.map((w, i) => (
            <button key={w.label} onClick={() => setWinIdx(i)}
              className={`px-1.5 py-0.5 rounded text-[10px] ${winIdx === i ? 'bg-[#2a2a4a] text-white' : 'text-gray-500 hover:text-gray-300'}`}
            >{w.label}</button>
          ))}
        </div>
        <button
          onClick={() => setMenuOpen((v) => { setMenuFade(!v); return !v; })}
          className="text-gray-500 hover:text-gray-300 px-1 relative"
        >
          ⚙
          {menuOpen && (
            <div
              className="absolute top-full right-0 mt-1 w-48 bg-[#11111c] border border-[#2a2a3a] rounded shadow-lg z-40 p-2 space-y-2 text-left"
              onMouseLeave={() => { setMenuOpen(false); setMenuFade(false); }}
            >
              <div>
                <div className="text-[9px] text-gray-500 uppercase mb-1">Tick</div>
                <div className="flex flex-wrap gap-1">
                  <button onClick={(e) => { e.stopPropagation(); setTickIdx(null); }}
                    className={`px-1.5 py-0.5 text-[10px] rounded ${tickIdx == null ? 'bg-[#2a2a4a] text-white' : 'text-gray-500'}`}
                  >auto</button>
                  {tickOptions.map((t, i) => (
                    <button key={t} onClick={(e) => { e.stopPropagation(); setTickIdx(i); }}
                      className={`px-1.5 py-0.5 text-[10px] rounded ${tickIdx === i ? 'bg-[#2a2a4a] text-white' : 'text-gray-500'}`}
                    >{t}</button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <input type="checkbox" checked={showTrades} onChange={(e) => setShowTrades(e.target.checked)} />
                Show trades
              </label>
              <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <input type="checkbox" checked={detectorsOn} onChange={(e) => setDetectorsOn(e.target.checked)} />
                Detectors (walls / absorb)
              </label>
              <label className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer"
                onClick={(e) => e.stopPropagation()}
              >
                <input type="checkbox" checked={autoRange} onChange={(e) => {
                  setAutoRange(e.target.checked);
                  if (!e.target.checked && latestObRef.current) {
                    const bb = latestObRef.current.bids[0]?.[0] ?? 0;
                    const ba = latestObRef.current.asks[0]?.[0] ?? 0;
                    setPriceCenter((bb + ba) / 2 || bb || ba);
                  }
                }} />
                Auto price range
              </label>
              {!autoRange && (
                <div className="text-[9px] text-gray-500">Scroll in chart to zoom · range ±{(priceRange * 100).toFixed(2)}%</div>
              )}
            </div>
          )}
        </button>
      </div>
      <div className="flex-1 min-h-0 relative" onWheel={handleWheel}>
        <canvas ref={canvasRef} className="block w-full h-full" />
      </div>
    </div>
  );
}

interface DrawOpts {
  windowMs: number;
  showTrades: boolean;
  autoRange: boolean;
  priceCenter: number | null;
  priceRange: number;
  events: DetectorEvent[];
}

/**
 * Bid gradient: dark → bright green (Bookmap-style).
 */
function bidColor(t: number): string {
  // clamp
  if (t <= 0) return 'rgba(0,0,0,0)';
  if (t > 1) t = 1;
  // stops: dark → dark-blue-green → teal → green → near-white
  const stops: Array<[number, [number, number, number]]> = [
    [0.00, [8, 14, 18]],
    [0.25, [8, 46, 48]],
    [0.50, [18, 120, 90]],
    [0.75, [60, 210, 140]],
    [1.00, [220, 255, 210]],
  ];
  return interpStops(stops, t);
}

/**
 * Ask gradient: dark → bright red-orange.
 */
function askColor(t: number): string {
  if (t <= 0) return 'rgba(0,0,0,0)';
  if (t > 1) t = 1;
  const stops: Array<[number, [number, number, number]]> = [
    [0.00, [15, 8, 14]],
    [0.25, [55, 10, 30]],
    [0.50, [170, 40, 60]],
    [0.75, [240, 130, 80]],
    [1.00, [255, 240, 200]],
  ];
  return interpStops(stops, t);
}

function interpStops(stops: Array<[number, [number, number, number]]>, t: number): string {
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

/**
 * Quantile-normalize size using p50 threshold and p95 saturation.
 * Returns t in [0, 1] or -1 if below threshold (skip drawing).
 */
function normSize(size: number, q50log: number, q95log: number): number {
  if (q95log <= q50log) return -1;
  const l = Math.log(1 + size);
  if (l < q50log) return -1;
  return Math.min(1, (l - q50log) / (q95log - q50log));
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  snaps: Snapshot[],
  trades: TradeMark[],
  opts: DrawOpts,
) {
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  ctx.fillStyle = '#05050a';
  ctx.fillRect(0, 0, W, H);

  if (snaps.length === 0) {
    ctx.fillStyle = '#333';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Warming up…', W / 2, H / 2);
    return;
  }

  const now = Date.now();
  const t0 = now - opts.windowMs;
  const latest = snaps[snaps.length - 1]!;

  // Determine price range
  let pLo: number, pHi: number;
  if (opts.autoRange) {
    let lo = Infinity, hi = -Infinity;
    for (const s of snaps) {
      if (s.bestBid > 0 && s.bestBid < lo) lo = s.bestBid;
      if (s.bestAsk > hi) hi = s.bestAsk;
    }
    const span = Math.max(hi - lo, latest.mid * 0.001);
    const pad = span * 1.5;
    pLo = lo - pad;
    pHi = hi + pad;
  } else {
    const c = opts.priceCenter ?? latest.mid;
    pLo = c * (1 - opts.priceRange);
    pHi = c * (1 + opts.priceRange);
  }
  if (pHi <= pLo) return;

  const priceToY = (p: number) => H - ((p - pLo) / (pHi - pLo)) * H;
  const timeToX = (t: number) => ((t - t0) / opts.windowMs) * W;

  // ── Quantile normalization ─────────────────────────────────────────
  // Collect all level sizes across window to compute p50/p95.
  const allSizes: number[] = [];
  for (const s of snaps) {
    for (const k in s.bids) allSizes.push(s.bids[k]!);
    for (const k in s.asks) allSizes.push(s.asks[k]!);
  }
  if (allSizes.length === 0) return;
  allSizes.sort((a, b) => a - b);
  const p50 = allSizes[Math.floor(allSizes.length * 0.5)] ?? 0;
  const p95 = allSizes[Math.floor(allSizes.length * 0.95)] ?? 0;
  const q50log = Math.log(1 + p50);
  const q95log = Math.log(1 + p95);

  // Column width
  const colW = snaps.length > 1
    ? Math.max(1, (timeToX(snaps[1]!.t) - timeToX(snaps[0]!.t)))
    : Math.max(1, W / 60);

  // Row height = distance between adjacent ticks.
  const sampleBids = Object.keys(latest.bids).map(Number).sort((a, b) => a - b);
  let tickH = 2;
  if (sampleBids.length >= 2) {
    const diffs: number[] = [];
    for (let i = 1; i < sampleBids.length; i++) diffs.push(sampleBids[i]! - sampleBids[i - 1]!);
    diffs.sort((a, b) => a - b);
    const tickPx = diffs[0]!;
    tickH = Math.max(1, Math.abs(priceToY(0) - priceToY(tickPx)));
  }

  // Reserve right strip for price axis + legend
  const AXIS_W = 54;

  // Draw heatmap — clip bids to below snap mid, asks to above
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    const x = timeToX(s.t);
    const nextX = i < snaps.length - 1 ? timeToX(snaps[i + 1]!.t) : x + colW;
    const w = Math.max(1, nextX - x);
    if (x > W - AXIS_W) continue;
    const clipW = Math.min(w + 0.5, W - AXIS_W - x);
    const snapMid = s.mid;

    for (const k in s.bids) {
      const price = Number(k);
      if (price < pLo || price > pHi) continue;
      if (price > snapMid) continue; // bid must be below mid
      const t = normSize(s.bids[k]!, q50log, q95log);
      if (t < 0) continue;
      const y = priceToY(price);
      ctx.fillStyle = bidColor(t);
      ctx.fillRect(x, y - tickH / 2, clipW, tickH + 0.5);
    }
    for (const k in s.asks) {
      const price = Number(k);
      if (price < pLo || price > pHi) continue;
      if (price < snapMid) continue; // ask must be above mid
      const t = normSize(s.asks[k]!, q50log, q95log);
      if (t < 0) continue;
      const y = priceToY(price);
      ctx.fillStyle = askColor(t);
      ctx.fillRect(x, y - tickH / 2, clipW, tickH + 0.5);
    }
  }

  // Mid-price polyline
  ctx.strokeStyle = 'rgba(255, 230, 150, 0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    const x = timeToX(s.t);
    const y = priceToY(s.mid);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Trade prints
  if (opts.showTrades) {
    // normalize trade sizes
    let maxAmt = 0;
    for (const t of trades) if (t.t >= t0 && t.amount > maxAmt) maxAmt = t.amount;
    for (const tr of trades) {
      if (tr.t < t0) continue;
      if (tr.price < pLo || tr.price > pHi) continue;
      const x = timeToX(tr.t);
      const y = priceToY(tr.price);
      const r = Math.max(1.5, Math.min(9, Math.sqrt(tr.amount / Math.max(maxAmt, 1e-9)) * 9));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = tr.side === 'buy'
        ? 'rgba(120, 255, 180, 0.85)'
        : 'rgba(255, 120, 150, 0.85)';
      ctx.fill();
      ctx.strokeStyle = tr.side === 'buy' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // Price axis (right side)
  const dp = pHi > 1000 ? 1 : pHi > 10 ? 2 : pHi > 0.1 ? 4 : 6;
  ctx.fillStyle = 'rgba(200,200,220,0.85)';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const gridSteps = 6;
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridSteps; i++) {
    const p = pLo + (pHi - pLo) * (i / gridSteps);
    const y = priceToY(p);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W - 48, y);
    ctx.stroke();
    ctx.fillText(p.toFixed(dp), W - 4, y);
  }

  // Detector event markers ──────────────────────────────────────────
  for (const e of opts.events) {
    if (e.t < t0) continue;
    if (e.price < pLo || e.price > pHi) continue;
    const x = timeToX(e.t);
    const y = priceToY(e.price);
    const age = now - e.t;
    const ageFade = Math.max(0.25, 1 - age / opts.windowMs);

    if (e.kind === 'wall-pull') {
      // Bright yellow lightning bolt + horizontal dashed ray to indicate where pull happened
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = `rgba(255, 230, 60, ${0.5 * ageFade})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(Math.min(W - 54, x + 80), y);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = `rgba(255, 220, 60, ${ageFade})`;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 240, 120, ${ageFade})`;
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      if (x + 90 < W - 54) ctx.fillText('PULL', x + 10, y);
    } else if (e.kind === 'wall-appeared') {
      // Thick colored line marker
      const col = e.side === 'bid' ? [80, 255, 160] : [255, 120, 140];
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]}, ${ageFade * 0.9})`;
      ctx.fillRect(x - 1, y - 1, 3, 3);
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]}, ${ageFade * 0.4})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.kind === 'absorption') {
      // Dashed circle on the level
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.strokeStyle = `rgba(200, 140, 255, ${ageFade})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Last price marker
  ctx.fillStyle = 'rgba(255, 220, 100, 0.95)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const midY = priceToY(latest.mid);
  ctx.fillRect(W - 50, midY - 7, 50, 14);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillText(latest.mid.toFixed(dp), W - 4, midY);

  // Intensity legend (top-left): two vertical gradient strips, bid + ask
  const legendX = 6, legendY = 6, legendW = 6, legendH = 60;
  for (let i = 0; i <= legendH; i++) {
    const t = 1 - i / legendH;
    ctx.fillStyle = bidColor(t);
    ctx.fillRect(legendX, legendY + i, legendW, 1);
    ctx.fillStyle = askColor(t);
    ctx.fillRect(legendX + legendW + 2, legendY + i, legendW, 1);
  }
  ctx.fillStyle = 'rgba(180,180,200,0.7)';
  ctx.font = '9px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`p95 ${fmtShort(p95)}`, legendX + legendW * 2 + 6, legendY);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`p50 ${fmtShort(p50)}`, legendX + legendW * 2 + 6, legendY + legendH);
}

function fmtShort(v: number): string {
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
