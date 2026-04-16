import type { IncomingMessage, ServerResponse } from "node:http";
import Redis from "ioredis";
import pino from "pino";

const logger = pino({ name: "trade-routes" });

/**
 * REST routes for trade execution.
 * Proxies commands to backend modules via Redis.
 */
export function createTradeRoutes(redis: Redis) {
  return async (path: string, method: string, body: Record<string, unknown>, res: ServerResponse): Promise<boolean> => {
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
