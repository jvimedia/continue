import { loadConfig } from "./config";
import { ContinueApiClient } from "./continueApiClient";
import { EventStreamManager } from "./eventStream";
import { logger } from "./logger";
import { ContinueTelegramBot } from "./telegramBot";

async function main(): Promise<void> {
  const config = loadConfig();

  logger.info(
    `Starting Continue Telegram bot. Continue API: ${config.continueApiUrl}, ` +
      `allowed chat IDs: ${[...config.allowedChatIds].join(", ")}`,
  );

  const apiClient = new ContinueApiClient(
    config.continueApiUrl,
    config.continueApiToken,
  );

  const healthy = await apiClient.health();
  if (!healthy) {
    logger.warn(
      "Continue Chat API is not reachable yet - is VS Code open with " +
        "continue.chatApi.enabled set to true? Will keep retrying the " +
        "event stream in the background; Telegram commands will report " +
        "errors until it's reachable.",
    );
  } else {
    logger.info("Connected to Continue Chat API.");
  }

  const telegramBot = new ContinueTelegramBot(config, apiClient);

  const eventStream = new EventStreamManager(apiClient, (event) => {
    void telegramBot.handleStreamEvent(event).catch((e) => {
      logger.error(`Error handling stream event: ${(e as Error).message}`);
    });
  });
  eventStream.start();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await eventStream.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err.message}`);
  });
}

main().catch((e) => {
  logger.error(`Fatal error during startup: ${(e as Error).message}`);
  process.exit(1);
});
