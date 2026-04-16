import type { WebSocket } from "ws";
import type Redis from "ioredis";
import type { RedisSubscriber } from "./redis-subscriber.ts";
import pino from "pino";

const logger = pino({ name: "ws-proxy" });

type MessageHandler = (channel: string, data: Record<string, unknown>) => void;

/**
 * Manages WebSocket connections and proxies Redis data to clients.
 * Automatically tells market-data to subscribe to new symbols.
 */
export class WsProxy {
  private subscriber: RedisSubscriber;
  private redis: Redis;
  private clientHandlers = new Map<WebSocket, Map<string, MessageHandler>>();
  private mdSubscribed = new Set<string>(); // "exchange:symbol" already requested

  constructor(subscriber: RedisSubscriber, redis: Redis) {
    this.subscriber = subscriber;
    this.redis = redis;
  }

  handleConnection(ws: WebSocket): void {
    this.clientHandlers.set(ws, new Map());

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { action: string; channel: string };
        if (msg.action === "subscribe") {
          this.subscribeClient(ws, msg.channel);
        } else if (msg.action === "unsubscribe") {
          this.unsubscribeClient(ws, msg.channel);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      this.removeClient(ws);
    });

    ws.on("error", () => {
      this.removeClient(ws);
    });

    logger.debug("WebSocket client connected");
  }

  private subscribeClient(ws: WebSocket, channel: string): void {
    const handlers = this.clientHandlers.get(ws);
    if (!handlers || handlers.has(channel)) return;

    const handler: MessageHandler = (ch, data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ channel: ch, data }));
      }
    };

    handlers.set(channel, handler);
    this.subscriber.subscribe(channel, handler);

    // Auto-subscribe market-data to new symbols
    this.ensureMdSubscription(channel);

    logger.debug({ channel }, "Client subscribed");
  }

  private unsubscribeClient(ws: WebSocket, channel: string): void {
    const handlers = this.clientHandlers.get(ws);
    if (!handlers) return;

    const handler = handlers.get(channel);
    if (handler) {
      this.subscriber.unsubscribe(channel, handler);
      handlers.delete(channel);
    }
  }

  private removeClient(ws: WebSocket): void {
    const handlers = this.clientHandlers.get(ws);
    if (handlers) {
      for (const [channel, handler] of handlers) {
        this.subscriber.unsubscribe(channel, handler);
      }
    }
    this.clientHandlers.delete(ws);
    logger.debug("WebSocket client disconnected");
  }

  /**
   * When a client subscribes to orderbook/trades/ticker for a symbol,
   * tell market-data to subscribe if not already done.
   */
  private async ensureMdSubscription(channel: string): Promise<void> {
    // Parse channel: "orderbook:bybit:BTC/USDT:USDT" or "trades:bybit:ETH/USDT:USDT"
    const match = channel.match(/^(?:orderbook|trades|ticker):([^:]+):(.+)$/);
    if (!match) return;

    const exchange = match[1]!;
    const symbol = match[2]!;
    const key = `${exchange}:${symbol}`;

    if (this.mdSubscribed.has(key)) return;
    this.mdSubscribed.add(key);

    try {
      await this.redis.xadd(
        "cmd:rest-request",
        "MAXLEN", "~", "1000",
        "*",
        "data", JSON.stringify({ method: "subscribe", exchange, args: [symbol], replyTo: "" })
      );
      logger.info({ exchange, symbol }, "Requested market-data subscription");
    } catch (err) {
      logger.error({ exchange, symbol, err }, "Failed to request md subscription");
      this.mdSubscribed.delete(key);
    }
  }

  getClientCount(): number {
    return this.clientHandlers.size;
  }
}
