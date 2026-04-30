import type { IncomingMessage, ServerResponse } from "node:http";
import Redis from "ioredis";
import pino from "pino";

const logger = pino({ name: "trade-routes" });

/**
 * REST routes for trade execution.
 * Proxies commands to backend modules via Redis.
 */
export function createTradeRoutes(redis: Redis) {
  return async (path: string, method: string, body: Record<string, unknown>, res: ServerResponse, url?: URL): Promise<boolean> => {
    // POST /api/trade/open
    if (path === "/api/trade/open" && method === "POST") {
      await redis.xadd("cmd:trade:open", "MAXLEN", "~", "100", "*", "data", JSON.stringify(body));
      json(res, 200, { ok: true, message: "Trade open command sent" });
      return true;
    }

    // POST /api/trade/limit — place raw limit order bypassing position-sizer (DOM clicks)
    // body: { exchange, symbol, side: 'buy'|'sell', price, amount, reduceOnly?, postOnly? }
    if (path === "/api/trade/limit" && method === "POST") {
      const { exchange, symbol, side, price, amount, reduceOnly, postOnly } = body as {
        exchange: string; symbol: string; side: "buy" | "sell";
        price: number; amount: number; reduceOnly?: boolean; postOnly?: boolean;
      };
      if (!exchange || !symbol || !side || !price || !amount) {
        json(res, 400, { error: "exchange, symbol, side, price, amount required" });
        return true;
      }
      const params: Record<string, unknown> = {};
      if (reduceOnly) params.reduceOnly = true;
      if (postOnly) params.postOnly = true;
      const result = await callRest(redis, exchange, "createOrder", [symbol, "limit", side, amount, price, params]);
      if (result.success) json(res, 200, { ok: true, order: result.data });
      else json(res, 502, { ok: false, error: result.error });
      return true;
    }

    // DELETE /api/trade/order — cancel order
    // body: { exchange, symbol, orderId }
    if (path === "/api/trade/order" && method === "DELETE") {
      const { exchange, symbol, orderId } = body as { exchange: string; symbol: string; orderId: string };
      if (!exchange || !symbol || !orderId) {
        json(res, 400, { error: "exchange, symbol, orderId required" });
        return true;
      }
      const result = await callRest(redis, exchange, "cancelOrder", [orderId, symbol]);
      if (result.success) json(res, 200, { ok: true, order: result.data });
      else json(res, 502, { ok: false, error: result.error });
      return true;
    }

    // GET /api/trade/open-orders/:exchange/:symbol — fetchOpenOrders for symbol
    const openOrdersMatch = path.match(/^\/api\/trade\/open-orders\/([^/]+)\/(.+)$/);
    if (openOrdersMatch && method === "GET") {
      const exchange = openOrdersMatch[1]!;
      const symbol = decodeURIComponent(openOrdersMatch[2]!);
      const result = await callRest(redis, exchange, "fetchOpenOrders", [symbol]);
      if (result.success) json(res, 200, result.data ?? []);
      else json(res, 502, { error: result.error });
      return true;
    }

    // POST /api/trade/close/:id
    const closeMatch = path.match(/^\/api\/trade\/close\/(.+)$/);
    if (closeMatch && method === "POST") {
      await redis.xadd("cmd:trade:close", "MAXLEN", "~", "100", "*", "data", JSON.stringify({ tradeId: closeMatch[1] }));
      json(res, 200, { ok: true, message: "Trade close command sent" });
      return true;
    }

    // POST /api/trade/close-all
    if (path === "/api/trade/close-all" && method === "POST") {
      await redis.xadd("cmd:trade:close-all", "MAXLEN", "~", "100", "*", "data", JSON.stringify(body));
      json(res, 200, { ok: true, message: "Close all command sent" });
      return true;
    }

    // POST /api/trade/calculate-size
    if (path === "/api/trade/calculate-size" && method === "POST") {
      await redis.xadd("cmd:trade:calculate-size", "MAXLEN", "~", "100", "*", "data", JSON.stringify(body));
      json(res, 200, { ok: true, message: "Size calculation requested" });
      return true;
    }

    // POST /api/hedge/emergency
    if (path === "/api/hedge/emergency" && method === "POST") {
      await redis.xadd("cmd:hedge:emergency", "MAXLEN", "~", "10", "*", "data", JSON.stringify({ trigger: "ui_button" }));
      json(res, 200, { ok: true, message: "Emergency exit triggered" });
      return true;
    }

    // POST /api/hedge/unlock
    if (path === "/api/hedge/unlock" && method === "POST") {
      await redis.xadd("cmd:hedge:unlock", "MAXLEN", "~", "10", "*", "data", JSON.stringify({}));
      json(res, 200, { ok: true, message: "Unlock command sent" });
      return true;
    }

    // GET /api/candles/:exchange/:symbol?tf=1h&limit=300 — fetch OHLCV via REST command
    const candlesMatch = path.match(/^\/api\/candles\/([^/]+)\/(.+)$/);
    if (candlesMatch && method === "GET") {
      const exchange = candlesMatch[1]!;
      const symbol = decodeURIComponent(candlesMatch[2]!);
      const tf = url?.searchParams.get("tf") ?? "1h";
      const limit = Number(url?.searchParams.get("limit") ?? "300");

      const { randomUUID } = await import("node:crypto");
      const reqId = randomUUID();
      const replyTo = `ml:rest-response:${reqId}`;

      await redis.xadd("cmd:rest-request", "MAXLEN", "~", "1000", "*",
        "data", JSON.stringify({ method: "fetchOHLCV", exchange, args: [symbol, tf, undefined, limit], replyTo }));

      // Poll for response
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await redis.xrevrange(replyTo, "+", "-", "COUNT", 1);
        if (result.length > 0) {
          await redis.del(replyTo);
          const fields = result[0]![1];
          const dataIdx = fields.indexOf("data");
          if (dataIdx !== -1 && fields[dataIdx + 1]) {
            const parsed = JSON.parse(fields[dataIdx + 1]!) as { success: boolean; data: unknown };
            if (parsed.success && Array.isArray(parsed.data)) {
              // OHLCV format: [[timestamp, open, high, low, close, volume], ...]
              const candles = (parsed.data as number[][]).map((c) => ({
                time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
              }));
              json(res, 200, candles);
              return true;
            }
          }
          json(res, 502, { error: "Failed to fetch candles" });
          return true;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      await redis.del(replyTo);
      json(res, 504, { error: "Candle fetch timeout" });
      return true;
    }

    // GET /api/markets/:exchange — list available swap symbols
    const marketsMatch = path.match(/^\/api\/markets\/([^/]+)$/);
    if (marketsMatch && method === "GET") {
      const exchange = marketsMatch[1]!;
      const cached = await redis.get(`rest:markets:${exchange}`);
      if (cached) {
        const markets = JSON.parse(cached) as Array<{ symbol: string; type: string; active: boolean; quote: string }>;
        // Filter to active USDT swap markets, return just symbols sorted
        const symbols = markets
          .filter((m) => m.active && m.type === "swap" && m.quote === "USDT")
          .map((m) => m.symbol)
          .sort();
        json(res, 200, symbols);
      } else {
        json(res, 200, []);
      }
      return true;
    }

    // GET /api/markets/:exchange/:symbol/info — metadata for a specific symbol
    const marketInfoMatch = path.match(/^\/api\/markets\/([^/]+)\/(.+)\/info$/);
    if (marketInfoMatch && method === "GET") {
      const exchange = marketInfoMatch[1]!;
      const symbol = decodeURIComponent(marketInfoMatch[2]!);
      const cached = await redis.get(`rest:markets:${exchange}`);
      if (!cached) {
        json(res, 404, { error: "markets not cached for exchange" });
        return true;
      }
      const markets = JSON.parse(cached) as Array<{
        symbol: string; base?: string; quote?: string; type?: string; active?: boolean;
        precision?: { price?: number; amount?: number };
        limits?: { amount?: { min?: number }; cost?: { min?: number } };
        contractSize?: number; maker?: number; taker?: number;
      }>;
      const m = markets.find((mm) => mm.symbol === symbol);
      if (!m) {
        json(res, 404, { error: "symbol not found" });
        return true;
      }
      // Normalize precision: ccxt may store either tickSize (TICK_SIZE mode) or decimal places.
      // Heuristic: if value < 1, treat as tickSize; otherwise as decimal places.
      const pricePrecision = m.precision?.price;
      const amountPrecision = m.precision?.amount;
      const tickSize =
        typeof pricePrecision === "number"
          ? pricePrecision < 1
            ? pricePrecision
            : Math.pow(10, -pricePrecision)
          : null;
      const amountStep =
        typeof amountPrecision === "number"
          ? amountPrecision < 1
            ? amountPrecision
            : Math.pow(10, -amountPrecision)
          : null;
      json(res, 200, {
        symbol: m.symbol,
        base: m.base ?? null,
        quote: m.quote ?? null,
        type: m.type ?? null,
        active: m.active ?? true,
        tickSize,
        amountStep,
        pricePrecision: pricePrecision ?? null,
        amountPrecision: amountPrecision ?? null,
        minQty: m.limits?.amount?.min ?? null,
        minCost: m.limits?.cost?.min ?? null,
        contractSize: m.contractSize ?? 1,
        makerFee: m.maker ?? null,
        takerFee: m.taker ?? null,
      });
      return true;
    }

    // GET /api/markets/:exchange/search?q=... — search symbols
    const searchMatch = path.match(/^\/api\/markets\/([^/]+)\/search$/);
    if (searchMatch && method === "GET") {
      const exchange = searchMatch[1]!;
      const q = (url?.searchParams.get("q") ?? "").toUpperCase();
      const cached = await redis.get(`rest:markets:${exchange}`);
      if (cached && q) {
        const markets = JSON.parse(cached) as Array<{ symbol: string; type: string; active: boolean; quote: string; base: string }>;
        const filtered = markets
          .filter((m) => m.active && m.type === "swap" && m.quote === "USDT" && (m.base.includes(q) || m.symbol.includes(q)));
        // Sort: exact base match first, then startsWith, then rest
        filtered.sort((a, b) => {
          const aExact = a.base === q ? 0 : a.base.startsWith(q) ? 1 : 2;
          const bExact = b.base === q ? 0 : b.base.startsWith(q) ? 1 : 2;
          if (aExact !== bExact) return aExact - bExact;
          return a.symbol.localeCompare(b.symbol);
        });
        const results = filtered.map((m) => m.symbol).slice(0, 30);
        json(res, 200, results);
      } else {
        json(res, 200, []);
      }
      return true;
    }

    // GET /api/snapshot/ob/:exchange/:symbol — get latest orderbook snapshot
    const obSnapMatch = path.match(/^\/api\/snapshot\/ob\/([^/]+)\/(.+)$/);
    if (obSnapMatch && method === "GET") {
      const exchange = obSnapMatch[1]!;
      const symbol = decodeURIComponent(obSnapMatch[2]!);
      try {
        const raw = await redis.get(`snapshot:ob:${exchange}:${symbol}`);
        json(res, 200, raw ? JSON.parse(raw) : null);
      } catch {
        json(res, 200, null);
      }
      return true;
    }

    // GET /api/snapshot/{funding|volatility|levels}/:exchange/:symbol
    const snapMatch = path.match(/^\/api\/snapshot\/(funding|volatility|levels)\/([^/]+)\/(.+)$/);
    if (snapMatch && method === "GET") {
      const kind = snapMatch[1]!;
      const exchange = snapMatch[2]!;
      const symbol = decodeURIComponent(snapMatch[3]!);
      const redisKey =
        kind === "funding"
          ? `snapshot:funding:${exchange}:${symbol}`
          : `risk:snapshot:${kind}:${exchange}:${symbol}`;
      try {
        const raw = await redis.get(redisKey);
        json(res, 200, raw ? JSON.parse(raw) : null);
      } catch {
        json(res, 200, null);
      }
      return true;
    }

    // POST /api/subscribe
    if (path === "/api/subscribe" && method === "POST") {
      const { exchange, symbol } = body as { exchange: string; symbol: string };
      await redis.xadd("cmd:rest-request", "MAXLEN", "~", "1000", "*",
        "data", JSON.stringify({ method: "subscribe", exchange, args: [symbol], replyTo: "" }));
      json(res, 200, { ok: true });
      return true;
    }

    // GET /api/journal/stats
    if (path === "/api/journal/stats" && method === "GET") {
      const stats = await redis.hget("trade:stats", "all");
      json(res, 200, stats ? JSON.parse(stats) : {});
      return true;
    }

    // GET /api/config/:module
    const configMatch = path.match(/^\/api\/config\/(.+)$/);
    if (configMatch && method === "GET") {
      const configKey = `config:${configMatch[1]}`;
      const cfg = await redis.get(configKey);
      json(res, 200, cfg ? JSON.parse(cfg) : {});
      return true;
    }

    // PUT /api/config/:module
    if (configMatch && method === "PUT") {
      const configKey = `config:${configMatch[1]}`;
      await redis.set(configKey, JSON.stringify(body));
      json(res, 200, { ok: true });
      return true;
    }

    return false; // Not handled
  };
}

async function callRest(
  redis: Redis,
  exchange: string,
  method: string,
  args: unknown[],
  timeoutMs = 10_000,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { randomUUID } = await import("node:crypto");
  const reqId = randomUUID();
  const replyTo = `ml:rest-response:${reqId}`;

  await redis.xadd("cmd:rest-request", "MAXLEN", "~", "1000", "*",
    "data", JSON.stringify({ method, exchange, args, replyTo }));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await redis.xrevrange(replyTo, "+", "-", "COUNT", 1);
    if (result.length > 0) {
      await redis.del(replyTo);
      const fields = result[0]![1];
      const dataIdx = fields.indexOf("data");
      if (dataIdx !== -1 && fields[dataIdx + 1]) {
        const parsed = JSON.parse(fields[dataIdx + 1]!) as { success: boolean; data?: unknown; error?: string };
        return parsed;
      }
      return { success: false, error: "empty reply" };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  await redis.del(replyTo);
  logger.warn({ exchange, method }, "REST call timeout");
  return { success: false, error: "timeout" };
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}
