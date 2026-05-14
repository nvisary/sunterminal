# SunTerminal — План доработок

Документ для координации работ по UX/функциональным улучшениям UI. Каждая задача — самостоятельная единица, которую может взять отдельный coding agent. Указаны файлы, контекст, acceptance criteria и риски.

Соглашения:
- Работаем строго по CLAUDE.md (Node+tsx, ESM, ccxt, Redis Streams, React 19 + Vite + Zustand).
- В коммитах **не** добавлять `Co-Authored-By`.
- Не вводить `as any`; типы — строгие.
- Иконки — `lucide-react` (уже в стеке UI).

---

## Группа A — Layout / Widget infrastructure

### A1. Расширить drag-area виджетов
**Проблема:** drag-handle — узкая полоска заголовка (`py-0.5`), почти невозможно зацепить мышью.

**Файлы:**
- [ui/frontend/src/pages/TradingPage.tsx:133](ui/frontend/src/pages/TradingPage.tsx) — `WidgetWrapper`, класс `.drag-handle`.

**Решение:**
- Увеличить высоту заголовка: `py-1` → `py-1.5` (минимум 22–24px клик-зона).
- Добавить `select-none` к header, чтобы текст не выделялся при drag.
- `react-grid-layout` использует `draggableHandle: ".drag-handle"` (см. `<GridLayout>` в TradingPage). Убедиться, что внутренние интерактивные элементы (SymbolPicker, HelpPopover, X) останавливают `onMouseDown` (SymbolPicker уже останавливает — line 138; добавить тот же `stopPropagation` для HelpPopover и кнопки close, если не работает).
- Альтернатива при недостаточном пространстве в маленьких виджетах: добавить слева от sync-dot grip-иконку (`GripVertical` из lucide) шириной 14–16px как явный визуальный affordance.

**Acceptance:** во всех виджетах легко перетягиваются за header без случайных кликов на SymbolPicker.

---

### A2. Иконки виджетов в add-widget меню
**Файлы:**
- [ui/frontend/src/stores/layout.store.ts:21](ui/frontend/src/stores/layout.store.ts) — `WIDGET_REGISTRY`.
- [ui/frontend/src/pages/TradingPage.tsx:373](ui/frontend/src/pages/TradingPage.tsx) — рендер меню.

**Решение:**
- В `WIDGET_REGISTRY` добавить поле `icon: LucideIcon` (импорт типа из `lucide-react`).
- Подобрать иконки:
  - orderbook → `ListOrdered`
  - trades (Tape) → `Activity`
  - volumeProfile → `BarChart3`
  - heatmap → `Flame` (будет объединён со стаканом — см. C4)
  - funding → `Percent`
  - volatility → `Waves`
  - levels → `Crosshair` *(сам виджет удаляется — см. B5; пункт неактуален после B5)*
  - chart (Sparkline) → удаляется (B6).
  - candleChart → `CandlestickChart`
  - tradeForm → `SendHorizontal`
  - drawdown → `TrendingDown`
  - exposure → `Wallet`
  - alerts → `BellRing`
  - microstructure → `Network`
  - hedge → `Shield`
  - simPositions → `Briefcase`
  - simJournal → `BookOpen`
  - cvd (новый — B8) → `Sigma`
  - footprint (новый — C5) → `Grid3x3`
- В меню добавления виджета рендерить `<Icon size={14} />` слева от названия.

**Acceptance:** все элементы в меню — с иконкой; визуально консистентно.

---

### A3. Disabled-флаг в registry + блокировка добавления
**Проблема:** Trade Form, Drawdown, Exposure, Hedge Engine ещё не готовы — должны отображаться в меню как **disabled**.

**Файлы:** `layout.store.ts`, `TradingPage.tsx` (меню).

**Решение:**
- В `WIDGET_REGISTRY` добавить поле `disabled?: boolean`.
- Установить `disabled: true` для `tradeForm`, `drawdown`, `exposure`, `hedge`.
- В меню: рендерить как `opacity-40 cursor-not-allowed pointer-events-none`, добавить badge "Coming soon".
- В `addWidget(type)` — early return если registry-запись disabled (защита на случай прямого вызова).

**Acceptance:** disabled-пункты видны, не кликабельны; уже добавленные инстансы (из localStorage persisted layout) продолжают рендериться без падения — но новые не создаются.

