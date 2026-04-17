import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts';
import { wsClient, API_BASE } from '../lib/ws-client';
import { EXCHANGES } from '../stores/sync.store';

interface OHLCVCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleChartWidgetProps {
  defaultExchange?: string;
  defaultSymbol?: string;
}
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function CandleChartWidget({ defaultExchange = 'bybit', defaultSymbol = 'BTC/USDT:USDT' }: CandleChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [exchange, setExchange] = useState(defaultExchange);
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [timeframe, setTimeframe] = useState('1h');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);

  // Create chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0c0c14' },
        textColor: '#666',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1a1a2a' },
        horzLines: { color: '#1a1a2a' },
      },
      crosshair: {
        vertLine: { color: '#444', labelBackgroundColor: '#2a2a4a' },
        horzLine: { color: '#444', labelBackgroundColor: '#2a2a4a' },
      },
      rightPriceScale: {
        borderColor: '#1a1a2a',
      },
      timeScale: {
        borderColor: '#1a1a2a',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e80',
      wickDownColor: '#ef444480',
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.resize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, []);

  // Fetch OHLCV data
  const fetchCandles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/candles/${exchange}/${encodeURIComponent(symbol)}?tf=${timeframe}&limit=300`);
      if (!res.ok) return;
      const data = await res.json() as OHLCVCandle[];
      if (!Array.isArray(data) || !candleSeriesRef.current) return;

      const candles: CandlestickData<Time>[] = data.map((c) => ({
        time: (c.time / 1000) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));

      candleSeriesRef.current.setData(candles);
      chartRef.current?.timeScale().fitContent();
    } catch {
      // ignore fetch errors
    } finally {
      setLoading(false);
    }
  }, [exchange, symbol, timeframe]);

  useEffect(() => {
    fetchCandles();
  }, [fetchCandles]);

  // Real-time updates via trade stream
  useEffect(() => {
    const channel = `trades:${exchange}:${symbol}`;
    let lastCandle: CandlestickData<Time> | null = null;

    const unsub = wsClient.subscribe<{ price: number; timestamp: number }>(channel, (data) => {
      if (!data.price || !candleSeriesRef.current) return;

      const tfMs = parseTfMs(timeframe);
      const candleTime = (Math.floor(data.timestamp / tfMs) * tfMs / 1000) as Time;
      const price = data.price;

      if (lastCandle && lastCandle.time === candleTime) {
        lastCandle.high = Math.max(lastCandle.high, price);
        lastCandle.low = Math.min(lastCandle.low, price);
        lastCandle.close = price;
      } else {
        lastCandle = { time: candleTime, open: price, high: price, low: price, close: price };
      }

      candleSeriesRef.current.update(lastCandle);
    });

    return unsub;
  }, [exchange, symbol, timeframe]);

  const doSearch = async (q: string) => {
    if (!q) { setResults([]); return; }
    try {
      const res = await fetch(`${API_BASE}/api/markets/${exchange}/search?q=${encodeURIComponent(q)}`);
      setResults(await res.json() as string[]);
    } catch { setResults([]); }
  };

  const selectSymbol = (sym: string) => {
    setSymbol(sym);
    setSearch('');
    setResults([]);
    setSearching(false);
  };

  const baseName = symbol.split('/')[0] ?? symbol;

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[#1a1a2a] bg-[#0a0a10] shrink-0">
        {searching ? (
          <div className="flex-1 relative">
            <div className="flex gap-1">
              <select value={exchange} onChange={(e) => setExchange(e.target.value)}
                className="bg-[#0a0a14] border border-[#2a2a3a] rounded px-1 py-0.5 text-[10px] text-gray-400 outline-none w-16"
              >
                {EXCHANGES.map((ex) => <option key={ex} value={ex}>{ex}</option>)}
              </select>
              <input autoFocus type="text" value={search}
                onChange={(e) => { const v = e.target.value.toUpperCase(); setSearch(v); doSearch(v); }}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') { setSearching(false); setSearch(''); setResults([]); }
                  if (e.key === 'Enter' && search) {
                    let r = results;
                    if (!r.length) { const res = await fetch(`${API_BASE}/api/markets/${exchange}/search?q=${encodeURIComponent(search)}`); r = await res.json() as string[]; }
                    if (r.length) selectSymbol(r[0]!);
                  }
                }}
                onBlur={() => setTimeout(() => { setSearching(false); setResults([]); }, 200)}
                placeholder="Search..."
                className="flex-1 bg-[#0a0a14] border border-[#2a2a3a] rounded px-1.5 py-0.5 text-xs text-gray-200 placeholder-gray-600 outline-none focus:border-[#4a4a6a]"
              />
            </div>
            {results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-[#12121e] border border-[#2a2a3a] rounded shadow-lg z-50">
                {results.map((sym) => (
                  <button key={sym} onMouseDown={(e) => { e.preventDefault(); selectSymbol(sym); }}
                    className="w-full text-left px-2 py-1 text-xs text-gray-300 hover:bg-[#1e1e3e] hover:text-white"
                  >{sym}</button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <button onClick={() => setSearching(true)}
              className="text-xs font-bold text-gray-200 hover:text-white"
              title="Click to change symbol"
            >
              {baseName}
              <span className="text-[10px] text-gray-600 ml-1">{exchange}</span>
            </button>
            <span className="text-gray-700">|</span>
            {/* Timeframe buttons */}
            {TIMEFRAMES.map((tf) => (
              <button key={tf} onClick={() => setTimeframe(tf)}
                className={`px-1.5 py-0.5 text-[10px] rounded ${timeframe === tf ? 'bg-[#2a2a4a] text-white' : 'text-gray-600 hover:text-gray-300'}`}
              >{tf}</button>
            ))}
          </>
        )}
        {loading && <span className="text-[10px] text-gray-600 ml-auto">Loading...</span>}
      </div>

      {/* Chart */}
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}

function parseTfMs(tf: string): number {
  const n = parseInt(tf);
  if (tf.endsWith('m')) return n * 60 * 1000;
  if (tf.endsWith('h')) return n * 60 * 60 * 1000;
  if (tf.endsWith('d')) return n * 24 * 60 * 60 * 1000;
  return 60 * 60 * 1000;
}
