import TelegramBot from "node-telegram-bot-api";

import { Config } from "./config";
import { ContinueApiClient, SessionSnapshot } from "./continueApiClient";
import { extractText } from "./chatText";
import { logger } from "./logger";
import { TelegramSink, TurnManager } from "./turnManager";

const HISTORY_PREVIEW_COUNT = 5;
const HISTORY_MESSAGE_PREVIEW_CHARS = 300;

const START_MESSAGE = [
  "This bot relays messages between this Telegram chat and a Continue chat" +
    " session running in VS Code.",
  "",
  "Just send a normal message and it will be forwarded to Continue as if" +
    " you typed it into the sidebar. The assistant's reply streams back" +
    " here, edited in place as it arrives.",
  "",
  "Commands:",
  "/start - show this message",
  "/session - show a summary of the current Continue session",
  "/reset - see limitations below",
  "",
  "Limitations:",
  "- Only chats listed in ALLOWED_TELEGRAM_CHAT_IDS can use this bot.",
  "- There is no API to start a fresh Continue session remotely yet -" +
    " /reset can't actually reset anything (see /reset).",
].join("\n");

const RESET_MESSAGE = [
  "The Continue Chat API doesn't currently expose a way to start a new" +
    " session or clear history remotely - there's no endpoint for it (see" +
    " docs/guides/chat-streaming-api.mdx in the continue repo).",
  "",
  "To start fresh, begin a new chat from the Continue sidebar in VS Code" +
    ' (e.g. the "+" / "New Session" button); this bot will then mirror' +
    " whatever session is active there.",
].join("\n");

export class ContinueTelegramBot implements TelegramSink {
  private readonly bot: TelegramBot;
  private readonly turnManager: TurnManager;
  private readonly allowedChatIds: Set<number>;

  constructor(
    config: Config,
    private readonly apiClient: ContinueApiClient,
  ) {
    this.allowedChatIds = config.allowedChatIds;
    this.bot = new TelegramBot(config.telegramBotToken, { polling: true });
    this.turnManager = new TurnManager(this, [...this.allowedChatIds]);

    this.bot.on("polling_error", (err) => {
      logger.error(`Telegram polling error: ${err.message}`);
    });

    this.registerHandlers();
  }

  /** Feed a Chat API stream event into the Telegram relay logic. */
  async handleStreamEvent(event: Parameters<TurnManager["handleEvent"]>[0]) {
    await this.turnManager.handleEvent(event);
  }

  // -- TelegramSink -------------------------------------------------------

  async sendMessage(chatId: number, text: string): Promise<number> {
    const message = await this.bot.sendMessage(chatId, text);
    return message.message_id;
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (e) {
      const message = (e as Error).message ?? "";
      // Telegram errors if the new text is identical to the old one - not
      // an actual problem, just a no-op we can ignore.
      if (message.includes("message is not modified")) {
        return;
      }
      throw e;
    }
  }

  // -- Command / message handlers -----------------------------------------

  private registerHandlers(): void {
    this.bot.onText(/^\/start\b/, (msg) => {
      if (!this.isAllowed(msg)) return;
      void this.bot
        .sendMessage(msg.chat.id, START_MESSAGE)
        .catch((e) =>
          logger.error(`Failed to send /start reply: ${e.message}`),
        );
    });

    this.bot.onText(/^\/reset\b/, (msg) => {
      if (!this.isAllowed(msg)) return;
      void this.bot
        .sendMessage(msg.chat.id, RESET_MESSAGE)
        .catch((e) =>
          logger.error(`Failed to send /reset reply: ${e.message}`),
        );
    });

    this.bot.onText(/^\/session\b/, (msg) => {
      if (!this.isAllowed(msg)) return;
      void this.handleSessionCommand(msg.chat.id);
    });

    this.bot.on("message", (msg) => {
      // Let dedicated /start, /session, /reset handlers deal with commands;
      // ignore any other slash command and non-text messages.
      if (!msg.text || msg.text.startsWith("/")) {
        return;
      }
      if (!this.isAllowed(msg)) {
        logger.warn(
          `Ignoring message from disallowed chat ${msg.chat.id} ` +
            `(user ${msg.from?.username ?? msg.from?.id ?? "unknown"})`,
        );
        return;
      }
      void this.handleIncomingText(msg.chat.id, msg.text);
    });
  }

  private isAllowed(msg: TelegramBot.Message): boolean {
    return this.allowedChatIds.has(msg.chat.id);
  }

  private async handleIncomingText(
    chatId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.apiClient.postMessage(text);
      // Only mark this chat as the recipient of the resulting turn once the
      // POST has actually succeeded.
      this.turnManager.registerPendingSend(chatId);
    } catch (e) {
      logger.error(
        `Failed to forward message to Continue API: ${(e as Error).message}`,
      );
      await this.bot
        .sendMessage(
          chatId,
          "⚠️ Couldn't reach the Continue Chat API. Is VS Code open with " +
            "the chat API server enabled? I'll keep retrying the event " +
            "stream in the background.",
        )
        .catch(() => undefined);
    }
  }

  private async handleSessionCommand(chatId: number): Promise<void> {
    try {
      const snapshot = await this.apiClient.getSession();
      await this.bot.sendMessage(chatId, formatSessionSummary(snapshot));
    } catch (e) {
      logger.error(`Failed to fetch session: ${(e as Error).message}`);
      await this.bot
        .sendMessage(
          chatId,
          `⚠️ Couldn't fetch the session: ${(e as Error).message}`,
        )
        .catch(() => undefined);
    }
  }
}

export function formatSessionSummary(snapshot: SessionSnapshot): string {
  if (!snapshot.sessionId || !snapshot.session) {
    return "No Continue chat session has been started yet in VS Code.";
  }

  const session = snapshot.session as {
    title?: string;
    history?: Array<{ message?: { role?: string; content?: unknown } }>;
  };

  const lines: string[] = [];
  lines.push(`Session: ${session.title ?? "(untitled)"}`);
  lines.push(`ID: ${snapshot.sessionId}`);

  const history = session.history ?? [];
  if (history.length === 0) {
    lines.push("", "(no messages yet)");
    return lines.join("\n");
  }

  const recent = history.slice(-HISTORY_PREVIEW_COUNT);
  lines.push("", `Last ${recent.length} of ${history.length} message(s):`);
  for (const item of recent) {
    const role = item.message?.role ?? "unknown";
    const text = extractText(item.message).trim() || "(no text content)";
    const preview =
      text.length > HISTORY_MESSAGE_PREVIEW_CHARS
        ? `${text.slice(0, HISTORY_MESSAGE_PREVIEW_CHARS)}…`
        : text;
    lines.push(`\n[${role}] ${preview}`);
  }

  return lines.join("\n");
}
