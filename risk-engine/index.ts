import "dotenv/config";
import { RiskEngine } from "./src/index.ts";
import { config } from "./config/risk.config.ts";
import pino from "pino";

const logger = pino({ name: "main", level: config.logLevel });

const engine = new RiskEngine(config);

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
      exchanges: config.exchanges,
      symbols: config.symbols,
      drawdown: config.drawdown,
      exposure: config.exposure,
    },
    "Risk Engine running"
  );
} catch (err) {
  logger.fatal({ err }, "Failed to start Risk Engine");
  process.exit(1);
}
