import { useEffect, useRef } from 'react';
import { wsClient } from '../lib/ws-client';

interface PricePoint {
  price: number;
  time: number;
}

export function PriceChartWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<PricePoint[]>([]);
  const maxPoints = 300;

  useEffect(() => {
    pointsRef.current = [];
    const channel = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe(channel, (data) => {
      const price = data.price as number;
      if (!price) return;
      const pts = pointsRef.current;
      pts.push({ price, time: Date.now() });
      if (pts.length > maxPoints) pts.splice(0, pts.length - maxPoints);
    });
    return unsub;
  }, [exchange, symbol]);

  // Render loop
  useEffect(() => {
    let raf: number;
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) { raf = requestAnimationFrame(draw); return; }
      const ctx = canvas.getContext('2d');
      if (!ctx) { raf = requestAnimationFrame(draw); return; }

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const w = rect.width;
      const h = rect.height;

      ctx.clearRect(0, 0, w, h);

      const pts = pointsRef.current;
      if (pts.length < 2) {
        ctx.fillStyle = '#333';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Collecting data...', w / 2, h / 2);
        raf = requestAnimationFrame(draw);
        return;
      }

      const prices = pts.map((p) => p.price);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      const range = maxP - minP || 1;
      const padding = 2;

      // Gradient fill
      const isUp = prices[prices.length - 1]! >= prices[0]!;
      const color = isUp ? [34, 197, 94] : [239, 68, 68]; // green / red

      // Draw area
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = (i / (pts.length - 1)) * w;
        const y = padding + (1 - (pts[i]!.price - minP) / range) * (h - padding * 2 - 12);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      // Close area to bottom
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, `rgba(${color.join(',')}, 0.15)`);
      grad.addColorStop(1, `rgba(${color.join(',')}, 0.02)`);
      ctx.fillStyle = grad;
      ctx.fill();

      // Draw line
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = (i / (pts.length - 1)) * w;
        const y = padding + (1 - (pts[i]!.price - minP) / range) * (h - padding * 2 - 12);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(${color.join(',')}, 0.8)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Current price label
      const lastPrice = prices[prices.length - 1]!;
      const dp = lastPrice > 1000 ? 1 : lastPrice > 1 ? 2 : 4;
      ctx.fillStyle = `rgba(${color.join(',')}, 0.9)`;
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(lastPrice.toFixed(dp), w - 3, h - 2);

      // Price range
      ctx.fillStyle = '#444';
      ctx.font = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(maxP.toFixed(dp), 3, 10);
      ctx.fillText(minP.toFixed(dp), 3, h - 2);

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [exchange, symbol]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full bg-[#08080e] rounded border border-[#1a1a2a]"
      style={{ height: 80 }}
    />
  );
}
