import { useEffect, useState, useMemo } from 'react';
import { API_BASE, wsClient } from '../lib/ws-client';

const API = `${API_BASE}/api`;

interface JournalRecord {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  fees: number;
  fundingPaid: number;
  realizedPnl: number | null;
  netPnl: number | null;
  closedAt: number | null;
  duration: number | null;
}

interface EquityPoint {
  equity: number;
  unrealizedPnl: number;
  timestamp: number;
}

function EquityChart({ points }: { points: EquityPoint[] }) {
  const { path, min, max, last } = useMemo(() => {
    if (points.length < 2) return { path: '', min: 0, max: 0, last: 0 };
    const ys = points.map((p) => p.equity);
    const min = Math.min(...ys);
    const max = Math.max(...ys);
    const last = ys[ys.length - 1]!;
    const range = max - min || 1;
    const w = 240;
    const h = 60;
    const dx = w / (points.length - 1);
    const path = points.map((p, i) => {
      const x = i * dx;
      const y = h - ((p.equity - min) / range) * h;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    return { path, min, max, last };
  }, [points]);

  if (points.length < 2) {
    return <div className="text-gray-600 text-[10px] text-center py-3">Equity curve appears once you trade</div>;
  }

  return (
    <div className="bg-[#0a0a14] rounded border border-[#1a1a2a] p-2">
      <div className="flex justify-between text-[9px] text-gray-500 mb-1">
        <span>Equity (sim)</span>
        <span className="font-mono text-gray-300">${last.toFixed(2)}</span>
      </div>
      <svg width="100%" viewBox="0 0 240 60" preserveAspectRatio="none" className="w-full h-12">
        <path d={path} fill="none" stroke="#fbbf24" strokeWidth="1.2" />
      </svg>
      <div className="flex justify-between text-[9px] text-gray-600 mt-0.5 font-mono">
        <span>min ${min.toFixed(2)}</span>
        <span>max ${max.toFixed(2)}</span>
      </div>
    </div>
  );
}

export function SimJournalWidget() {
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const closed = useMemo(() => records.filter((r) => r.closedAt != null && r.netPnl != null), [records]);

  const stats = useMemo(() => {
    if (closed.length === 0) return null;
    const wins = closed.filter((r) => (r.netPnl ?? 0) > 0);
    const losses = closed.filter((r) => (r.netPnl ?? 0) <= 0);
    const totalPnl = closed.reduce((s, r) => s + (r.netPnl ?? 0), 0);
    const winRate = (wins.length / closed.length) * 100;
    const avgWin = wins.length ? wins.reduce((s, r) => s + (r.netPnl ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, r) => s + (r.netPnl ?? 0), 0) / losses.length : 0;
    const totalWins = wins.reduce((s, r) => s + (r.netPnl ?? 0), 0);
    const totalLosses = Math.abs(losses.reduce((s, r) => s + (r.netPnl ?? 0), 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? Infinity : 0);
    return { count: closed.length, wins: wins.length, losses: losses.length, winRate, totalPnl, avgWin, avgLoss, profitFactor };
  }, [closed]);

  useEffect(() => {
    const refresh = () => {
      fetch(`${API}/sim/journal`).then((r) => r.json()).then((data: JournalRecord[]) => setRecords(data ?? []));
      fetch(`${API}/sim/equity-curve`).then((r) => r.json()).then((data: EquityPoint[]) => setEquity(data ?? []));
    };
    refresh();
    const unsub = wsClient.subscribe('sim:journal', () => refresh());
    return unsub;
  }, []);

  return (
    <div className="bg-[#111118] rounded border border-yellow-700/40 p-2 h-full flex flex-col">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider flex justify-between">
        <span>Sim Journal <span className="text-yellow-400 ml-1">· SIM</span></span>
        <span className="text-[10px] text-gray-600">{closed.length}</span>
      </div>

      <div className="mb-2"><EquityChart points={equity} /></div>

      {stats && (
        <div className="grid grid-cols-4 gap-1 mb-2 text-[10px] font-mono">
          <div className="bg-[#0a0a14] rounded px-1.5 py-1 border border-[#1a1a2a]">
            <div className="text-gray-500 text-[9px]">Trades</div>
            <div className="text-gray-200">{stats.count}</div>
          </div>
          <div className="bg-[#0a0a14] rounded px-1.5 py-1 border border-[#1a1a2a]">
            <div className="text-gray-500 text-[9px]">Win %</div>
            <div className={stats.winRate >= 50 ? 'text-green-400' : 'text-amber-400'}>{stats.winRate.toFixed(0)}%</div>
          </div>
          <div className="bg-[#0a0a14] rounded px-1.5 py-1 border border-[#1a1a2a]">
            <div className="text-gray-500 text-[9px]">PF</div>
            <div className={stats.profitFactor >= 1 ? 'text-green-400' : 'text-red-400'}>
              {Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}
            </div>
          </div>
          <div className="bg-[#0a0a14] rounded px-1.5 py-1 border border-[#1a1a2a]">
            <div className="text-gray-500 text-[9px]">PnL</div>
            <div className={stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}>
              {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {closed.length === 0 ? (
          <div className="text-gray-600 text-center text-xs py-4">No trades yet</div>
        ) : (
          <table className="w-full text-[10px] font-mono">
            <thead className="text-gray-500 sticky top-0 bg-[#111118]">
              <tr className="text-left">
                <th className="px-1 py-1">Symbol</th>
                <th className="px-1 py-1">Side</th>
                <th className="px-1 py-1 text-right">Entry</th>
                <th className="px-1 py-1 text-right">Exit</th>
                <th className="px-1 py-1 text-right">PnL</th>
                <th className="px-1 py-1 text-right">Dur</th>
              </tr>
            </thead>
            <tbody>
              {closed.slice().reverse().slice(0, 100).map((r) => {
                const pnl = r.netPnl ?? 0;
                const color = pnl >= 0 ? 'text-green-400' : 'text-red-400';
                const dur = r.duration ? `${(r.duration / 1000).toFixed(0)}s` : '—';
                return (
                  <tr key={r.id} className="border-t border-[#1a1a2a] hover:bg-[#15151f]">
                    <td className="px-1 py-1 text-gray-300">{r.symbol.split('/')[0]}</td>
                    <td className={`px-1 py-1 ${r.side === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                      {r.side === 'long' ? 'L' : 'S'}
                    </td>
                    <td className="px-1 py-1 text-right text-gray-400">{r.entryPrice.toFixed(2)}</td>
                    <td className="px-1 py-1 text-right text-gray-400">{r.exitPrice?.toFixed(2) ?? '—'}</td>
                    <td className={`px-1 py-1 text-right ${color}`}>
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                    </td>
                    <td className="px-1 py-1 text-right text-gray-500">{dur}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
