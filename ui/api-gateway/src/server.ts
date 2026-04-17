import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import { RedisSubscriber } from "./ws/redis-subscriber.ts";
import { WsProxy } from "./ws/ws-proxy.ts";
import { createTradeRoutes } from "./routes/trade.routes.ts";
import pino from "pino";

const logger = pino({ name: "api-gateway" });

const PORT = Number(process.env.GATEWAY_PORT) || 3001;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Redis connections
const redis = new Redis(REDIS_URL);
const subscriber = new RedisSubscriber(REDIS_URL);

// WS Proxy
const wsProxy = new WsProxy(subscriber, redis);

// REST routes
const tradeRoutes = createTradeRoutes(redis);

// HTTP Server
const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Parse body for POST/PUT
  let body: Record<string, unknown> = {};
  if (method === "POST" || method === "PUT") {
    body = await parseBody(req);
  }

  // Health check
  if (path === "/health" && method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ status: "ok", clients: wsProxy.getClientCount() }));
    return;
  }

  // Try trade routes
  try {
    const handled = await tradeRoutes(path, method, body, res, url);
    if (handled) return;
  } catch (err) {
    logger.error({ err, path }, "Route handler error");
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// WebSocket Server
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => wsProxy.handleConnection(ws));

// Start
await subscriber.connect();

server.listen(PORT, () => {
  logger.info({ port: PORT, redis: REDIS_URL }, "API Gateway started");
});

// Graceful shutdown
const shutdown = () => {
  logger.info("Shutting down API Gateway...");
  wss.close();
  server.close();
  subscriber.disconnect();
  redis.disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ─── Helpers ──────────────────────────────────────────────────────

function parseBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}
