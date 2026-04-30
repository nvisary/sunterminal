import { useEffect, useState } from 'react';
import { API_BASE, wsClient } from '../lib/ws-client';
import { useSimStore, type SimPosition, type SimExposure } from '../stores/sim.store';

const API = `${API_BASE}/api`;

async function refreshPositions(): Promise<void> {
  try {
    const res = await fetch(`${API}/sim/positions`);
    const data = (await res.json()) as SimPosition[];
    useSimStore.getState().setPositions(data);
  } catch {
    // ignore
  }
}

export function SimPositionsWidget() {
  const positions = useSimStore((s) => s.positions);
  const [closing, setClosing] = useState<string | null>(null);

  useEffect(() => {
    refreshPositions();
    // Re-fetch positions when exposure ticks (cheap, no extra stream needed for v1)
    const unsub = wsClient.subscribe<SimExposure>('sim:exposure', () => {
      refreshPositions();
    });
    const id = setInterval(refreshPositions, 3000);
    return () => { unsub(); clearInterval(id); };
  }, []);

  const closePosition = async (id: string) => {
    setClosing(id);
    try {
      await fetch(`${API}/sim/trade/close/${id}`, { method: 'POST' });
      // Optimistic: refresh shortly
      setTimeout(refreshPositions, 500);
    } finally {
      setClosing(null);
    }
  };

  return (
    <div className="bg-[#111118] rounded border border-yellow-700/40 p-2 h-full flex flex-col">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider flex items-center justify-between">
        <span>Sim Positions <span className="text-yellow-400 ml-1">· SIM</span></span>
        <span className="text-[10px] text-gray-600">{positions.length}</span>
      </div>

      {positions.length === 0 ? (
        <div className="text-gray-600 text-center text-xs py-4">No open sim positions</div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-[10px] font-mono">
            <thead className="text-gray-500 sticky top-0 bg-[#111118]">
              <tr className="text-left">
                <th className="px-1 py-1">Symbol</th>
                <th className="px-1 py-1">Side</th>
                <th className="px-1 py-1 text-right">Entry</th>
                <th className="px-1 py-1 text-right">Mark</th>
                <th className="px-1 py-1 text-right">Size</th>
                <th className="px-1 py-1 text-right">uPnL</th>
                <th className="px-1 py-1"></th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const upnl = p.unrealizedPnl ?? 0;
                const upnlColor = upnl >= 0 ? 'text-green-400' : 'text-red-400';
                return (
                  <tr key={p.id} className="border-t border-[#1a1a2a] hover:bg-[#15151f]">
                    <td className="px-1 py-1 text-gray-300">{p.symbol.split('/')[0]}</td>
                    <td className={`px-1 py-1 ${p.side === 'long' ? 'text-green-400' : 'text-red-400'}`}>
                      {p.side === 'long' ? 'L' : 'S'}
                    </td>
                    <td className="px-1 py-1 text-right text-gray-400">{p.entryPrice.toFixed(2)}</td>
                    <td className="px-1 py-1 text-right text-gray-300">
                      {p.markPrice ? p.markPrice.toFixed(2) : '—'}
                    </td>
                    <td className="px-1 py-1 text-right text-gray-400">${p.size.toFixed(0)}</td>
                    <td className={`px-1 py-1 text-right ${upnlColor}`}>
                      {upnl >= 0 ? '+' : ''}{upnl.toFixed(2)}
                    </td>
                    <td className="px-1 py-1 text-right">
                      <button
                        onClick={() => closePosition(p.id)}
                        disabled={closing === p.id}
                        className="px-1.5 py-0.5 rounded text-[9px] text-red-400 hover:bg-red-900/30 disabled:opacity-50"
                      >
                        {closing === p.id ? '…' : 'X'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
