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

  const { buckets, tickSize, pocPrice, maxVol, totalBuy, totalSell, tickOptions, autoIdx, vah, val } = useMemo(() => {
    if (trades.length === 0) {
      return {
        buckets: [] as Bucket[], tickSize: 0, pocPrice: 0, maxVol: 0,
        totalBuy: 0, totalSell: 0, tickOptions: [] as number[], autoIdx: 0,
        vah: 0, val: 0,
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
    // Compute Value Area (70% of volume around POC)
    let vahPrice = poc, valPrice = poc;
    const totalVol = bVol + sVol;
    if (totalVol > 0 && list.length > 0) {
      const pocIdx = list.findIndex((b) => b.price === poc);
      if (pocIdx !== -1) {
        let acc = (list[pocIdx]!.buy + list[pocIdx]!.sell);
        const target = totalVol * 0.7;
        let hi2 = pocIdx, lo2 = pocIdx;
        while (acc < target && (hi2 > 0 || lo2 < list.length - 1)) {
          const up = hi2 > 0 ? (list[hi2 - 1]!.buy + list[hi2 - 1]!.sell) : -1;
          const dn = lo2 < list.length - 1 ? (list[lo2 + 1]!.buy + list[lo2 + 1]!.sell) : -1;
          if (up >= dn && hi2 > 0) { hi2--; acc += list[hi2]!.buy + list[hi2]!.sell; }
          else if (lo2 < list.length - 1) { lo2++; acc += list[lo2]!.buy + list[lo2]!.sell; }
          else break;
        }
        vahPrice = list[hi2]!.price; // higher price (top of ladder)
        valPrice = list[lo2]!.price; // lower price (bottom of ladder)
      }
    }

    return {
      buckets: list, tickSize: tick, pocPrice: poc, maxVol: max,
      totalBuy: bVol, totalSell: sVol, tickOptions: options, autoIdx: auto,
      vah: vahPrice, val: valPrice,
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
              const inVA = b.price <= vah && b.price >= val && maxVol > 0;
              const total = b.buy + b.sell;
              const totalPct = maxVol > 0 ? (total / maxVol) * 100 : 0;
              const buyShare = total > 0 ? b.buy / total : 0;
              const delta = b.buy - b.sell;
              const deltaAbs = Math.max(Math.abs(delta), 0.0001);
              const deltaMax = maxVol; // normalize over full scale
              const deltaPct = Math.min(100, (deltaAbs / deltaMax) * 100);
              return (
                <div
                  key={i}
                  className={`flex items-center h-[18px] px-1 text-[10px] font-mono relative ${
                    isPoc ? 'bg-yellow-400/10' : inVA ? 'bg-purple-500/[0.06]' : ''
                  } ${isLast ? 'ring-1 ring-inset ring-cyan-400/60' : ''}`}
                  title={`${formatPrice(b.price)}\n↑ ${formatVol(b.buy)}  ↓ ${formatVol(b.sell)}  Δ ${delta >= 0 ? '+' : ''}${formatVol(delta)}`}
                >
                  {/* Price column (left) */}
                  <div className={`w-16 shrink-0 text-right pr-2 ${
                    isPoc ? 'text-yellow-300 font-bold' : isLast ? 'text-cyan-300' : 'text-gray-400'
                  }`}>
                    {formatPrice(b.price)}
                  </div>

                  {/* Stacked bar (left-anchored, extends right) */}
                  <div className="flex-1 h-full relative">
                    <div
                      className="absolute inset-y-[3px] left-0 flex overflow-hidden rounded-sm"
                      style={{ width: `${totalPct}%` }}
                    >
                      <div
                        className={isPoc ? 'bg-green-400' : 'bg-green-500/75'}
                        style={{ width: `${buyShare * 100}%` }}
                      />
                      <div
                        className={`flex-1 ${isPoc ? 'bg-red-400' : 'bg-red-500/75'}`}
                      />
                    </div>
                    {/* Delta sub-bar (thin, below main) */}
                    {total > 0 && (
                      <div
                        className={`absolute bottom-0 left-0 h-[2px] ${delta >= 0 ? 'bg-green-300/80' : 'bg-red-300/80'}`}
                        style={{ width: `${deltaPct}%` }}
                      />
                    )}
                  </div>

                  {/* Volume column (right) */}
                  <div className={`w-14 shrink-0 text-right pl-2 tabular-nums ${isPoc ? 'text-yellow-200' : 'text-gray-500'}`}>
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
        <div className="flex justify-between px-2 py-[2px] text-[9px] text-gray-600 font-mono shrink-0 border-t border-[#1a1a2a] gap-2">
          <span className="text-yellow-400/80">POC {formatPrice(pocPrice)}</span>
          <span className="text-purple-300/70">VA [{formatPrice(val)} — {formatPrice(vah)}]</span>
          <span>{buckets.length}@{formatPrice(tickSize)}</span>
        </div>
      )}
    </div>
  );
}
