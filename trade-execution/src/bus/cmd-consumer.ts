import { hostname } from "node:os";
import type { RedisBus } from "./redis-bus.ts";
import { CmdStreamKeys, CmdConsumerGroup } from "./channels.ts";
import pino from "pino";

const logger = pino({ name: "cmd-consumer" });

type CmdHandler = (data: Record<string, unknown>) => Promise<void>;

const CMD_STREAMS = [
  CmdStreamKeys.tradeOpen,
  CmdStreamKeys.tradeClose,
  CmdStreamKeys.tradeCloseAll,
  CmdStreamKeys.tradeCalcSize,
  CmdStreamKeys.simOpen,
  CmdStreamKeys.simClose,
  CmdStreamKeys.simCloseAll,
  CmdStreamKeys.simLimit,
  CmdStreamKeys.simCancel,
  CmdStreamKeys.simReset,
  CmdStreamKeys.simConfig,
] as const;

export type CmdStream = (typeof CMD_STREAMS)[number];

/**
 * Consumes command streams from the gateway and dispatches to handlers.
 * Loops independently per stream so a slow handler can't block siblings.
 *
 * The consumer group is shared (`trade-exec`) so multiple replicas could be
 * load-balanced in the future, but for now there's a single instance.
 */
export class CmdConsumer {
  private bus: RedisBus;
  private handlers = new Map<CmdStream, CmdHandler>();
  private running = false;
  private consumerName: string;
  private loops = new Map<CmdStream, Promise<void>>();

  constructor(bus: RedisBus) {
    this.bus = bus;
    this.consumerName = `${hostname()}-${process.pid}`;
  }

  on(stream: CmdStream, handler: CmdHandler): void {
    this.handlers.set(stream, handler);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Ensure consumer groups exist for all streams (so XREADGROUP doesn't fail)
    for (const stream of CMD_STREAMS) {
      await this.bus.ensureConsumerGroup(stream, CmdConsumerGroup);
    }

    // Spawn one loop per stream so slow handlers don't head-of-line block
    for (const stream of CMD_STREAMS) {
      this.loops.set(stream, this.consumeLoop(stream));
    }

    logger.info({ streams: CMD_STREAMS.length, consumer: this.consumerName }, "CmdConsumer started");
  }

  async stop(): Promise<void> {
    this.running = false;
    // Loops exit on next tick when running=false
    await Promise.allSettled(this.loops.values());
    this.loops.clear();
    logger.info("CmdConsumer stopped");
  }

  private async consumeLoop(stream: CmdStream): Promise<void> {
    const handler = this.handlers.get(stream);
    while (this.running) {
      try {
        const messages = await this.bus.readGroup(CmdConsumerGroup, this.consumerName, stream, 10, 5_000);
        if (messages.length === 0) continue;
        for (const { id, data } of messages) {
          if (!handler) {
            logger.warn({ stream }, "No handler registered, dropping cmd");
            await this.bus.ack(stream, CmdConsumerGroup, id);
            continue;
          }
          try {
            await handler(data);
          } catch (err) {
            logger.error({ stream, err, data }, "Cmd handler error");
          }
          await this.bus.ack(stream, CmdConsumerGroup, id);
        }
      } catch (err) {
        if (!this.running) return;
        logger.error({ stream, err }, "Cmd consumer loop error");
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }
}
