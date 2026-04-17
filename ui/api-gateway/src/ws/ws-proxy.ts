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
const MAX_MD_SUBSCRIPTIONS = 20;

export class WsProxy {
  private subscriber: RedisSubscriber;
  private redis: Redis;
  private clientHandlers = new Map<WebSocket, Map<string, MessageHandler>>();
  private mdSubscribed = new Set<string>(); // "exchange:symbol" currently active
  private mdSubscribedOrder: string[] = []; // LRU order for eviction

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
      this.checkMdUnsubscription(channel);
    }
  }

  private removeClient(ws: WebSocket): void {
    const handlers = this.clientHandlers.get(ws);
    if (handlers) {
      for (const [channel, handler] of handlers) {
        this.subscriber.unsubscribe(channel, handler);
        this.checkMdUnsubscription(channel);
      }
    }
    this.clientHandlers.delete(ws);
    logger.debug("WebSocket client disconnected");
  }

  private static parseSymbolChannel(channel: string): { exchange: string; symbol: string } | null {
    const match = channel.match(/^(?:orderbook|trades|ticker):([^:]+):(.+)$/);
    if (!match) return null;
    return { exchange: match[1]!, symbol: match[2]! };
  }

  /**
   * When a client subscribes to orderbook/trades/ticker for a symbol,
   * tell market-data to subscribe if not already done.
   * Evicts oldest subscriptions when over the limit.
   */
  private async ensureMdSubscription(channel: string): Promise<void> {
    const parsed = WsProxy.parseSymbolChannel(channel);
    if (!parsed) return;

    const { exchange, symbol } = parsed;
    const key = `${exchange}:${symbol}`;

    if (this.mdSubscribed.has(key)) {
      // Move to end of LRU
      this.mdSubscribedOrder = this.mdSubscribedOrder.filter((k) => k !== key);
      this.mdSubscribedOrder.push(key);
      return;
    }

    // Evict oldest if over limit
    while (this.mdSubscribed.size >= MAX_MD_SUBSCRIPTIONS && this.mdSubscribedOrder.length > 0) {
      const oldest = this.mdSubscribedOrder.shift()!;
      await this.sendMdCommand("unsubscribe", oldest);
      this.mdSubscribed.delete(oldest);
    }

    this.mdSubscribed.add(key);
    this.mdSubscribedOrder.push(key);
    await this.sendMdCommand("subscribe", key);
  }

  /**
   * When no clients are listening to any channel for a symbol,
   * tell market-data to unsubscribe.
   */
  private checkMdUnsubscription(channel: string): void {
    const parsed = WsProxy.parseSymbolChannel(channel);
    if (!parsed) return;

    const { exchange, symbol } = parsed;
    const key = `${exchange}:${symbol}`;

    if (!this.mdSubscribed.has(key)) return;

    // Check if any client still listens to any stream for this symbol
    const prefixes = [`orderbook:${exchange}:${symbol}`, `trades:${exchange}:${symbol}`, `ticker:${exchange}:${symbol}`];
    for (const prefix of prefixes) {
      if (this.subscriber.getSubscriberCount(prefix) > 0) return;
    }

    // No listeners left — unsubscribe from market-data
    this.mdSubscribed.delete(key);
    this.mdSubscribedOrder = this.mdSubscribedOrder.filter((k) => k !== key);
    this.sendMdCommand("unsubscribe", key);
  }

  private async sendMdCommand(method: "subscribe" | "unsubscribe", key: string): Promise<void> {
    const [exchange, ...rest] = key.split(":");
    const symbol = rest.join(":");
    try {
      await this.redis.xadd(
        "cmd:rest-request",
        "MAXLEN", "~", "1000",
        "*",
        "data", JSON.stringify({ method, exchange, args: [symbol], replyTo: "" })
      );
      logger.info({ exchange, symbol }, `Requested market-data ${method}`);
    } catch (err) {
      logger.error({ exchange, symbol, err }, `Failed to request md ${method}`);
      if (method === "subscribe") {
        this.mdSubscribed.delete(key);
        this.mdSubscribedOrder = this.mdSubscribedOrder.filter((k) => k !== key);
      }
    }
  }

  getClientCount(): number {
    return this.clientHandlers.size;
  }
}