---

## Группа B — Виджеты, доработки

### B1. Tape — показывать размеры сделок, а не цену
**Файл:** [ui/frontend/src/widgets/TradesWidget.tsx](ui/frontend/src/widgets/TradesWidget.tsx)

**Сейчас:** строки показывают цену + пузырёк (радиус ∝ √volume).

**Сделать:** основная цифра — **размер сделки** (контрактов/базовой валюты). Цена — мелким серым справа или вообще убрать (price видно в стакане / chart). Сохранить:
- side-цвет (green/red),
- bubble-радиус как визуальный модификатор,
- сортировку (newest сверху).

Добавить toggle в меню виджета: "Show price" (off по умолчанию).

**Acceptance:** в Tape доминирует размер сделки, цена — второстепенна или скрыта.

---

### B2. Tape — лимит истории и память
**Контекст:** уже есть `MAX_TRADES=80`. Проверить, что:
- Кольцевой буфер реально обрезает массив (`slice(-MAX_TRADES)` или эквивалент).
- При смене символа state сбрасывается (защита от утечки — см. также C1).
- Подписка чистится в cleanup `useEffect`.

**Acceptance:** в DevTools Memory — у Tape нет роста heap при долгой работе на одном символе.

---

### B3. Funding — расширить семантику
**Файл:** [ui/frontend/src/widgets/FundingWidget.tsx](ui/frontend/src/widgets/FundingWidget.tsx)

**Изменения:**
1. **Кто кому платит:** если `rate > 0` → "Longs pay shorts", если `< 0` → "Shorts pay longs". Показать строкой под значением.
2. **Tooltip/подсказки** (через HelpPopover или `title`):
   - **Predicted rate** — расчётная ставка на следующий funding-период, может ещё измениться до фиксации.
   - **Annualized** — текущая ставка, экстраполированная на год (`rate × periods_per_day × 365`, для Bybit/Binance perpetual обычно 3 раза в сутки × 365 = ×1095).
3. **Default размер:** в `WIDGET_REGISTRY.funding` `defaultW: 3 → 4`, `defaultH: 4 → 5`.

**Acceptance:** новый пользователь без доков понимает, что показывают цифры.

---

### B4. Volatility — работает только на крупных активах
**Файл:** [ui/frontend/src/widgets/VolatilityWidget.tsx](ui/frontend/src/widgets/VolatilityWidget.tsx) + `risk-engine/` (Volatility Scanner).

**Гипотеза:** scanner набирает окно по объёму/количеству сделок — на малоликвидных активах окно долго не заполняется, виджет показывает "—" или нули.

**Действия:**
1. **Диагностика:** в risk-engine логировать `volatility:warmup` событие — сколько баров / минут до первого результата по символу. Проверить пороги (`MIN_BARS`, `MIN_TRADES`) — найти в `risk-engine/src/scanners/volatility.ts` (или аналог).
2. **Фикc:** заменить trade-count-окно на **time-window** (e.g., ATR из 1m свечей за последние 14 баров) — это работает одинаково для любого актива. OHLCV брать из REST cache (тот же endpoint, что использует CandleChart).
3. **UI:** пока данных нет — показывать состояние "Warming up · X / 14 bars" вместо пустого значения.

**Acceptance:** Volatility виджет отображает ATR на любом символе из supported list через ≤2 мин после подписки.

---

### B5. Key Levels — убрать виджет, отобразить на CandleChart
**Файлы:**
- Удалить: [ui/frontend/src/widgets/LevelsWidget.tsx](ui/frontend/src/widgets/LevelsWidget.tsx); запись `levels` из `WIDGET_REGISTRY`.
- Изменить: [ui/frontend/src/widgets/CandleChartWidget.tsx](ui/frontend/src/widgets/CandleChartWidget.tsx).

**Решение:**
- В CandleChart добавить кнопку-toggle в header: "Levels" (иконка `Crosshair`). По клику — рисуем `createPriceLine()` (lightweight-charts API) для каждого уровня из `risk:signals:levels` snapshot.
- Источник данных: тот же snapshot/stream, что использовал `LevelsWidget` (`/api/snapshot/levels/...` или WS канал `levels:...`).
- Стиль линий: support — зелёная пунктирная, resistance — красная пунктирная, цена линий с подписью (уровень + сила).
- При смене символа — `removePriceLine()` для старых и пересоздание.
- **Миграция:** для существующих persisted-layouts с `type:"levels"` — фильтровать при гидратации (тихо удалять).

