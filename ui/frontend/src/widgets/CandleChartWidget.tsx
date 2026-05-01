import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, ColorType, CandlestickSeries } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, CandlestickData, Time } from 'lightweight-charts';
import { wsClient, API_BASE } from '../lib/ws-client';

interface OHLCVCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandleChartWidgetProps {
  exchange: string;
  symbol: string;
}
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

export function CandleChartWidget({ exchange, symbol }: CandleChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [timeframe, setTimeframe] = useState('1h');
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

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar — timeframe only; symbol is controlled by WidgetWrapper */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[#1a1a2a] bg-[#0a0a10] shrink-0">
        {TIMEFRAMES.map((tf) => (
          <button key={tf} onClick={() => setTimeframe(tf)}
            className={`px-1.5 py-0.5 text-[10px] rounded ${timeframe === tf ? 'bg-[#2a2a4a] text-white' : 'text-gray-600 hover:text-gray-300'}`}
          >{tf}</button>
        ))}
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
