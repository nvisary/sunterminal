import { useEffect, useMemo, useRef, useState } from "react";
import { wsClient } from "../lib/ws-client";

interface Trade {
  price: number;
  amount: number;
  side: "buy" | "sell";
  timestamp: number;
}

interface PriceLevel {
  buy: number;
  sell: number;
}

interface Candle {
  startMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  levels: Map<number, PriceLevel>;
}

const TIMEFRAMES = [
  { id: "1m", ms: 60_000 },
  { id: "5m", ms: 5 * 60_000 },
  { id: "15m", ms: 15 * 60_000 },
] as const;

const MAX_CANDLES = 40;
const COL_W = 70;
const ROW_H = 14;

function candleStart(ts: number, tfMs: number): number {
  return Math.floor(ts / tfMs) * tfMs;
}

// Tick step derived from price magnitude. Mirrors OrderBookWidget heuristic
// so footprint rows align with what users see in the DOM.
function tickFromPrice(p: number): number {
  if (p > 10000) return 5;
  if (p > 1000) return 0.5;
  if (p > 100) return 0.1;
  if (p > 10) return 0.01;
  if (p > 1) return 0.001;
  return 0.0001;
}

function bucket(price: number, tick: number): number {
  return Math.round(Math.floor(price / tick) * tick * 1e8) / 1e8;
}

export function FootprintWidget({
  exchange,
  symbol,
}: {
  exchange: string;
  symbol: string;
}) {
  const [tfIdx, setTfIdx] = useState(0);
  const tfMs = TIMEFRAMES[tfIdx]!.ms;

  const candlesRef = useRef<Candle[]>([]);
  const [, force] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 600, h: 300 });

  // Reset on symbol / timeframe change.
  useEffect(() => {
    candlesRef.current = [];
    force((n) => n + 1);
  }, [exchange, symbol, tfMs]);

  // Trade subscription.
  useEffect(() => {
    const channel = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<Trade>(channel, (t) => {
      if (!t.price || !t.amount) return;
      const tick = tickFromPrice(t.price);
      const slot = candleStart(t.timestamp, tfMs);
      const candles = candlesRef.current;
      let candle = candles[candles.length - 1];
      if (!candle || candle.startMs !== slot) {
        candle = {
          startMs: slot,
          open: t.price,
          high: t.price,
          low: t.price,
          close: t.price,
          levels: new Map(),
        };
        candles.push(candle);
        if (candles.length > MAX_CANDLES) candles.shift();
      }
      candle.high = Math.max(candle.high, t.price);
      candle.low = Math.min(candle.low, t.price);
      candle.close = t.price;
      const k = bucket(t.price, tick);
      const lvl = candle.levels.get(k) ?? { buy: 0, sell: 0 };
      if (t.side === "buy") lvl.buy += t.amount;
      else lvl.sell += t.amount;
      candle.levels.set(k, lvl);
    });
    return unsub;
  }, [exchange, symbol, tfMs]);

  // Periodic redraw — trades come in bursts; we coalesce repaints to 4 Hz.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

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

  // Stats used by the renderer.
  const stats = useMemo(() => {
    const candles = candlesRef.current;
    if (candles.length === 0) return null;
    let priceMin = Infinity;
    let priceMax = -Infinity;
    let maxVol = 0;
    for (const c of candles) {
      priceMin = Math.min(priceMin, c.low);
      priceMax = Math.max(priceMax, c.high);
      for (const lvl of c.levels.values()) {
        if (lvl.buy + lvl.sell > maxVol) maxVol = lvl.buy + lvl.sell;
      }
    }
    return { priceMin, priceMax, maxVol };
  }, [containerSize, tfMs]);

  // Canvas paint.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const candles = candlesRef.current;
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

    if (candles.length === 0 || !stats) {
      ctx.fillStyle = "#52525b";
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText(
        "Waiting for trades...",
        containerSize.w / 2,
        containerSize.h / 2,
      );
      return;
    }

    const lastPrice = candles[candles.length - 1]!.close;
    const tick = tickFromPrice(lastPrice);
    const priceRangePadded = Math.max(
      stats.priceMax - stats.priceMin,
      tick * 4,
    );
    const topPrice = stats.priceMax + tick;
    const rowsVisible = Math.max(8, Math.floor(containerSize.h / ROW_H));
    const pricePerRow = Math.max(tick, priceRangePadded / rowsVisible);

    const priceToY = (p: number) =>
      ((topPrice - p) / pricePerRow) * ROW_H;

    // Price axis (right side)
    ctx.fillStyle = "#71717a";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    const axisX = containerSize.w - 2;
    for (let i = 0; i < rowsVisible; i++) {
      const p = topPrice - i * pricePerRow;
      const y = priceToY(p);
      if (y > containerSize.h) break;
      ctx.fillText(p.toFixed(tick >= 1 ? 0 : tick >= 0.01 ? 2 : 4), axisX, y + 10);
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
      // Column separator
      ctx.strokeStyle = "#1a1a2a";
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.lineTo(x0, containerSize.h);
      ctx.stroke();

      // Find POC for this candle (price with max combined volume)
      let pocPrice = 0;
      let pocVol = 0;
      for (const [price, lvl] of c.levels) {
        const v = lvl.buy + lvl.sell;
        if (v > pocVol) {
          pocVol = v;
          pocPrice = price;
        }
      }

      for (const [price, lvl] of c.levels) {
        const y = priceToY(price);
        if (y < -ROW_H || y > containerSize.h) continue;
        const total = lvl.buy + lvl.sell;
        const intensity = stats.maxVol > 0 ? total / stats.maxVol : 0;

        // POC highlight
        if (price === pocPrice) {
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

      // Candle time label
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
  }, [containerSize, stats, tfMs]);

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
          {candlesRef.current.length}/{MAX_CANDLES} bars
        </span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 relative">
        <canvas ref={canvasRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