**Acceptance:** виджет Key Levels отсутствует, кнопка на CandleChart переключает горизонтали S/R на самом графике.

---

### B6. Sparkline — удалить, к графику добавить 1s real-time режим
**Файлы:**
- Удалить: `PriceChartWidget.tsx` + запись `chart` из `WIDGET_REGISTRY`.
- Изменить: `CandleChartWidget.tsx` — расширить `TIMEFRAMES` массивом, добавить `'1s'`.

**Серверная часть:**
- Эндпоинт `/api/candles/:ex/:sym?tf=1s` — проверить, поддерживает ли market-data 1s OHLCV. Если нет:
  - Bybit/Binance: REST `/v5/market/kline` с `interval=1` для секунд **не** поддерживают (минимум 1m).
  - **Решение:** генерировать 1s свечи на лету в api-gateway/market-data из `md:trades:*` стрима — последние N=300 секунд достаточно для real-time режима. Хранить в Redis snapshot ring `snapshot:candles:1s:{ex}:{sym}` (zset с TTL 10 мин).
- WS канал `candles:1s:{ex}:{sym}` — пушит обновление текущей секунды.

**Frontend:**
- В CandleChart при выборе tf=1s — fetch ring + subscribe на WS канал, обновлять последнюю свечу через `series.update()`.
- **Миграция:** persisted layouts с `type:"chart"` — фильтровать.

**Acceptance:** в CandleChart есть кнопка "1s", выбор показывает real-time секундный график без перезагрузки страницы.

---

### B7. CandleChart — на 1h не грузит историю
**Файл:** `CandleChartWidget.tsx` + api-gateway candles endpoint.

**Действия:**
1. Воспроизвести: открыть BTC/USDT, tf=1h — проверить запрос в Network. Что приходит? пусто, ошибка, кеш?
2. Возможные причины:
   - api-gateway проксирует к market-data, который дёргает ccxt — для 1h может не быть `since` параметра → ccxt возвращает последние 300 свечей, но кэш TTL слишком короткий.
   - В кэше Redis ключ конфликтует (один ключ на все tf).
3. **Фикс:** ключ кэша должен включать `tf`: `rest:candles:{ex}:{sym}:{tf}`. TTL — пропорционален tf (1m → 30s, 1h → 5min, 1d → 30min).

**Acceptance:** на всех supported timeframes график рендерится за <2 сек.

---

### B8. CVD — отдельный виджет
**Новый файл:** `ui/frontend/src/widgets/CvdWidget.tsx`.

**Что показывает:** Cumulative Volume Delta — кумулятивная сумма (buy_volume − sell_volume) по сделкам, линия + последнее значение.

**Источник данных:** `md:trades:{ex}:{sym}` — на frontend агрегируем дельту по бакетам (e.g., 1s). Опционально — серверная агрегация в risk-engine (`risk:signals:cvd`), но MVP можно на клиенте.

**Реализация:**
- lightweight-charts area series или canvas;
- Окно: 5/15/30/60 мин (toggle);
- Регистрация в `WIDGET_REGISTRY.cvd` (icon: `Sigma`, defaultW 4, H 4);
- Reset кнопка — обнуляет аккумулятор.

**Acceptance:** виджет добавляется через меню, показывает live CVD-линию.

---

### B9. Alerts — фильтры по символам и типам
**Файл:** [ui/frontend/src/widgets/AlertsWidget.tsx](ui/frontend/src/widgets/AlertsWidget.tsx)

**Сделать:**
- В header виджета — два мультиселекта: **Symbol** (из набора активных panels), **Type** (`drawdown`, `level`, `volatility`, `exposure`, `funding`...).
- Состояние фильтров — в `widget.props` (персистится через layout.store).
- Применение — `useMemo`-фильтр над списком алертов из `risk.store`.
- Кнопка "Clear all" / счётчик отфильтрованных.

**Acceptance:** оператор может оставить только Drawdown-алерты по BTC, не теряя остальные в фоне.

---

## Группа C — Микроструктура / Heatmap / Footprint

