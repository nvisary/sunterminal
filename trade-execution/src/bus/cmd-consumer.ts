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
  private loop: Promise<void> | null = null;

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

    // Single XREADGROUP over all streams — Redis wakes the BLOCK as soon as
    // any stream has new data. The previous design (one loop per stream)
    // serialised 11 BLOCK commands on one connection in ioredis and caused
    // multi-second delays before a click was processed.
    this.loop = this.consumeLoop();

    logger.info({ streams: CMD_STREAMS.length, consumer: this.consumerName }, "CmdConsumer started");
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) await this.loop.catch(() => {});
    this.loop = null;
    logger.info("CmdConsumer stopped");
  }

  private async consumeLoop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.bus.readGroupMulti(
          CmdConsumerGroup,
          this.consumerName,
          CMD_STREAMS,
          10,
          5_000,
        );
        if (messages.length === 0) continue;
        for (const { stream, id, data } of messages) {
          const handler = this.handlers.get(stream as CmdStream);
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
        logger.error({ err }, "Cmd consumer loop error");
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }
}
