import { OrderBookWidget } from '../widgets/OrderBookWidget';
import { PriceChartWidget } from '../widgets/PriceChartWidget';
import { TradesWidget } from '../widgets/TradesWidget';
import { TradeFormWidget } from '../widgets/TradeFormWidget';
import { DrawdownWidget } from '../widgets/DrawdownWidget';
import { ExposureWidget } from '../widgets/ExposureWidget';
import { AlertsWidget } from '../widgets/AlertsWidget';
import { HedgeWidget } from '../widgets/HedgeWidget';
import { usePanelsStore } from '../stores/panels.store';

export function TradingPage({ onOpenLogs }: { onOpenLogs?: () => void }) {
  const { panels, activePanel, setActivePanel, updatePanel, addPanel, removePanel } = usePanelsStore();
  const active = panels[activePanel] ?? panels[0]!;

  return (
    <div className="flex-1 p-2 grid grid-cols-12 grid-rows-[auto_1fr_auto] gap-2 min-h-0">
      {/* Top bar */}
      <div className="col-span-12 flex items-center gap-2 px-2 py-1 bg-[#0d0d14] rounded border border-[#1e1e2e]">
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
                >x</span>
              )}
            </button>
          ))}
          <button
            onClick={() => addPanel('SOL/USDT:USDT', active.exchange)}
            className="px-2 py-0.5 rounded text-xs text-gray-600 hover:text-green-400 border border-dashed border-gray-700 hover:border-green-700"
          >+</button>
        </div>

        <div className="flex-1" />
        {onOpenLogs && (
          <button onClick={onOpenLogs}
            className="px-2 py-0.5 rounded text-xs text-gray-500 hover:text-gray-200 border border-[#2a2a3a] hover:border-[#4a4a6a] shrink-0"
          >Logs</button>
        )}
        <span className="text-xs text-gray-600 shrink-0">Ctrl+L: logs | Ctrl+Shift+K: emergency</span>
      </div>

      {/* Order books + charts */}
      <div className="col-span-8 row-span-1 overflow-hidden flex flex-col gap-2">
        <div className="flex-1 grid gap-2 min-h-0" style={{
          gridTemplateColumns: `repeat(${Math.min(panels.length, 4)}, 1fr)`,
        }}>
          {panels.map((p, i) => (
            <div key={i} className="overflow-hidden cursor-pointer" onClick={() => setActivePanel(i)}>
              <OrderBookWidget
                exchange={p.exchange}
                symbol={p.symbol}
                isActive={i === activePanel}
                onChangeSymbol={(sym) => updatePanel(i, { symbol: sym })}
                onChangeExchange={(ex) => updatePanel(i, { exchange: ex })}
              />
            </div>
          ))}
        </div>
        {/* Price charts under orderbooks */}
        <div className="grid gap-2 shrink-0" style={{
          gridTemplateColumns: `repeat(${Math.min(panels.length, 4)}, 1fr)`,
        }}>
          {panels.map((p, i) => (
            <PriceChartWidget key={`chart-${i}`} exchange={p.exchange} symbol={p.symbol} />
          ))}
        </div>
      </div>

      {/* Right sidebar */}
      <div className="col-span-4 row-span-1 space-y-2 overflow-y-auto">
        <TradesWidget exchange={active.exchange} symbol={active.symbol} />
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
