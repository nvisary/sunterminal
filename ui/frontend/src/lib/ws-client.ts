type MessageHandler = (data: Record<string, unknown>) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private pendingSubscriptions = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url: string = `ws://${window.location.host}/ws`) {
    this.url = url;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("[WS] Connected");
      // Re-subscribe all channels
      for (const channel of this.handlers.keys()) {
        this.send({ action: "subscribe", channel });
      }
      for (const channel of this.pendingSubscriptions) {
        this.send({ action: "subscribe", channel });
        this.pendingSubscriptions.delete(channel);
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { channel: string; data: Record<string, unknown> };
        const handlers = this.handlers.get(msg.channel);
        if (handlers) {
          for (const handler of handlers) handler(msg.data);
        }
      } catch {
        // ignore
      }
    };

    this.ws.onclose = () => {
      console.log("[WS] Disconnected, reconnecting in 2s...");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  subscribe(channel: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ action: "subscribe", channel });
      } else {
        this.pendingSubscriptions.add(channel);
      }
    }
    this.handlers.get(channel)!.add(handler);

    // Return unsubscribe function
    return () => {
      const set = this.handlers.get(channel);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.handlers.delete(channel);
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.send({ action: "unsubscribe", channel });
          }
        }
      }
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private send(msg: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }
}

export const wsClient = new WsClient();