### C1. Утечка памяти в Microstructure
**Файл:** [ui/frontend/src/widgets/MicrostructureWidget.tsx](ui/frontend/src/widgets/MicrostructureWidget.tsx) + `src/widgets/dom/analytics.ts`, `src/widgets/dom/detectors.ts`.

**Действия:**
1. Профилировать через Chrome DevTools Memory (heap snapshots) после 10–15 мин работы — найти удерживаемые объекты.
2. Подозрения (по результатам exploration):
   - `analytics.ts` — `cleaner = setInterval(...)`: проверить, что есть `clearInterval` на unmount/symbol-change.
   - Refs c накапливающимися массивами trades/snapshots без обрезки.
   - WS-подписки, которые не отписываются при смене символа (handler накапливается).
3. Фикс: явный AbortController на компонент, sliding window обрезка `if (arr.length > MAX) arr.splice(0, arr.length - MAX)`.

**Acceptance:** heap stable ±10MB за 30 мин на одном символе; смена символа возвращает heap к baseline.

---

### C2. Microstructure — быстрая загрузка на любых активах
**Контекст:** на низколиквидных активах виджет долго "копит" объём, прежде чем что-то показать.

**Действия:**
- Перенести warmup-логику на time-based окно (как в B4).
- При смене символа — гидратация из существующего `snapshot:ob:*` и последних N trades (REST endpoint `/api/trades/recent/:ex/:sym?limit=500`), чтобы не ждать live-поток.
- Показать "Loading microstructure..." статус, если данных < 30s.

**Acceptance:** на любом supported символе виджет показывает осмысленные метрики через ≤5 сек после смены символа.

---

### C3. График — рисование (как в TradingView)
**Файл:** `CandleChartWidget.tsx`.

**Scope (MVP):**
- Trend line (две точки)
- Horizontal line
- Rectangle (zone)
- Удаление выделенного объекта (Del)

