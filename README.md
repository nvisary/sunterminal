# SunTerminal

Crypto trading assistant -- модульная система для real-time маркет-данных, risk management, хеджирования и автоматического исполнения ордеров.

## Требования

- **Node.js** >= 20
- **Docker** (для Redis)
- **npm**

Проверить:
```bash
node -v   # v20+
docker -v
npm -v
```

## Быстрый старт

### 1. Redis

```bash
docker compose up -d
```

Проверить что Redis работает:
```bash
docker compose ps          # STATUS: running
redis-cli ping             # PONG
```

### 2. Настройка API-ключей

Для получения рыночных данных (orderbook, trades) API-ключи не нужны.  
Для балансов, позиций и торговли -- нужны ключи бирж.

Отредактируй `market-data/.env`:
```bash
# Bybit (ключи для балансов/позиций)
BYBIT_API_KEY=your_key
BYBIT_SECRET=your_secret

# Binance (если доступен -- заблокирован в РФ)
BINANCE_ENABLED=false     # отключить если нет доступа
```

### 3. Установка зависимостей (один раз)

```bash
cd market-data     && npm install && cd ..
cd risk-engine     && npm install && cd ..
cd hedge-engine    && npm install && cd ..
cd trade-execution && npm install && cd ..
cd ui/api-gateway  && npm install && cd ../..
cd ui/frontend     && npm install && cd ../..
```

Или одной командой:
```bash
for dir in market-data risk-engine hedge-engine trade-execution ui/api-gateway ui/frontend; do
  (cd "$dir" && npm install)
done
```

### 4. Запуск всех модулей

Каждый модуль запускается в отдельном терминале. Порядок важен.

**Терминал 1 -- Market Data** (должен быть первым):
```bash
cd market-data
npm start
```

Ожидаемый вывод:
```
{"name":"redis-bus","msg":"Redis bus connected"}
{"name":"exchange-factory","id":"bybit","msg":"Exchange instance created"}
{"name":"exchange-manager","id":"bybit","markets":3361,"msg":"Exchange connected, markets loaded"}
{"name":"market-data-service","msg":"Market Data Service started"}
{"name":"main","msg":"Market Data Layer running"}
```

**Терминал 2 -- Risk Engine**:
```bash
cd risk-engine
npm start
```

Ожидаемый вывод:
```
{"name":"redis-bus","msg":"Redis bus connected"}
{"name":"md-consumer","streams":12,"msg":"Market data consumer started"}
{"name":"account-poller","msg":"Account poller started"}
{"name":"volatility-scanner","msg":"Volatility scanner started"}
{"name":"level-detector","msg":"Level detector started"}
{"name":"alert-manager","msg":"Alert manager started"}
{"name":"risk-engine","msg":"Risk Engine started"}
```

**Терминал 3 -- Hedge Engine**:
```bash
cd hedge-engine
npm start
```

Ожидаемый вывод:
```
{"name":"redis-bus","msg":"Redis bus connected"}
{"name":"auto-hedge","msg":"Auto-hedge started"}
{"name":"hedge-engine","msg":"Hedge Engine started"}
```

**Терминал 4 -- Trade Execution**:
```bash
cd trade-execution
npm start
```

Ожидаемый вывод:
```
{"name":"redis-bus","msg":"Redis bus connected"}
{"name":"trade-execution","msg":"Trade Execution Service started"}
```

**Терминал 5 -- API Gateway**:
```bash
cd ui/api-gateway
npm start
```

Ожидаемый вывод:
```
{"name":"api-gateway","port":3001,"msg":"API Gateway started"}
```

**Терминал 6 -- Frontend (dev server)**:
```bash
cd ui/frontend
npm run dev
```

Открыть в браузере: **http://localhost:3000**

## Проверка работоспособности

### Redis Streams наполняются данными

```bash
# Проверить что trades идут
redis-cli XLEN md:trades:bybit:BTC/USDT:USDT
# Должно расти с каждой секундой

# Проверить orderbook snapshot
redis-cli GET snapshot:ob:bybit:BTC/USDT:USDT | head -c 200

# Проверить что risk engine публикует volatility
redis-cli XLEN risk:signals:volatility
```

### API Gateway отвечает

```bash
curl http://localhost:3001/health
# {"status":"ok","clients":0}
```

### Frontend

Открыть http://localhost:3000 -- должна быть dark-theme страница с виджетами: Order Book, Trade Form, Drawdown, Exposure, Alerts, Hedge.

## Архитектура

```
                    +-----------+
                    |   Redis   |
                    +-----+-----+
                          |
          +-------+-------+-------+-------+
          |       |       |       |       |
     market-  risk-   hedge-  trade-  api-
      data    engine  engine  exec   gateway
       |                                |
       |   CCXT Pro                     |  WS + HTTP
       |   (Binance, Bybit)            |
       v                                v
    Exchanges                      React UI
```

**Поток данных:**
1. `market-data` подключается к биржам через CCXT Pro, публикует в Redis Streams
2. `risk-engine` читает md:* streams, анализирует, публикует risk:signals:*
3. `hedge-engine` читает risk signals, управляет хеджами, публикует hedge:*
4. `trade-execution` исполняет ордера через market-data REST command pattern
5. `api-gateway` проксирует Redis -> WebSocket для UI
6. `frontend` отображает всё в реальном времени

## Конфигурация

Все модули настраиваются через `.env` файлы. Основные параметры:

| Файл | Что настраивать |
|------|----------------|
| `market-data/.env` | API-ключи бирж, включение/отключение бирж |
| `risk-engine/.env` | Пороги drawdown (2/4/6%), exposure limits |
| `hedge-engine/.env` | Режим (advisor/controller), пороги хеджирования |
| `trade-execution/.env` | Risk per trade (1%), leverage (5x), max position ($100) |
| `ui/api-gateway/.env` | Порт gateway (3001), Redis URL |

## Остановка

`Ctrl+C` в каждом терминале. Все модули корректно завершают работу (graceful shutdown).

Остановить Redis:
```bash
docker compose down
```

## Dev mode (с hot-reload)

```bash
npm run dev    # вместо npm start, в любом модуле
```

## Устранение проблем

| Проблема | Решение |
|----------|---------|
| `Exchange not found: binance` | Binance заблокирован, поставь `BINANCE_ENABLED=false` в market-data/.env |
| `bybit requires "apiKey"` | Добавь API-ключи Bybit в market-data/.env (нужно для балансов/позиций) |
| `Redis connection error` | Проверь что Redis запущен: `docker compose up -d` |
| `ECONNREFUSED :3001` | API Gateway не запущен, запусти `cd ui/api-gateway && npm start` |
| Frontend пустой | Проверь что market-data запущен и данные идут в Redis |
