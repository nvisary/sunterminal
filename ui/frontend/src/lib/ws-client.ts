type MessageHandler<T = Record<string, unknown>> = (data: T) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private pendingSubscriptions = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  constructor(url: string = WsClient.resolveUrl()) {
    this.url = url;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) { ws.close(); return; }
      console.log("[WS] Connected");
      for (const channel of this.handlers.keys()) {
        this.send({ action: "subscribe", channel });
      }
      for (const channel of this.pendingSubscriptions) {
        this.send({ action: "subscribe", channel });
      }
      this.pendingSubscriptions.clear();
    };

    ws.onmessage = (event) => {
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

    ws.onclose = () => {
      if (this.ws !== ws) return; // stale connection, ignore
      console.log("[WS] Disconnected, reconnecting in 2s...");
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  subscribe<T = Record<string, unknown>>(channel: string, handler: MessageHandler<T>): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ action: "subscribe", channel });
      } else {
        this.pendingSubscriptions.add(channel);
      }
    }
    this.handlers.get(channel)!.add(handler as MessageHandler);

    // Return unsubscribe function
    return () => {
      const set = this.handlers.get(channel);
      if (set) {
        set.delete(handler as MessageHandler);
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

  static resolveUrl(): string {
    const host = window.location.host;
    // In Tauri or file:// — connect to gateway directly
    if (!host || host.includes('tauri.localhost') || window.location.protocol === 'file:') {
      return 'ws://localhost:3001/ws';
    }
    // In dev (Vite proxy) — use same host
    return `ws://${host}/ws`;
  }
}

export const API_BASE = (() => {
  const host = window.location.host;
  if (!host || host.includes('tauri.localhost') || window.location.protocol === 'file:') {
    return 'http://localhost:3001';
  }
  return '';
})();

export const wsClient = new WsClient();