**Реализация:**
- lightweight-charts не поддерживает drawings из коробки. Варианты:
  - **a)** Оверлей `<canvas>` поверх графика, координаты time↔x через `chart.timeScale().timeToCoordinate()`, price↔y через `series.priceToCoordinate()`. Хранить чертежи в `widget.props.drawings` (persist через layout.store).
  - **b)** Использовать [klinecharts](https://github.com/klinecharts/KLineChart) — но это смена charting-движка, риск регрессий. Отложить.
- Выбран вариант **a** для MVP.
- Toolbar в header графика: иконки `Minus` (trend), `Move` (horizontal), `Square` (rect), `MousePointer` (select), `Trash2`.

**Acceptance:** пользователь может провести трендовую, рисунки переживают перезагрузку страницы.

---

### C4. Heatmap → объединить со стаканом + увеличить размер по умолчанию
**Файлы:**
- [ui/frontend/src/widgets/OrderBookWidget.tsx](ui/frontend/src/widgets/OrderBookWidget.tsx) — уже имеет `heatmap strip` (см. exploration).
- [ui/frontend/src/widgets/LiquidityHeatmapWidget.tsx](ui/frontend/src/widgets/LiquidityHeatmapWidget.tsx) — переезжает / удаляется как отдельный виджет.

**Решение:**
- Превратить OrderBook в режимный виджет: tabs/toggle "Ladder | Heatmap | Split". В режиме "Heatmap" — полноразмерный canvas (логика из `LiquidityHeatmapWidget`).
- Удалить запись `heatmap` из `WIDGET_REGISTRY` (или оставить как алиас, который создаёт OrderBook в режиме Heatmap).
- `WIDGET_REGISTRY.orderbook.defaultW: 4 → 6`, `defaultH: 8 → 10` — больше места по умолчанию.
- Detector state (`createDetectorState`, `runDetectors`) — общий между ladder и heatmap, инициализируется один раз.
- Persisted layouts с `type:"heatmap"` — мигрировать в `type:"orderbook"` с `props.mode:"heatmap"` при гидратации store.

**Acceptance:** в одном виджете три режима, heatmap отображается крупно, никаких дубликатов состояния.

---

### C5. Footprint Chart — отдельный виджет
**Новый файл:** `ui/frontend/src/widgets/FootprintWidget.tsx`.

**Что:** свечной график, где каждая свеча — вертикальный footprint: для каждой цены внутри свечи показаны buy/sell объёмы (bid×ask × volume), POC выделен.

**Данные:** требуется time-and-sales (`md:trades:*`) + агрегация по price-buckets внутри окна свечи. Лучше — серверная агрегация:
- Новый сервис или endpoint в market-data: `/api/footprint/:ex/:sym?tf=1m&limit=50` → массив `{time, priceBuckets: [{price, buyVol, sellVol}]}`.
- WS канал `footprint:{ex}:{sym}:{tf}` для live-апдейтов текущей свечи.

**Frontend:** canvas-рендер (lightweight-charts не подходит). Toggle tf (1m/5m/15m), tick aggregation как в OrderBook.

**Registry:** `footprint` (icon: `Grid3x3`, defaultW 8, H 8).

**Acceptance:** виджет добавляется, показывает footprint-свечи, обновляет последнюю в real-time.

---

## Группа D — Cross-cutting

### D1. История стрима / переполнение Redis
**Вопрос пользователя:** "сколько храним историю и может ли быть переполнение?"

**Действия:**
1. Аудит: для каждого `md:*`, `risk:*`, `hedge:*`, `trade:*` стрима выяснить, есть ли `MAXLEN ~ N` в XADD. Проверить в:
   - `market-data/src/streams/*.ts`
   - `risk-engine/src/streams/*.ts`
   - `hedge-engine/src/streams/*.ts`
   - `trade-execution/src/streams/*.ts`
2. Если у каких-то стримов нет лимита — добавить `MAXLEN ~`:
   - `md:trades:*` → 10_000 (≈ часы при средней частоте)
   - `md:orderbook:*` → 2_000 (UI берёт snapshot, история не нужна)
   - `md:funding:*` → 500
   - `risk:signals:*` → 5_000
   - `risk:alerts` → 10_000
   - `hedge:state/actions` → 5_000
   - `trade:orders/journal` → **без MAXLEN** (журнал) — или 100_000 + архивация
3. Документировать в CLAUDE.md в разделе "Redis Key Schema" реальные лимиты.
4. Мониторинг: ручка `/api/admin/streams` — `XLEN` для всех ключей; раз в N минут логирует в pino.

**Acceptance:** ни один стрим не растёт неограниченно; в README указаны retention-цифры.

---

### D2. Миграция persisted layout
Несколько задач удаляют типы виджетов (`levels`, `chart`, `heatmap`). У пользователей в localStorage остались записи.

**Файл:** `layout.store.ts` — версия persist storage.

**Решение:**
- Bump `version: N → N+1` в `persist` config.
- `migrate` функция: для каждой Pane.widgets отфильтровать `type ∈ {levels, chart}`; `heatmap` — конвертировать в `orderbook` с `props.mode: "heatmap"`.
- Также подчистить `pane.layout` от соответствующих `i`.

**Acceptance:** пользователь, обновивший приложение, не видит ошибок гидратации.

---

## Порядок выполнения / параллельность

Группы независимы — можно распараллелить:

| Параллель | Задачи | Зависимости |
|-----------|--------|-------------|
| Track 1 (frontend infra) | A1, A2, A3, D2 | — |
| Track 2 (виджеты быстрые) | B1, B2, B3, B9 | — |
| Track 3 (chart heavy) | B5, B6, B7, C3 | B5 и B6 пересекаются по CandleChart — делать одним агентом или последовательно |
| Track 4 (микроструктура) | C1, C2, C4 | — |
| Track 5 (новые виджеты) | B8 (CVD), C5 (Footprint) | A2 (иконки) — желательно сначала |
| Track 6 (volatility) | B4 | — (бэкенд) |
| Track 7 (платформа) | D1 | — |

**Рекомендация:** сначала A1 (быстрый win по UX), затем D2 + миграционные таски (B5, B6, C4) одним агентом, чтобы избежать конфликтов миграций.

---

## Чеклист для каждого PR
- [ ] нет `as any`
- [ ] cleanup в `useEffect` (AbortController/clearInterval/unsubscribe)
- [ ] persisted layout не ломается у существующих пользователей
- [ ] коммит без `Co-Authored-By`
- [ ] прогнаны: `npm run typecheck && npm run lint` в `ui/frontend`
- [ ] для серверных изменений — обновлён CLAUDE.md (Redis schema, эндпоинты)
