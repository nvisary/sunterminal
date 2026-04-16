import "dotenv/config";
import { MarketDataService } from "./src/index.ts";
import { config } from "./config/exchanges.config.ts";
import pino from "pino";

const logger = pino({ name: "main", level: config.logLevel });

const service = new MarketDataService(config);

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
      exchanges: service.getAvailableExchanges(),
      subscriptions: Object.fromEntries(
        [...service.getSubscriptions()].map(([k, v]) => [k, [...v]])
      ),
    },
    "Market Data Layer running"
  );
} catch (err) {
  logger.fatal({ err }, "Failed to start Market Data Service");
  process.exit(1);
}
