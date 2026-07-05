import { ChatStreamEvent } from "./continueApiClient";
import { extractText, mergeDoneText } from "./chatText";
import { logger } from "./logger";

/** Telegram's hard cap on a single message's text length. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
/** How often (at most) we edit the "in progress" message while streaming. */
const EDIT_THROTTLE_MS = 1_500;
const THINKING_PLACEHOLDER = "…";

/**
 * Minimal surface TurnManager needs from the Telegram client. Kept as an
 * interface so the streaming/merge logic above can be reasoned about (and
 * in principle tested) without pulling in node-telegram-bot-api.
 */
export interface TelegramSink {
  sendMessage(chatId: number, text: string): Promise<number>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
}

interface TurnState {
  turnId: string;
  chatIds: number[];
  text: string;
  finished: boolean;
  telegramMessageIds: Map<number, number>;
  lastEditAt: number;
  editTimer: ReturnType<typeof setTimeout> | undefined;
  dirty: boolean;
}

/**
 * Tracks in-flight Continue chat turns and relays them into Telegram as a
 * single message per chat that gets edited as `assistant_delta` events
 * arrive, then finalized on `assistant_done`.
 *
 * Because the Chat API mirrors one shared Continue session (see
 * docs/guides/chat-streaming-api.mdx) and events carry no origin chat ID, a
 * turn triggered by a message this bot forwarded is attributed to the chat
 * that sent it (via `registerPendingSend`); a turn we didn't initiate
 * (e.g. someone typing directly in the VS Code sidebar) is broadcast to
 * every allowed chat, since there's no better way to know who should see
 * it.
 */
export class TurnManager {
  private readonly turns = new Map<string, TurnState>();
  private readonly pendingSenders: number[] = [];

  constructor(
    private readonly sink: TelegramSink,
    private readonly allowedChatIds: number[],
  ) {}

  /** Call right after successfully POSTing a message on behalf of `chatId`. */
  registerPendingSend(chatId: number): void {
    this.pendingSenders.push(chatId);
  }

  async handleEvent(event: ChatStreamEvent): Promise<void> {
    switch (event.type) {
      case "user_message":
        await this.handleUserMessage(event);
        return;
      case "assistant_delta":
        await this.handleDelta(event);
        return;
      case "assistant_done":
        await this.handleDone(event);
        return;
      case "session":
        logger.info(`Session event for turn ${event.turnId}`);
        return;
      case "error":
        await this.handleErrorEvent(event);
        return;
      default:
        return;
    }
  }

  private chatIdsForNewTurn(): number[] {
    const next = this.pendingSenders.shift();
    if (next !== undefined) {
      return [next];
    }
    // No bot-initiated send is pending - this turn came from elsewhere
    // (e.g. the VS Code sidebar itself). Broadcast to everyone allowed.
    return [...this.allowedChatIds];
  }

  private async getOrCreateTurn(turnId: string): Promise<TurnState> {
    let turn = this.turns.get(turnId);
    if (turn) {
      return turn;
    }
    turn = {
      turnId,
      chatIds: this.chatIdsForNewTurn(),
      text: "",
      finished: false,
      telegramMessageIds: new Map(),
      lastEditAt: 0,
      editTimer: undefined,
      dirty: false,
    };
    this.turns.set(turnId, turn);

    await Promise.all(
      turn.chatIds.map(async (chatId) => {
        try {
          const messageId = await this.sink.sendMessage(
            chatId,
            THINKING_PLACEHOLDER,
          );
          turn!.telegramMessageIds.set(chatId, messageId);
        } catch (e) {
          logger.error(
            `Failed to send placeholder message to chat ${chatId}: ${(e as Error).message}`,
          );
        }
      }),
    );

    return turn;
  }

  private async handleUserMessage(event: ChatStreamEvent): Promise<void> {
    // Ensures the turn (and its placeholder message) exists as soon as the
    // user turn is confirmed, even before any delta arrives.
    await this.getOrCreateTurn(event.turnId);
  }

  private async handleDelta(event: ChatStreamEvent): Promise<void> {
    const turn = await this.getOrCreateTurn(event.turnId);
    if (turn.finished) {
      return;
    }
    const data = event.data as { content?: unknown } | undefined;
    const chunk = extractText(data?.content);
    if (chunk.length === 0) {
      return;
    }
    turn.text += chunk;
    turn.dirty = true;
    this.scheduleEdit(turn);
  }

