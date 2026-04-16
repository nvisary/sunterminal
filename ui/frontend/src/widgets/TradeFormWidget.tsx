import { useState, useCallback } from 'react';
import { API_BASE } from '../lib/ws-client';

const API = `${API_BASE}/api`;

export function TradeFormWidget({ exchange, symbol }: { exchange: string; symbol: string }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [stopLoss, setStopLoss] = useState('');
  const [takeProfit, setTakeProfit] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleTrade = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/trade/open`, {
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
      setResult(data.ok ? 'Order sent' : `Error: ${data.error}`);
    } catch (err) {
      setResult('Failed to send order');
    } finally {
      setLoading(false);
    }
  }, [exchange, symbol, side, stopLoss, takeProfit]);

  const handleEmergency = useCallback(async () => {
    if (!confirm('EMERGENCY EXIT: Close ALL positions on ALL exchanges?')) return;
    await fetch(`${API}/hedge/emergency`, { method: 'POST' });
  }, []);

  return (
    <div className="bg-[#111118] rounded border border-[#1e1e2e] p-3">
      <div className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">
        Trade — {exchange} {symbol}
      </div>

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
        {loading ? '...' : `${side.toUpperCase()} ${symbol}`}
      </button>

      {result && (
        <div className="text-xs text-center text-gray-400 mb-2">{result}</div>
      )}

      <button
        onClick={handleEmergency}
        className="w-full py-2 rounded text-sm font-bold bg-red-900 hover:bg-red-700 text-red-100 border border-red-700 transition-colors"
      >
        EMERGENCY EXIT
      </button>
    </div>
  );
}
