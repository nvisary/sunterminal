import "dotenv/config";
import { TradeExecutionService } from "./src/index.ts";
import { config } from "./config/trade.config.ts";
import pino from "pino";

const logger = pino({ name: "main", level: config.logLevel });

const service = new TradeExecutionService(config);

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.info({ signal }, "Shutdown signal received");
  await service.stop();
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start
try {
  await service.start();

  logger.info(
    {
      riskPerTrade: `${config.positionSizer.riskPerTrade}%`,
      maxPosition: `$${config.positionSizer.maxPositionUSD}`,
      leverage: `${config.positionSizer.defaultLeverage}x`,
      strategy: config.smartOrder.defaultStrategy,
    },
    "Trade Execution Service running"
  );
} catch (err) {
  logger.fatal({ err }, "Failed to start Trade Execution Service");
  process.exit(1);
}
