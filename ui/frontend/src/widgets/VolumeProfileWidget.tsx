import { useEffect, useMemo, useRef, useState } from 'react';
import { wsClient } from '../lib/ws-client';

interface Trade {
  price: number;
  amount: number;
  cost: number;
  side: string;
  timestamp: number;
}

function getTickSteps(price: number): number[] {
  if (price > 10000) return [0.1, 0.5, 1, 5, 10, 50, 100];
  if (price > 1000) return [0.01, 0.05, 0.1, 0.5, 1, 5, 10];
  if (price > 100) return [0.01, 0.05, 0.1, 0.5, 1, 5];
  if (price > 10) return [0.001, 0.005, 0.01, 0.05, 0.1, 0.5];
  if (price > 1) return [0.0001, 0.001, 0.005, 0.01, 0.05, 0.1];
  return [0.00001, 0.0001, 0.001, 0.01];
}

function formatPrice(p: number): string {
  if (p > 1000) return p.toFixed(1);
  if (p > 1) return p.toFixed(2);
  return p.toFixed(5);
}

function formatVol(v: number): string {
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  if (v >= 10) return v.toFixed(1);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

interface Bucket {
  price: number;
  buy: number;
  sell: number;
}

const MAX_TRADES = 1000;
const AUTO_TARGET_ROWS = 30;

export function VolumeProfileWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tickIdx, setTickIdx] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTrades([]);
    const channel = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<Trade>(channel, (data) => {
      if (!data.price) return;
      setTrades((prev) => {
        const next = prev.length >= MAX_TRADES ? prev.slice(prev.length - MAX_TRADES + 1) : prev.slice();
        next.push(data);
        return next;
      });
    });
    return unsub;
  }, [exchange, symbol]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const baseName = symbol.split('/')[0] ?? symbol;
  const lastTrade = trades[trades.length - 1];
  const lastPrice = lastTrade?.price ?? 0;

  const { buckets, tickSize, pocPrice, maxVol, totalBuy, totalSell, tickOptions, autoIdx } = useMemo(() => {
    if (trades.length === 0) {
      return {
        buckets: [] as Bucket[], tickSize: 0, pocPrice: 0, maxVol: 0,
        totalBuy: 0, totalSell: 0, tickOptions: [] as number[], autoIdx: 0,
      };
    }
    let lo = Infinity, hi = -Infinity;
    for (const t of trades) { if (t.price < lo) lo = t.price; if (t.price > hi) hi = t.price; }
    const mid = (lo + hi) / 2;
    const options = getTickSteps(mid);
    const span = Math.max(hi - lo, options[0]!);
    let auto = options.length - 1;
    for (let i = 0; i < options.length; i++) {
      if (span / options[i]! <= AUTO_TARGET_ROWS) { auto = i; break; }
    }
    const chosenIdx = tickIdx == null ? auto : Math.min(tickIdx, options.length - 1);
    const tick = options[chosenIdx]!;
    const precision = Math.max(0, -Math.floor(Math.log10(tick)));
    const roundTo = (v: number) => Math.round(Math.floor(v / tick) * tick * 10 ** precision) / 10 ** precision;

    const map = new Map<number, Bucket>();
    let bVol = 0, sVol = 0;
    for (const t of trades) {
      const key = roundTo(t.price);
      let b = map.get(key);
      if (!b) { b = { price: key, buy: 0, sell: 0 }; map.set(key, b); }
      if (t.side === 'buy') { b.buy += t.amount; bVol += t.amount; }
      else { b.sell += t.amount; sVol += t.amount; }
    }
    const loB = roundTo(lo);
    const hiB = roundTo(hi);
    // highest price at top (classic ladder order)
    const list: Bucket[] = [];
    let max = 0;
    let poc = hiB;
    for (let p = hiB; p >= loB - tick / 2; p -= tick) {
      const key = Math.round(p * 10 ** precision) / 10 ** precision;
      const b = map.get(key) ?? { price: key, buy: 0, sell: 0 };
      list.push(b);
      const total = b.buy + b.sell;
      if (total > max) { max = total; poc = key; }
    }
    return {
      buckets: list, tickSize: tick, pocPrice: poc, maxVol: max,
      totalBuy: bVol, totalSell: sVol, tickOptions: options, autoIdx: auto,
    };
  }, [trades, tickIdx]);

  const delta = totalBuy - totalSell;

  return (
    <div className="bg-[#0c0c14] rounded border border-[#1a1a2a] h-full overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[#1a1a2a] shrink-0 text-[10px]">
        <span className="text-gray-400 uppercase tracking-wider">Profile — {baseName}</span>
        <span className="text-green-400 font-mono">↑ {formatVol(totalBuy)}</span>
        <span className="text-red-400 font-mono">↓ {formatVol(totalSell)}</span>
        <span className={`font-mono ${delta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
          Δ {delta >= 0 ? '+' : ''}{formatVol(delta)}
        </span>

        <div className="relative ml-auto" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="text-gray-500 hover:text-gray-300 px-1"
            title="Tick size"
          >
            ⚙
          </button>
          {menuOpen && tickOptions.length > 0 && (
            <div className="absolute right-0 top-full mt-1 bg-[#11111c] border border-[#2a2a3a] rounded shadow-lg z-20 py-1 min-w-[120px]">
              <div className="px-2 py-1 text-[9px] uppercase text-gray-500 tracking-wider">Tick size</div>
              <button
                onClick={() => { setTickIdx(null); setMenuOpen(false); }}
                className={`w-full text-left px-2 py-1 text-[11px] font-mono hover:bg-[#1a1a2a] ${tickIdx == null ? 'text-cyan-400' : 'text-gray-300'}`}
              >
                Auto ({formatPrice(tickOptions[autoIdx]!)})
              </button>
              {tickOptions.map((t, i) => (
                <button
                  key={i}
                  onClick={() => { setTickIdx(i); setMenuOpen(false); }}
                  className={`w-full text-left px-2 py-1 text-[11px] font-mono hover:bg-[#1a1a2a] ${tickIdx === i ? 'text-cyan-400' : 'text-gray-300'}`}
                >
                  {formatPrice(t)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Vertical profile ladder */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-600 text-xs">Waiting for trades...</div>
        ) : (
          <div className="flex flex-col">
            {buckets.map((b, i) => {
              const isPoc = b.price === pocPrice && maxVol > 0;
              const isLast = lastPrice >= b.price && lastPrice < b.price + tickSize;
              const total = b.buy + b.sell;
              const buyPct = maxVol > 0 ? (b.buy / maxVol) * 100 : 0;
              const sellPct = maxVol > 0 ? (b.sell / maxVol) * 100 : 0;
              return (
                <div
                  key={i}
                  className={`flex items-center h-[18px] px-1 text-[10px] font-mono relative ${isPoc ? 'bg-yellow-400/5' : ''} ${isLast ? 'ring-1 ring-inset ring-cyan-400/60' : ''}`}
                  title={`${formatPrice(b.price)}\n↑ ${formatVol(b.buy)}  ↓ ${formatVol(b.sell)}`}
                >
                  {/* Price column */}
                  <div className={`w-16 shrink-0 text-right pr-2 ${isPoc ? 'text-yellow-300' : isLast ? 'text-cyan-300' : 'text-gray-400'}`}>
                    {formatPrice(b.price)}
                  </div>

                  {/* Bars: buy bar (left-anchored) stacked above sell, or side by side in center strip */}
                  <div className="flex-1 h-full flex items-center relative">
                    {/* Buy bar grows from center-left to right */}
                    <div className="absolute inset-y-[3px] left-1/2 right-0 flex items-center">
                      <div
                        className={`${isPoc ? 'bg-green-400' : 'bg-green-500/70'} h-full`}
                        style={{ width: `${buyPct}%` }}
                      />
                    </div>
                    {/* Sell bar grows from center-right to left */}
                    <div className="absolute inset-y-[3px] right-1/2 left-0 flex items-center justify-end">
                      <div
                        className={`${isPoc ? 'bg-red-400' : 'bg-red-500/70'} h-full`}
                        style={{ width: `${sellPct}%` }}
                      />
                    </div>
                    {/* center divider */}
                    <div className="absolute inset-y-0 left-1/2 w-px bg-[#1a1a2a]" />
                  </div>

                  {/* Volume column */}
                  <div className="w-14 shrink-0 text-right pl-2 text-gray-500">
                    {total > 0 ? formatVol(total) : ''}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      {trades.length > 0 && (
        <div className="flex justify-between px-2 py-[2px] text-[9px] text-gray-600 font-mono shrink-0 border-t border-[#1a1a2a]">
          <span>POC {formatPrice(pocPrice)}</span>
          <span>{buckets.length} lvls @ {formatPrice(tickSize)}</span>
        </div>
      )}
    </div>
  );
}
