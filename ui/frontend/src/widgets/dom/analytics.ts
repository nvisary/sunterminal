import { useEffect, useRef, useState } from 'react';
import { wsClient } from '../../lib/ws-client';

export interface TradeTick {
  price: number;
  amount: number;
  side: string;      // 'buy' | 'sell'
  timestamp?: number;
  time?: number;
}

export interface PriceStats { buyVol: number; sellVol: number }

/**
 * Accumulates session-wide volume at price and exposes a delta print buffer.
 * Resets on exchange/symbol change.
 */
export function useTradeAggregates(exchange: string, symbol: string) {
  // ref-based so we don't re-render on every trade
  const volAtPriceRef = useRef<Map<number, PriceStats>>(new Map());
  const recentTradesRef = useRef<TradeTick[]>([]); // for speed-of-tape (rolling 3s)
  const printsRef = useRef<Map<number, { side: 'buy' | 'sell'; amount: number; time: number }>>(new Map());
  const [tick, setTick] = useState(0); // force-rerender pulse

  useEffect(() => {
    volAtPriceRef.current.clear();
    recentTradesRef.current = [];
    printsRef.current.clear();
    setTick((t) => t + 1);

    const ch = `trades:${exchange}:${symbol}`;
    const unsub = wsClient.subscribe<TradeTick>(ch, (t) => {
      if (!t.price || !t.amount) return;
      const price = t.price;
      const side: 'buy' | 'sell' = t.side === 'buy' ? 'buy' : 'sell';
      const now = Date.now();

      // VP accumulation — keyed by raw price (will be aggregated per tick-size at render)
      const m = volAtPriceRef.current;
      const key = Math.round(price * 1e8) / 1e8;
      const cur = m.get(key) ?? { buyVol: 0, sellVol: 0 };
      if (side === 'buy') cur.buyVol += t.amount;
      else cur.sellVol += t.amount;
      m.set(key, cur);

      // Tape speed window (keep last 5s)
      recentTradesRef.current.push({ ...t, side, time: now });
      const cutoff = now - 5000;
      while (recentTradesRef.current.length && (recentTradesRef.current[0]!.time ?? 0) < cutoff) {
        recentTradesRef.current.shift();
      }

      // Prints for DOM flash (keyed by rounded price)
      const pKey = Math.round(price * 1e6) / 1e6;
      printsRef.current.set(pKey, { side, amount: t.amount, time: now });
    });

    const cleaner = setInterval(() => {
      const now = Date.now();
      for (const [k, p] of printsRef.current) {
        if (now - p.time > 3000) printsRef.current.delete(k);
      }
      setTick((t) => t + 1); // drive animations / tape refresh
    }, 250);

    return () => { unsub(); clearInterval(cleaner); };
  }, [exchange, symbol]);

  return { volAtPriceRef, recentTradesRef, printsRef, tick };
}

/**
 * Aggregate raw price → tick-bucketed volume-at-price map.
 */
export function aggregateVP(
  raw: Map<number, PriceStats>,
  tickSize: number,
): Map<number, PriceStats> {
  const precision = Math.max(0, -Math.floor(Math.log10(tickSize)));
  const factor = 10 ** precision;
  const round = (v: number) => Math.round(Math.floor(v / tickSize) * tickSize * factor) / factor;
  const out = new Map<number, PriceStats>();
  for (const [p, s] of raw) {
    const k = round(p);
    const cur = out.get(k) ?? { buyVol: 0, sellVol: 0 };
    cur.buyVol += s.buyVol;
    cur.sellVol += s.sellVol;
    out.set(k, cur);
  }
  return out;
}

/**
 * Compute POC + value area (70% of volume) around POC.
 */
export function computePocVA(vp: Map<number, PriceStats>): {
  poc: number | null;
  vah: number | null;
  val: number | null;
  totalVol: number;
} {
  if (vp.size === 0) return { poc: null, vah: null, val: null, totalVol: 0 };
  let poc = 0, pocVol = 0, totalVol = 0;
  const entries: Array<[number, number]> = [];
  for (const [p, s] of vp) {
    const v = s.buyVol + s.sellVol;
    entries.push([p, v]);
    totalVol += v;
    if (v > pocVol) { pocVol = v; poc = p; }
  }
  entries.sort((a, b) => a[0] - b[0]);
  const target = totalVol * 0.7;
  let acc = pocVol;
  let lo = entries.findIndex((e) => e[0] === poc);
  let hi = lo;
  while (acc < target && (lo > 0 || hi < entries.length - 1)) {
    const below = lo > 0 ? entries[lo - 1]![1] : -1;
    const above = hi < entries.length - 1 ? entries[hi + 1]![1] : -1;
    if (below >= above && lo > 0) { lo--; acc += entries[lo]![1]; }
    else if (hi < entries.length - 1) { hi++; acc += entries[hi]![1]; }
    else break;
  }
  return { poc, vah: entries[hi]![0], val: entries[lo]![0], totalVol };
}

/**
 * Tape speed: trades/sec and $ volume/sec over rolling window (default 2s),
 * plus cumulative delta over that window.
 */
export function computeTapeSpeed(
  trades: TradeTick[],
  windowMs = 2000,
): { tps: number; usdPerSec: number; delta: number; hot: 'cold' | 'warm' | 'hot' } {
  const now = Date.now();
  const cutoff = now - windowMs;
  let n = 0, usd = 0, delta = 0;
  for (const t of trades) {
    if ((t.time ?? 0) < cutoff) continue;
    n++;
    const notional = t.price * t.amount;
    usd += notional;
    if (t.side === 'buy') delta += notional; else delta -= notional;
  }
  const seconds = windowMs / 1000;
  const tps = n / seconds;
  const usdPerSec = usd / seconds;
  let hot: 'cold' | 'warm' | 'hot' = 'cold';
  if (tps > 15 || usdPerSec > 50_000) hot = 'hot';
  else if (tps > 4 || usdPerSec > 10_000) hot = 'warm';
  return { tps, usdPerSec, delta, hot };
}
