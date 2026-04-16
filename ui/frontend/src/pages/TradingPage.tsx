import { useState, useCallback } from 'react';
import { OrderBookWidget } from '../widgets/OrderBookWidget';
import { TradeFormWidget } from '../widgets/TradeFormWidget';
import { DrawdownWidget } from '../widgets/DrawdownWidget';
import { ExposureWidget } from '../widgets/ExposureWidget';
import { AlertsWidget } from '../widgets/AlertsWidget';
import { HedgeWidget } from '../widgets/HedgeWidget';

const EXCHANGES = ['bybit', 'binance', 'okx'];
const POPULAR_SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'XRP/USDT:USDT',
  'DOGE/USDT:USDT',
  'WIF/USDT:USDT',
  'PEPE/USDT:USDT',
  'SUI/USDT:USDT',
  'ARB/USDT:USDT',
  'OP/USDT:USDT',
  'AVAX/USDT:USDT',
  'LINK/USDT:USDT',
  'ADA/USDT:USDT',
  'TON/USDT:USDT',
  'TRX/USDT:USDT',
];

interface PanelConfig {
  exchange: string;
  symbol: string;
}

function SymbolSelector({
  exchange,
  symbol,
  onChangeExchange,
  onChangeSymbol,
  onCustomSymbol,
}: {
  exchange: string;
  symbol: string;
  onChangeExchange: (e: string) => void;
  onChangeSymbol: (s: string) => void;
  onCustomSymbol: (s: string) => void;
}) {
  const [custom, setCustom] = useState('');

  return (
    <div className="flex items-center gap-1 text-xs">
      <select
        value={exchange}
        onChange={(e) => onChangeExchange(e.target.value)}
        className="bg-[#0a0a14] border border-[#2a2a3a] rounded px-1.5 py-0.5 text-gray-300 outline-none"
      >
        {EXCHANGES.map((ex) => (
          <option key={ex} value={ex}>{ex}</option>
        ))}
      </select>
      <select
        value={symbol}
        onChange={(e) => onChangeSymbol(e.target.value)}
        className="bg-[#0a0a14] border border-[#2a2a3a] rounded px-1.5 py-0.5 text-gray-300 outline-none"
      >
        {POPULAR_SYMBOLS.map((s) => (
          <option key={s} value={s}>{s.split('/')[0]}</option>
        ))}
      </select>
      <input
        type="text"
        placeholder="CUSTOM/USDT:USDT"
        value={custom}
        onChange={(e) => setCustom(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && custom) {
            const sym = custom.includes('/') ? custom : `${custom}/USDT:USDT`;
            onCustomSymbol(sym);
            setCustom('');
          }
        }}
        className="w-32 bg-[#0a0a14] border border-[#2a2a3a] rounded px-1.5 py-0.5 text-gray-300 placeholder-gray-700 outline-none focus:border-[#4a4a6a]"
      />
    </div>
  );
}

export function TradingPage() {
  const [panels, setPanels] = useState<PanelConfig[]>([
    { exchange: 'bybit', symbol: 'BTC/USDT:USDT' },
    { exchange: 'bybit', symbol: 'ETH/USDT:USDT' },
  ]);

  const [activePanel, setActivePanel] = useState(0);

  const updatePanel = useCallback((idx: number, update: Partial<PanelConfig>) => {
    setPanels((prev) => prev.map((p, i) => (i === idx ? { ...p, ...update } : p)));
  }, []);

  const addPanel = useCallback(() => {
    setPanels((prev) => [...prev, { exchange: 'bybit', symbol: 'SOL/USDT:USDT' }]);
  }, []);

  const removePanel = useCallback((idx: number) => {
    setPanels((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, i) => i !== idx);
      setActivePanel((a) => Math.min(a, next.length - 1));
      return next;
    });
  }, []);

  const active = panels[activePanel] ?? panels[0]!;

  return (
    <div className="flex-1 p-2 grid grid-cols-12 grid-rows-[auto_1fr_auto] gap-2 min-h-0">
      {/* Top bar */}
      <div className="col-span-12 flex items-center gap-2 px-2 py-1 bg-[#0d0d14] rounded border border-[#1e1e2e] overflow-x-auto">
        <span className="text-sm font-bold text-white shrink-0">SunTerminal</span>
        <span className="text-xs text-gray-600 shrink-0">|</span>

        {/* Panel tabs */}
        <div className="flex gap-1 shrink-0">
          {panels.map((p, i) => (
            <button
              key={i}
              onClick={() => setActivePanel(i)}
              className={`px-2 py-0.5 rounded text-xs transition-colors ${
                i === activePanel
                  ? 'bg-[#1e1e3e] text-white border border-[#3a3a5a]'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}
            >
              {p.symbol.split('/')[0]}
              {panels.length > 1 && (
                <span
                  onClick={(e) => { e.stopPropagation(); removePanel(i); }}
                  className="ml-1 text-gray-600 hover:text-red-400 cursor-pointer"
                >
                  x
                </span>
              )}
            </button>
          ))}
          <button
            onClick={addPanel}
            className="px-2 py-0.5 rounded text-xs text-gray-600 hover:text-green-400 border border-dashed border-gray-700 hover:border-green-700 transition-colors"
          >
            +
          </button>
        </div>

        <div className="flex-1" />
        <span className="text-xs text-gray-600 shrink-0">Ctrl+Shift+K: emergency</span>
      </div>

      {/* Order books */}
      <div className="col-span-8 row-span-1 overflow-hidden flex flex-col gap-2">
        {/* Symbol selector for active panel */}
        <div className="flex items-center gap-2 px-1">
          <SymbolSelector
            exchange={active.exchange}
            symbol={active.symbol}
            onChangeExchange={(e) => updatePanel(activePanel, { exchange: e })}
            onChangeSymbol={(s) => updatePanel(activePanel, { symbol: s })}
            onCustomSymbol={(s) => updatePanel(activePanel, { symbol: s })}
          />
        </div>

        <div className="flex-1 grid gap-2 overflow-hidden" style={{
          gridTemplateColumns: `repeat(${Math.min(panels.length, 4)}, 1fr)`,
        }}>
          {panels.map((p, i) => (
            <div
              key={`${p.exchange}:${p.symbol}:${i}`}
              className={`overflow-hidden rounded ${
                i === activePanel ? 'ring-1 ring-[#3a3a5a]' : ''
              }`}
              onClick={() => setActivePanel(i)}
            >
              <OrderBookWidget exchange={p.exchange} symbol={p.symbol} />
            </div>
          ))}
        </div>
      </div>

      {/* Right sidebar */}
      <div className="col-span-4 row-span-1 space-y-2 overflow-y-auto">
        <TradeFormWidget exchange={active.exchange} symbol={active.symbol} />
        <DrawdownWidget />
        <ExposureWidget />
      </div>

      {/* Bottom panels */}
      <div className="col-span-6">
        <AlertsWidget />
      </div>
      <div className="col-span-6">
        <HedgeWidget />
      </div>
    </div>
  );
}
