import type { RedisBus } from "../bus/redis-bus.ts";
import type { SignalPublisher } from "../signal-bus/signal-publisher.ts";
import type { AccountSnapshot } from "../consumers/account-poller.ts";
import type { DrawdownState, DrawdownLevel, RiskEngineConfig } from "../types/risk.types.ts";
import { RiskSnapshotKeys } from "../bus/channels.ts";
import pino from "pino";

const logger = pino({ name: "drawdown-monitor" });

export class DrawdownMonitor {
  private bus: RedisBus;
  private publisher: SignalPublisher;
  private cfg: RiskEngineConfig["drawdown"];

  // State
  private equity = 0;
  private peakEquity = 0;
  private dailyStartEquity = 0;
  private dailyResetTime = 0;
  private currentLevel: DrawdownLevel = "NORMAL";
  private isTradeBlocked = false;
  private dailyResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(bus: RedisBus, publisher: SignalPublisher, cfg: RiskEngineConfig["drawdown"]) {
    this.bus = bus;
    this.publisher = publisher;
    this.cfg = cfg;
  }

  async restoreState(): Promise<void> {
    const savedPeak = await this.bus.getSnapshot<number>(RiskSnapshotKeys.peakEquity);
    const savedDaily = await this.bus.getSnapshot<number>(RiskSnapshotKeys.dailyStartEquity);

    if (savedPeak !== null) this.peakEquity = savedPeak;
    if (savedDaily !== null) this.dailyStartEquity = savedDaily;

    logger.info({ peakEquity: this.peakEquity, dailyStartEquity: this.dailyStartEquity }, "State restored");
  }

  startDailyReset(): void {
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    const msToMidnight = nextMidnight.getTime() - now.getTime();

    this.dailyResetTime = nextMidnight.getTime();

    this.dailyResetTimer = setTimeout(() => {
      this.resetDaily();
      // Then repeat every 24h
      this.dailyResetTimer = setInterval(() => this.resetDaily(), 86_400_000);
    }, msToMidnight);

    logger.info({ nextResetIn: Math.round(msToMidnight / 1000) }, "Daily drawdown reset scheduled");
  }

  stopDailyReset(): void {
    if (this.dailyResetTimer) {
      clearTimeout(this.dailyResetTimer);
      clearInterval(this.dailyResetTimer);
      this.dailyResetTimer = null;
    }
  }

  /**
   * Called by AccountPoller on each update.
   */
  async onAccountUpdate(snapshot: AccountSnapshot): Promise<void> {
    const equity = this.computeEquity(snapshot);
    if (equity <= 0) return; // No valid data yet

    this.equity = equity;

    // Initialize on first run
    if (this.peakEquity === 0) {
      this.peakEquity = equity;
      this.dailyStartEquity = equity;
      await this.persistState();
    }

    // Update peak
    if (equity > this.peakEquity) {
      this.peakEquity = equity;
      await this.bus.setSnapshot(RiskSnapshotKeys.peakEquity, this.peakEquity);
    }

    // Compute drawdowns
    const peakDD = this.peakEquity > 0 ? ((this.peakEquity - equity) / this.peakEquity) * 100 : 0;
    const dailyDD = this.dailyStartEquity > 0 ? ((this.dailyStartEquity - equity) / this.dailyStartEquity) * 100 : 0;

    // Check per-position drawdown
    await this.checkPerPositionDrawdown(snapshot);

    // Evaluate level based on daily drawdown (primary) and peak (secondary)
    const newLevel = this.evaluateLevel(dailyDD, peakDD);
    const prevLevel = this.currentLevel;
    this.currentLevel = newLevel;

    // Update trade block
    this.isTradeBlocked = newLevel === "DANGER" || newLevel === "CRITICAL" || newLevel === "MAX_PEAK";

    // Emit signal if level changed
    if (newLevel !== prevLevel && newLevel !== "NORMAL") {
      const action = this.levelToAction(newLevel);
      const signalType = `DD_${newLevel}` as const;

      await this.publisher.publishDrawdown({
        source: "drawdown",
        type: signalType,
        level: this.levelToSeverity(newLevel),
        payload: {
          currentEquity: equity,
          peakEquity: this.peakEquity,
          dailyStartEquity: this.dailyStartEquity,
          drawdownPct: peakDD,
          dailyDrawdownPct: dailyDD,
        },
        action,
        timestamp: Date.now(),
      });

      logger.warn(
        { level: newLevel, equity, peakDD: peakDD.toFixed(2), dailyDD: dailyDD.toFixed(2), action },
        "Drawdown level changed"
      );
    }

    logger.debug({
      equity: equity.toFixed(2),
      peakDD: peakDD.toFixed(2),
      dailyDD: dailyDD.toFixed(2),
      level: newLevel,
    }, "Drawdown update");
  }

