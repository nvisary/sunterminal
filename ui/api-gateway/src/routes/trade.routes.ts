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

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}
