import "dotenv/config";
import { HedgeEngine } from "./src/index.ts";
import { config } from "./config/hedge.config.ts";
import pino from "pino";

const logger = pino({ name: "main", level: config.logLevel });

const engine = new HedgeEngine(config);

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutdown signal received");
  await engine.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start
try {
  await engine.start();

  logger.info(
    {
      mode: config.globalMode,
      exchanges: config.exchanges,
      autoHedge: config.autoHedge.enabled,
      emergencyExit: config.emergencyExit.autoTriggerEnabled,
    },
    "Hedge Engine running"
  );
} catch (err) {
  logger.fatal({ err }, "Failed to start Hedge Engine");
  process.exit(1);
}