  getState(): DrawdownState {
    const peakDD = this.peakEquity > 0 ? ((this.peakEquity - this.equity) / this.peakEquity) * 100 : 0;
    const dailyDD = this.dailyStartEquity > 0
      ? ((this.dailyStartEquity - this.equity) / this.dailyStartEquity) * 100
      : 0;

    return {
      equity: this.equity,
      peakEquity: this.peakEquity,
      dailyStartEquity: this.dailyStartEquity,
      dailyResetTime: this.dailyResetTime,
      peakDrawdownPct: peakDD,
      dailyDrawdownPct: dailyDD,
      currentLevel: this.currentLevel,
      isTradeBlocked: this.isTradeBlocked,
    };
  }

  getCurrentEquity(): number {
    return this.equity;
  }

  getIsTradeBlocked(): boolean {
    return this.isTradeBlocked;
  }

  // ─── Private ──────────────────────────────────────────────────

  private computeEquity(snapshot: AccountSnapshot): number {
    let total = 0;

    // Sum USDT balances across all exchanges
    for (const [, balance] of snapshot.balances) {
      total += balance.total?.USDT ?? balance.total?.usdt ?? 0;
    }

    // Add unrealized PnL from all positions
    for (const [, positions] of snapshot.positions) {
      for (const pos of positions) {
        total += pos.unrealizedPnl ?? 0;
      }
    }

    return total;
  }

  private async checkPerPositionDrawdown(snapshot: AccountSnapshot): Promise<void> {
    for (const [exchange, positions] of snapshot.positions) {
      for (const pos of positions) {
        if (pos.contracts === 0 || pos.entryPrice === 0) continue;

        const side = pos.side === "short" ? "short" : "long";
        const markPrice = pos.markPrice || pos.entryPrice;
        let posDD: number;

        if (side === "long") {
          posDD = ((pos.entryPrice - markPrice) / pos.entryPrice) * (pos.leverage || 1) * 100;
        } else {
          posDD = ((markPrice - pos.entryPrice) / pos.entryPrice) * (pos.leverage || 1) * 100;
        }

        if (posDD > this.cfg.perTradePct) {
          await this.publisher.publishDrawdown({
            source: "drawdown",
            type: "DD_PER_TRADE",
            level: "warning",
            payload: {
              currentEquity: this.equity,
              peakEquity: this.peakEquity,
              dailyStartEquity: this.dailyStartEquity,
              drawdownPct: posDD,
              dailyDrawdownPct: 0,
              affectedPosition: {
                exchange,
                symbol: pos.symbol,
                side,
                drawdownPct: posDD,
              },
            },
            action: "close_position",
            timestamp: Date.now(),
          });

          logger.warn({ exchange, symbol: pos.symbol, side, posDD: posDD.toFixed(2) }, "Per-trade DD threshold breached");
        }
      }
    }
  }

  private evaluateLevel(dailyDD: number, peakDD: number): DrawdownLevel {
    if (peakDD >= this.cfg.maxPeakPct) return "MAX_PEAK";
    if (dailyDD >= this.cfg.criticalPct) return "CRITICAL";
    if (dailyDD >= this.cfg.dangerPct) return "DANGER";
    if (dailyDD >= this.cfg.warningPct) return "WARNING";
    return "NORMAL";
  }

  private levelToAction(level: DrawdownLevel): "alert" | "block_new" | "close_all" {
    switch (level) {
      case "WARNING": return "alert";
      case "DANGER": return "block_new";
      case "CRITICAL": return "close_all";
      case "MAX_PEAK": return "close_all";
      default: return "alert";
    }
  }

  private levelToSeverity(level: DrawdownLevel): "info" | "warning" | "danger" | "critical" {
    switch (level) {
      case "WARNING": return "warning";
      case "DANGER": return "danger";
      case "CRITICAL": return "critical";
      case "MAX_PEAK": return "critical";
      default: return "info";
    }
  }

  private resetDaily(): void {
    this.dailyStartEquity = this.equity;
    this.dailyResetTime = Date.now() + 86_400_000;
    this.bus.setSnapshot(RiskSnapshotKeys.dailyStartEquity, this.dailyStartEquity).catch((err) =>
      logger.error({ err }, "Failed to persist daily start equity")
    );
    logger.info({ dailyStartEquity: this.dailyStartEquity }, "Daily drawdown reset");
  }

  private async persistState(): Promise<void> {
    await this.bus.setSnapshot(RiskSnapshotKeys.peakEquity, this.peakEquity);
    await this.bus.setSnapshot(RiskSnapshotKeys.dailyStartEquity, this.dailyStartEquity);
  }
}
