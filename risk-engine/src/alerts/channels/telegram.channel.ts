import pino from "pino";

const logger = pino({ name: "telegram-channel" });

export class TelegramChannel {
  private botToken: string;
  private chatId: string;
  private queue: string[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  start(): void {
    // Process queue at 1 msg/sec rate limit
    this.timer = setInterval(() => this.processQueue(), 1000);
    logger.info("Telegram channel started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  send(message: string): void {
    this.queue.push(message);
  }

  formatDrawdown(payload: Record<string, unknown>): string {
    const equity = (payload.currentEquity as number)?.toFixed(2) ?? "?";
    const peak = (payload.peakEquity as number)?.toFixed(2) ?? "?";
    const dd = (payload.drawdownPct as number)?.toFixed(1) ?? "?";
    const dailyDD = (payload.dailyDrawdownPct as number)?.toFixed(1) ?? "?";

    return [
      "[DRAWDOWN WARNING]",
      `Daily DD: -${dailyDD}%`,
      `Peak DD: -${dd}%`,
      `Equity: $${equity} (peak: $${peak})`,
    ].join("\n");
  }

  formatExposure(payload: Record<string, unknown>): string {
    const type = payload.type ?? "EXP_HIGH";
    return `[EXPOSURE] ${type}: ${JSON.stringify(payload)}`;
  }

  formatVolatility(payload: Record<string, unknown>): string {
    const regime = payload.regime ?? "UNKNOWN";
    const symbol = payload.symbol ?? "";
    const atrPct = (payload.atrPercent as number)?.toFixed(3) ?? "?";
    return `[VOLATILITY] ${symbol} regime: ${regime}, ATR%: ${atrPct}`;
  }

  formatGeneric(signal: Record<string, unknown>): string {
    const source = signal.source ?? "unknown";
    const type = signal.type ?? "";
    const level = signal.level ?? "info";
    return `[${String(level).toUpperCase()}] ${source}: ${type}\n${JSON.stringify(signal.payload ?? {}, null, 2)}`;
  }

  // ─── Private ──────────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    const message = this.queue.shift();
    if (!message) return;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: "HTML",
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.error({ status: response.status, body }, "Telegram send failed");
        // Retry once
        this.queue.unshift(message);
      }
    } catch (err) {
      logger.error({ err }, "Telegram send error");
    }
  }
}
