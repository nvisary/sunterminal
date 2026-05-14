import { useEffect, useMemo, useRef, useState } from "react";
import { wsClient, API_BASE } from "../lib/ws-client";

interface FootprintLevel {
  price: number;
  buy: number;
  sell: number;
}

interface FootprintCandle {
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  poc: number;
  levels: FootprintLevel[];
}

interface FootprintSnapshot {
  exchange: string;
  symbol: string;
  timeframeMs: number;
  tickSize: number;
  candles: FootprintCandle[];
  timestamp: number;
}

const COL_W = 70;
const ROW_H = 14;

// Backend publishes 1m candles. The UI re-aggregates them into 5m / 15m
// buckets on the fly so we don't need separate streams per timeframe.
const TIMEFRAMES = [
  { id: "1m", groupBy: 1 },
  { id: "5m", groupBy: 5 },
  { id: "15m", groupBy: 15 },
] as const;

function groupCandles(
  candles: FootprintCandle[],
  groupBy: number,
  baseMs: number,
): FootprintCandle[] {
  if (groupBy === 1) return candles;
  const groupMs = groupBy * baseMs;
  const out: FootprintCandle[] = [];
  let cur: FootprintCandle | null = null;
  let levelAgg: Map<number, FootprintLevel> | null = null;
  for (const c of candles) {
    const slot = Math.floor(c.startMs / groupMs) * groupMs;
    if (!cur || cur.startMs !== slot) {
      if (cur && levelAgg) {
        cur.levels = Array.from(levelAgg.values()).sort(
          (a, b) => a.price - b.price,
        );
        cur.poc = findPoc(cur.levels);
      }
      cur = {
        startMs: slot,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        poc: c.poc,
        levels: [],
      };
      levelAgg = new Map();
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
    for (const lvl of c.levels) {
      const existing = levelAgg!.get(lvl.price) ?? {
        price: lvl.price,
        buy: 0,
        sell: 0,
      };
      existing.buy += lvl.buy;
      existing.sell += lvl.sell;
      levelAgg!.set(lvl.price, existing);
    }
  }
  if (cur && levelAgg) {
    cur.levels = Array.from(levelAgg.values()).sort(
      (a, b) => a.price - b.price,
    );
    cur.poc = findPoc(cur.levels);
  }
  return out;
}

function findPoc(levels: FootprintLevel[]): number {
  let pocPrice = 0;
  let pocVol = 0;
  for (const l of levels) {
    const v = l.buy + l.sell;
    if (v > pocVol) {
      pocVol = v;
      pocPrice = l.price;
    }
  }
  return pocPrice;
}

export function FootprintWidget({
  exchange,
  symbol,
}: {
  exchange: string;
  symbol: string;
}) {
  const [tfIdx, setTfIdx] = useState(0);
  const [snapshot, setSnapshot] = useState<FootprintSnapshot | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 600, h: 300 });

  // Reset + initial snapshot fetch + live subscription.
  useEffect(() => {
    setSnapshot(null);
    let cancelled = false;
    fetch(
      `${API_BASE}/api/snapshot/footprint/${exchange}/${encodeURIComponent(symbol)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: FootprintSnapshot | null) => {
        if (!cancelled && data) setSnapshot(data);
      })
      .catch(() => {});

    const channel = `footprint:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<FootprintSnapshot>(channel, (data) => {
      if (!cancelled) setSnapshot(data);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [exchange, symbol]);

  // Resize observer.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const candles = useMemo(() => {
    if (!snapshot) return [];
    return groupCandles(
      snapshot.candles,
      TIMEFRAMES[tfIdx]!.groupBy,
      snapshot.timeframeMs,
    );
  }, [snapshot, tfIdx]);

  const stats = useMemo(() => {
    if (candles.length === 0) return null;
    let priceMin = Infinity;
    let priceMax = -Infinity;
    let maxVol = 0;
    for (const c of candles) {
      priceMin = Math.min(priceMin, c.low);
      priceMax = Math.max(priceMax, c.high);
      for (const lvl of c.levels) {
        const v = lvl.buy + lvl.sell;
        if (v > maxVol) maxVol = v;
      }
    }
    return { priceMin, priceMax, maxVol };
  }, [candles]);

  // Canvas paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(containerSize.w * dpr);
    canvas.height = Math.floor(containerSize.h * dpr);
    canvas.style.width = `${containerSize.w}px`;
    canvas.style.height = `${containerSize.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, containerSize.w, containerSize.h);

    if (candles.length === 0 || !stats || !snapshot) {
      ctx.fillStyle = "#52525b";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        snapshot === null
          ? "Loading footprint..."
          : "Waiting for trades...",
        containerSize.w / 2,
        containerSize.h / 2,
      );
      return;
    }

    const tick = snapshot.tickSize || 0.01;
    const priceRangePadded = Math.max(
      stats.priceMax - stats.priceMin,
      tick * 4,
    );
    const topPrice = stats.priceMax + tick;
    const rowsVisible = Math.max(8, Math.floor(containerSize.h / ROW_H));
    const pricePerRow = Math.max(tick, priceRangePadded / rowsVisible);

    const priceToY = (p: number) => ((topPrice - p) / pricePerRow) * ROW_H;

    // Price axis (right side)
    ctx.fillStyle = "#71717a";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    const axisX = containerSize.w - 2;
    for (let i = 0; i < rowsVisible; i++) {
      const p = topPrice - i * pricePerRow;
      const y = priceToY(p);
      if (y > containerSize.h) break;
      ctx.fillText(
        p.toFixed(tick >= 1 ? 0 : tick >= 0.01 ? 2 : 4),
        axisX,
        y + 10,
      );
    }

    // Candles
    const visibleCols = Math.min(
      candles.length,
      Math.floor((containerSize.w - 50) / COL_W),
    );
    const startIdx = candles.length - visibleCols;
    for (let i = 0; i < visibleCols; i++) {
      const c = candles[startIdx + i]!;
      const x0 = i * COL_W;
      ctx.strokeStyle = "#1a1a2a";
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, containerSize.h);
      ctx.stroke();

      for (const lvl of c.levels) {
        const y = priceToY(lvl.price);
        if (y < -ROW_H || y > containerSize.h) continue;
        const total = lvl.buy + lvl.sell;
        const intensity = stats.maxVol > 0 ? total / stats.maxVol : 0;

        if (lvl.price === c.poc) {
          ctx.fillStyle = "rgba(250, 204, 21, 0.15)";
          ctx.fillRect(x0 + 1, y, COL_W - 2, ROW_H);
        }

        ctx.font = "9px monospace";
        ctx.fillStyle = `rgba(34, 197, 94, ${0.35 + intensity * 0.65})`;
        ctx.textAlign = "left";
        ctx.fillText(
          lvl.buy >= 1000
            ? `${(lvl.buy / 1000).toFixed(1)}k`
            : lvl.buy.toFixed(lvl.buy >= 10 ? 1 : 2),
          x0 + 4,
          y + 10,
        );
        ctx.fillStyle = `rgba(239, 68, 68, ${0.35 + intensity * 0.65})`;
        ctx.textAlign = "right";
        ctx.fillText(
          lvl.sell >= 1000
            ? `${(lvl.sell / 1000).toFixed(1)}k`
            : lvl.sell.toFixed(lvl.sell >= 10 ? 1 : 2),
          x0 + COL_W - 4,
          y + 10,
        );
      }

      ctx.fillStyle = "#52525b";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      const d = new Date(c.startMs);
      const label = `${d.getHours().toString().padStart(2, "0")}:${d
        .getMinutes()
        .toString()
        .padStart(2, "0")}`;
      ctx.fillText(label, x0 + COL_W / 2, containerSize.h - 2);
    }
  }, [containerSize, candles, stats, snapshot]);

  return (
    <div className="h-full flex flex-col bg-[#0a0a0f] text-zinc-300">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[#1a1a2a] shrink-0">
        <span className="text-[10px] text-gray-500 uppercase mr-1">TF</span>
        {TIMEFRAMES.map((tf, i) => (
          <button
            key={tf.id}
            onClick={() => setTfIdx(i)}
            className={`px-1.5 py-0.5 text-[10px] rounded ${
              tfIdx === i
                ? "bg-[#2a2a4a] text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {tf.id}
          </button>
        ))}
        <div className="flex-1" />
        <span className="text-[9px] text-gray-600">
          {candles.length} bars
        </span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
