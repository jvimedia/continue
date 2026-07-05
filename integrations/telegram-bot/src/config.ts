import * as dotenv from "dotenv";

dotenv.config();

export interface Config {
  telegramBotToken: string;
  continueApiUrl: string;
  continueApiToken: string;
  allowedChatIds: Set<number>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to ` +
        `.env and fill it in - see README.md for details.`,
    );
  }
  return value.trim();
}

function parseAllowedChatIds(raw: string): Set<number> {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new Error(
          `Invalid entry "${s}" in ALLOWED_TELEGRAM_CHAT_IDS - must be a ` +
            `comma-separated list of integer Telegram chat IDs.`,
        );
      }
      return n;
    });
  if (ids.length === 0) {
    throw new Error(
      "ALLOWED_TELEGRAM_CHAT_IDS must contain at least one chat ID. " +
        "See README.md for how to find your chat ID.",
    );
  }
  return new Set(ids);
}

export function loadConfig(): Config {
  const telegramBotToken = required("TELEGRAM_BOT_TOKEN");
  const continueApiToken = required("CONTINUE_API_TOKEN");
  const allowedChatIds = parseAllowedChatIds(
    required("ALLOWED_TELEGRAM_CHAT_IDS"),
  );
  const continueApiUrl = (
    process.env.CONTINUE_API_URL ?? "http://127.0.0.1:65432"
  ).trim();

  return {
    telegramBotToken,
    continueApiUrl,
    continueApiToken,
    allowedChatIds,
  };
}