  private async handleDone(event: ChatStreamEvent): Promise<void> {
    const turn = await this.getOrCreateTurn(event.turnId);
    if (turn.editTimer) {
      clearTimeout(turn.editTimer);
      turn.editTimer = undefined;
    }

    const data = event.data as
      | { content?: unknown; status?: string }
      | undefined;
    turn.text = mergeDoneText(turn.text, data?.content);
    turn.finished = true;

    const isError = data?.status === "error";
    const finalText = this.formatFinalText(turn.text, isError);

    await this.flushFinal(turn, finalText);
    this.turns.delete(event.turnId);
  }

  private async handleErrorEvent(event: ChatStreamEvent): Promise<void> {
    const turn = this.turns.get(event.turnId);
    const chatIds = turn?.chatIds ?? [...this.allowedChatIds];
    const message = `Continue API reported an error: ${safeStringify(event.data)}`;
    logger.error(message);
    await Promise.all(
      chatIds.map((chatId) =>
        this.sink.sendMessage(chatId, `⚠️ ${message}`).catch((e) => {
          logger.error(
            `Failed to send error notice to chat ${chatId}: ${(e as Error).message}`,
          );
        }),
      ),
    );
  }

  private formatFinalText(text: string, isError: boolean): string {
    const trimmed = text.trim();
    if (isError) {
      return trimmed.length > 0
        ? `⚠️ ${trimmed}`
        : "⚠️ The assistant reported an error and did not finish the reply.";
    }
    return trimmed.length > 0 ? trimmed : "(empty reply)";
  }

  private scheduleEdit(turn: TurnState): void {
    const now = Date.now();
    const elapsed = now - turn.lastEditAt;
    if (elapsed >= EDIT_THROTTLE_MS) {
      void this.flushEdit(turn);
      return;
    }
    if (turn.editTimer) {
      return;
    }
    turn.editTimer = setTimeout(() => {
      turn.editTimer = undefined;
      void this.flushEdit(turn);
    }, EDIT_THROTTLE_MS - elapsed);
  }

  private async flushEdit(turn: TurnState): Promise<void> {
    if (!turn.dirty || turn.finished) {
      return;
    }
    turn.dirty = false;
    turn.lastEditAt = Date.now();
    const text = clampForInProgressEdit(turn.text) || THINKING_PLACEHOLDER;
    await Promise.all(
      turn.chatIds.map(async (chatId) => {
        const messageId = turn.telegramMessageIds.get(chatId);
        if (messageId === undefined) {
          return;
        }
        try {
          await this.sink.editMessage(chatId, messageId, text);
        } catch (e) {
          logger.warn(
            `Failed to edit message ${messageId} in chat ${chatId}: ${(e as Error).message}`,
          );
        }
      }),
    );
  }

  private async flushFinal(turn: TurnState, finalText: string): Promise<void> {
    const chunks = splitForTelegram(finalText);
    await Promise.all(
      turn.chatIds.map(async (chatId) => {
        const messageId = turn.telegramMessageIds.get(chatId);
        try {
          if (messageId !== undefined) {
            await this.sink.editMessage(chatId, messageId, chunks[0]);
          } else {
            await this.sink.sendMessage(chatId, chunks[0]);
          }
          for (const extra of chunks.slice(1)) {
            await this.sink.sendMessage(chatId, extra);
          }
        } catch (e) {
          logger.error(
            `Failed to finalize reply in chat ${chatId}: ${(e as Error).message}`,
          );
        }
      }),
    );
  }
}

function clampForInProgressEdit(text: string): string {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
    return text;
  }
  const notice = "… (still streaming - showing latest text)\n\n";
  const tail = text.slice(
    text.length - (TELEGRAM_MAX_MESSAGE_LENGTH - notice.length),
  );
  return notice + tail;
}

/**
 * Splits text that may exceed Telegram's 4096-character message limit into
 * multiple chunks, preferring to break on newlines for readability.
 */
function splitForTelegram(
  text: string,
  max: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) {
      cut = max;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
