import { useState, useCallback, useEffect } from 'react';
import { API_BASE, wsClient } from '../lib/ws-client';
import { useSettingsStore } from '../stores/settings.store';
import { useSimStore, type SimExposure } from '../stores/sim.store';

const API = `${API_BASE}/api`;

export function TradeFormWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const mode = useSettingsStore((s) => s.mode);
  const isSim = mode === 'sim';
  const account = useSimStore((s) => s.account);
  const setAccount = useSimStore((s) => s.setAccount);
  const setExposure = useSimStore((s) => s.setExposure);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Hydrate sim account on mount + subscribe to live updates so balance ticks
  useEffect(() => {
    if (!isSim) return;
    fetch(`${API}/sim/account`).then((r) => r.json()).then((data) => {
      if (data) setAccount(data);
    }).catch(() => undefined);

    const unsub = wsClient.subscribe<SimExposure & { cashUSDT?: number }>('sim:exposure', (data) => {
      setExposure(data);
      // Account doesn't get pushed live as a stream, but exposure carries equity
      // so we patch the account in-place to keep the displayed cash/equity fresh.
      const cur = useSimStore.getState().account;
      if (cur) {
        setAccount({ ...cur, equity: data.equity, unrealizedPnl: data.unrealizedPnl, openPositions: data.openPositions });
      }
    });
    return unsub;
  }, [isSim, setAccount, setExposure]);

  const handleTrade = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const url = isSim ? `${API}/sim/trade/open` : `${API}/trade/open`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange,
          symbol,
          side,
          stopLoss: stopLoss ? Number(stopLoss) : undefined,
          takeProfit: takeProfit ? Number(takeProfit) : undefined,
        }),
      });
      const data = await res.json();
      setResult(data.ok ? (isSim ? 'Sim order sent' : 'Order sent') : `Error: ${data.error}`);
    } catch {
      setResult('Failed to send order');
    } finally {
      setLoading(false);
    }
  }, [exchange, symbol, side, stopLoss, takeProfit, isSim]);

  const handleEmergency = useCallback(async () => {
    if (isSim) {
      if (!confirm('Close ALL sim positions?')) return;
      await fetch(`${API}/sim/trade/close-all`, { method: 'POST' });
      return;
    }
    if (!confirm('EMERGENCY EXIT: Close ALL positions on ALL exchanges?')) return;
    await fetch(`${API}/hedge/emergency`, { method: 'POST' });
  }, [isSim]);

  const borderClass = isSim ? 'border-yellow-700/60' : 'border-[#1e1e2e]';
  const titleSuffix = isSim ? <span className="text-yellow-400 ml-1">· SIM</span> : null;

  return (
    <div className={`bg-[#111118] rounded border ${borderClass} p-3`}>
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider flex items-center justify-between">
        <span>Trade — {exchange} {symbol}{titleSuffix}</span>
      </div>

      {isSim && account && (
        <div className="bg-yellow-950/30 border border-yellow-900/60 rounded px-2 py-1 mb-2 text-[10px] flex justify-between text-yellow-200">
          <span>Equity</span>
          <span className="font-mono">${(account.equity ?? account.cashUSDT).toFixed(2)}</span>
          <span>uPnL</span>
          <span className={`font-mono ${(account.unrealizedPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {(account.unrealizedPnl ?? 0) >= 0 ? '+' : ''}{(account.unrealizedPnl ?? 0).toFixed(2)}
          </span>
        </div>
      )}

      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setSide('buy')}
          className={`flex-1 py-2 rounded text-sm font-bold transition-colors ${
            side === 'buy' ? 'bg-green-600 text-white' : 'bg-[#1a1a2a] text-gray-400 hover:bg-green-900/30'
          }`}
        >
          BUY
        </button>
        <button
          onClick={() => setSide('sell')}
          className={`flex-1 py-2 rounded text-sm font-bold transition-colors ${
            side === 'sell' ? 'bg-red-600 text-white' : 'bg-[#1a1a2a] text-gray-400 hover:bg-red-900/30'
          }`}
        >
          SELL
        </button>
      </div>

      <div className="space-y-2 mb-3">
        <input
          type="number"
          placeholder="Stop Loss"
          value={stopLoss}
          onChange={(e) => setStopLoss(e.target.value)}
          className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-[#4a4a6a] outline-none"
        />
        <input
          type="number"
          placeholder="Take Profit"
          value={takeProfit}
          onChange={(e) => setTakeProfit(e.target.value)}
          className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-[#4a4a6a] outline-none"
        />
      </div>

      <button
        onClick={handleTrade}
        disabled={loading}
        className={`w-full py-2 rounded text-sm font-bold mb-2 transition-colors ${
          side === 'buy'
            ? 'bg-green-700 hover:bg-green-600 text-white'
            : 'bg-red-700 hover:bg-red-600 text-white'
        } disabled:opacity-50`}
      >
        {loading ? '...' : `${isSim ? 'SIM ' : ''}${side.toUpperCase()} ${symbol}`}
      </button>

      {result && (
        <div className="text-xs text-center text-gray-400 mb-2">{result}</div>
      )}

      <button
        onClick={handleEmergency}
        className={`w-full py-2 rounded text-sm font-bold transition-colors border ${
          isSim
            ? 'bg-yellow-900/40 hover:bg-yellow-800/50 text-yellow-200 border-yellow-700'
            : 'bg-red-900 hover:bg-red-700 text-red-100 border-red-700'
        }`}
      >
        {isSim ? 'CLOSE ALL SIM' : 'EMERGENCY EXIT'}
      </button>
    </div>
  );
}
