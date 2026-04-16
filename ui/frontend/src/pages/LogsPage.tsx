import { useEffect, useState } from 'react';
import { wsClient } from '../lib/ws-client';

interface LogEntry {
  source: string;
  data: Record<string, unknown>;
  timestamp: number;
}

const LOG_CHANNELS = [
  { channel: 'risk:drawdown', label: 'Drawdown', color: 'text-red-400' },
  { channel: 'risk:alerts', label: 'Alert', color: 'text-amber-400' },
  { channel: 'risk:volatility', label: 'Volatility', color: 'text-blue-400' },
  { channel: 'risk:exposure', label: 'Exposure', color: 'text-purple-400' },
  { channel: 'risk:levels', label: 'Levels', color: 'text-cyan-400' },
  { channel: 'hedge:state', label: 'Hedge', color: 'text-green-400' },
  { channel: 'trade:orders', label: 'Orders', color: 'text-orange-400' },
];

export function LogsPage({ onBack }: { onBack: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const maxLogs = 500;

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    for (const { channel, label } of LOG_CHANNELS) {
      const unsub = wsClient.subscribe(channel, (data) => {
        if (paused) return;
        const entry: LogEntry = {
          source: label,
          data,
          timestamp: data.timestamp as number || Date.now(),
        };
        setLogs((prev) => [...prev.slice(-(maxLogs - 1)), entry]);
      });
      unsubs.push(unsub);
    }

    return () => unsubs.forEach((u) => u());
  }, [paused]);

  const filtered = filter
    ? logs.filter((l) => l.source.toLowerCase().includes(filter.toLowerCase()) ||
        JSON.stringify(l.data).toLowerCase().includes(filter.toLowerCase()))
    : logs;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f] p-3 gap-3">
      {/* Header */}
      <div className="flex items-center gap-3 px-2">
        <button
          onClick={onBack}
          className="px-3 py-1 rounded text-xs bg-[#1e1e2e] text-gray-300 hover:text-white border border-[#2a2a3a] hover:border-[#4a4a6a]"
        >
          Back to Trading
        </button>
        <span className="text-sm font-bold text-white">System Logs</span>
        <span className="text-xs text-gray-500">({filtered.length} entries)</span>

        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter logs..."
          className="w-48 bg-[#0a0a14] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-[#4a4a6a]"
        />

        <button
          onClick={() => setPaused(!paused)}
          className={`px-3 py-1 rounded text-xs border ${
            paused
              ? 'bg-green-900/30 text-green-400 border-green-800'
              : 'bg-amber-900/30 text-amber-400 border-amber-800'
          }`}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>

        <button
          onClick={() => setLogs([])}
          className="px-3 py-1 rounded text-xs bg-[#1e1e2e] text-gray-400 hover:text-white border border-[#2a2a3a]"
        >
          Clear
        </button>

        <div className="flex-1" />

        {/* Legend */}
        <div className="flex gap-2">
          {LOG_CHANNELS.map(({ label, color }) => (
            <span key={label} className={`text-[10px] ${color}`}>{label}</span>
          ))}
        </div>
      </div>

      {/* Log table */}
      <div className="flex-1 overflow-y-auto bg-[#111118] rounded border border-[#1e1e2e]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#111118] border-b border-[#1e1e2e]">
            <tr className="text-gray-500">
              <th className="text-left px-3 py-2 w-20">Time</th>
              <th className="text-left px-3 py-2 w-24">Source</th>
              <th className="text-left px-3 py-2 w-32">Type</th>
              <th className="text-left px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center py-8 text-gray-600">
                  No logs yet. Events from Risk Engine, Hedge Engine, and Trade Execution will appear here.
                </td>
              </tr>
            )}
            {[...filtered].reverse().map((log, i) => {
              const time = new Date(log.timestamp).toLocaleTimeString('en-GB', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              });
              const channelCfg = LOG_CHANNELS.find((c) => c.label === log.source);
              const color = channelCfg?.color ?? 'text-gray-400';
              const type = (log.data.type as string) ?? (log.data.status as string) ?? '-';
              const level = log.data.level as string;

              const levelBg = level === 'critical' ? 'bg-red-900/20'
                : level === 'danger' ? 'bg-red-900/10'
                : level === 'warning' ? 'bg-amber-900/10'
                : '';

              // Build detail string
              const details: string[] = [];
              if (log.data.exchange) details.push(`ex:${log.data.exchange}`);
              if (log.data.symbol) details.push(`${log.data.symbol}`);
              if (log.data.action) details.push(`action:${log.data.action}`);
              if (log.data.regime) details.push(`regime:${log.data.regime}`);
              if (log.data.drawdownPct != null || log.data.payload) {
                const payload = (log.data.payload ?? log.data) as Record<string, unknown>;
                if (payload.drawdownPct != null) details.push(`dd:${Number(payload.drawdownPct).toFixed(1)}%`);
                if (payload.equity != null) details.push(`eq:$${Number(payload.equity).toFixed(0)}`);
                if (payload.exposureRatio != null) details.push(`ratio:${Number(payload.exposureRatio).toFixed(1)}x`);
                if (payload.atrPercent != null) details.push(`atr:${Number(payload.atrPercent).toFixed(3)}%`);
              }

              return (
                <tr key={i} className={`border-b border-[#1a1a2a] hover:bg-[#1a1a2a] ${levelBg}`}>
                  <td className="px-3 py-1.5 text-gray-600 font-mono">{time}</td>
                  <td className={`px-3 py-1.5 font-semibold ${color}`}>{log.source}</td>
                  <td className="px-3 py-1.5 text-gray-300">{type}</td>
                  <td className="px-3 py-1.5 text-gray-500 truncate max-w-md">{details.join(' | ') || JSON.stringify(log.data).slice(0, 100)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
