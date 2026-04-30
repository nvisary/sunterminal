import { useState, useCallback, useEffect } from 'react';
import { API_BASE, wsClient } from '../lib/ws-client';
import { useSettingsStore } from '../stores/settings.store';
import { useSimStore, type SimExposure } from '../stores/sim.store';
import { useMarketInfo } from '../stores/marketInfo.store';

const API = `${API_BASE}/api`;

export function TradeFormWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const mode = useSettingsStore((s) => s.mode);
  const isSim = mode === 'sim';
  const account = useSimStore((s) => s.account);
  const setAccount = useSimStore((s) => s.setAccount);
  const setExposure = useSimStore((s) => s.setExposure);
  const info = useMarketInfo(exchange, symbol);

  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const tickSize = info?.tickSize ?? undefined;
  const priceStep = tickSize && tickSize > 0 ? String(tickSize) : 'any';
  const base = symbol.split('/')[0] ?? symbol;

  // Hydrate sim account on mount + subscribe to live updates so balance ticks
  useEffect(() => {
    if (!isSim) return;
    fetch(`${API}/sim/account`).then((r) => r.json()).then((data) => {
      if (data) setAccount(data);
    }).catch(() => undefined);

    const unsub = wsClient.subscribe<SimExposure & { cashUSDT?: number }>('sim:exposure', (data) => {
      setExposure(data);
      // sim:exposure carries equity/uPnL — patch the account in place so the
      // header badge ticks without waiting for a separate account stream.
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

  return (
    <div className="p-3">
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
        <div>
          <input
            type="number"
            step={priceStep}
            placeholder={`Stop Loss${tickSize ? ` (tick ${tickSize})` : ''}`}
            value={stopLoss}
            onChange={(e) => setStopLoss(e.target.value)}
            className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-[#4a4a6a] outline-none"
          />
        </div>
        <div>
          <input
            type="number"
            step={priceStep}
            placeholder={`Take Profit${tickSize ? ` (tick ${tickSize})` : ''}`}
            value={takeProfit}
            onChange={(e) => setTakeProfit(e.target.value)}
            className="w-full bg-[#0a0a14] border border-[#2a2a3a] rounded px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-[#4a4a6a] outline-none"
          />
        </div>
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
        {loading ? '...' : `${isSim ? 'SIM ' : ''}${side.toUpperCase()} ${base}`}
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
