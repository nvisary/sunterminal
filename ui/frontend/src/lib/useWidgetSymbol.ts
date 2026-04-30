import { usePanelsStore } from '../stores/panels.store';
import { useSyncStore, SYNC_GROUPS } from '../stores/sync.store';
import type { WidgetConfig } from '../stores/layout.store';

/**
 * Widget types that follow symbol changes (panel symbol or sync group symbol).
 * Account-wide widgets (drawdown, exposure, alerts, hedge) are NOT here.
 */
const SYMBOL_WIDGETS = new Set([
  'orderbook',
  'chart',
  'candleChart',
  'trades',
  'tradeForm',
  'heatmap',
  'volumeProfile',
  'funding',
  'volatility',
  'levels',
]);

export function isSymbolWidget(type: string): boolean {
  return SYMBOL_WIDGETS.has(type);
}

export interface WidgetSymbolControl {
  exchange: string;
  symbol: string;
  groupId: string | null;
  groupColor: string | null;
  isSymbolWidget: boolean;
  /** Change both exchange and symbol atomically. Routes to group or panel based on assignment. */
  setSymbol: (next: { exchange: string; symbol: string }) => void;
}

/**
 * Single source of truth for resolving + changing a widget's symbol.
 *
 * - Resolves: if widget is in a sync group → uses group symbol; otherwise → panel symbol.
 * - Mutates: same logic — group-assigned widgets push to group; otherwise to the panel.
 *
 * Returns a stable shape; safe to use in any widget container.
 */
export function useWidgetSymbolControl(widget: WidgetConfig): WidgetSymbolControl {
  const panels = usePanelsStore((s) => s.panels);
  const activePanel = usePanelsStore((s) => s.activePanel);
  const updatePanel = usePanelsStore((s) => s.updatePanel);
  const setGroupSymbol = useSyncStore((s) => s.setGroupSymbol);
  const groupId = useSyncStore((s) => s.assignments[widget.id] ?? null);

  // Subscribe to the *primitive* fields of the group, not the object —
  // returning an object literal would change reference each render and
  // either over-render or (with the cached selector) miss real updates.
  const groupExchange = useSyncStore((s) =>
    groupId ? (s.groupState[groupId]?.exchange ?? null) : null,
  );
  const groupSymbol = useSyncStore((s) =>
    groupId ? (s.groupState[groupId]?.symbol ?? null) : null,
  );

  const panelIdx = (widget.props?.panelIndex as number | undefined) ?? activePanel;
  const panel = panels[panelIdx] ?? panels[activePanel] ?? panels[0]!;

  const widgetIsSymbolBound = SYMBOL_WIDGETS.has(widget.type);

  const resolved =
    widgetIsSymbolBound && groupId && groupExchange && groupSymbol
      ? { exchange: groupExchange, symbol: groupSymbol }
      : { exchange: panel.exchange, symbol: panel.symbol };

  const groupColor = groupId
    ? (SYNC_GROUPS.find((g) => g.id === groupId)?.color ?? null)
    : null;

  const setSymbol = (next: { exchange: string; symbol: string }) => {
    if (groupId) {
      setGroupSymbol(groupId, next.exchange, next.symbol);
    } else {
      updatePanel(panelIdx, { exchange: next.exchange, symbol: next.symbol });
    }
  };

  return {
    exchange: resolved.exchange,
    symbol: resolved.symbol,
    groupId,
    groupColor,
    isSymbolWidget: widgetIsSymbolBound,
    setSymbol,
  };
}
