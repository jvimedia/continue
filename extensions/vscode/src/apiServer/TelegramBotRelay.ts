import * as vscode from "vscode";

import { ChatApiServer, ChatStreamEvent } from "./ChatApiServer";
import { TelegramRelayCoordinator } from "./TelegramRelayCoordinator";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const LONG_POLL_TIMEOUT_SECONDS = 50;
const TELEGRAM_MESSAGE_LIMIT = 4096;

export type TelegramRelayState = "stopped" | "starting" | "running" | "error";

export interface TelegramRelayOptions {
  botToken: string;
  /** Comma-separated Telegram chat IDs allowed to talk to the bot. */
  allowedChatIds: string;
}

/**
 * Bridges the sidebar chat session to a Telegram bot: messages sent to the
 * bot (from an allowed chat) are injected into the Continue chat, and
 * assistant responses are relayed back to every allowed chat.
 *
 * Runs entirely inside the extension host using Telegram long polling, so it
 * needs no public URL/webhook and works even when the local HTTP API server
 * itself is disabled (it consumes `ChatApiServer.onEvent`, which mirrors the
 * webview traffic regardless of whether the network server is listening).
 */
export class TelegramBotRelay {
  private state: TelegramRelayState = "stopped";
  private lastError?: string;
  private botUsername?: string;
  private options?: TelegramRelayOptions;
  private pollAbort?: AbortController;
  private pollGeneration = 0;
  private eventSubscription?: vscode.Disposable;
  /** Accumulates assistant text per turnId until assistant_done arrives. */
  private pendingTurns = new Map<string, string>();
  /**
   * Texts we recently injected from Telegram, so the mirrored `user_message`
   * broadcast for them isn't echoed back to the chat as a duplicate.
   */
  private recentlyInjected: { text: string; at: number }[] = [];

  /**
   * Set when multiple VS Code windows coordinate bot ownership; powers the
   * `/windows` list and `/window <n>` handoff commands.
   */
  coordinator?: TelegramRelayCoordinator;
  /** This window's workspace name, shown in `/windows` and announcements. */
  workspaceName = "";

  constructor(
    private readonly chatApiServer: ChatApiServer,
    private readonly log: (message: string) => void,
  ) {}

  get status(): {
    state: TelegramRelayState;
    error?: string;
    botUsername?: string;
  } {
    return {
      state: this.state,
      error: this.lastError,
      botUsername: this.botUsername,
    };
  }

  get isRunning(): boolean {
    return this.state === "running" || this.state === "starting";
  }

  async start(
    options: TelegramRelayOptions,
    announceHandoff = false,
  ): Promise<void> {
    this.stop();
    this.options = options;
    this.state = "starting";
    this.lastError = undefined;

    try {
      const me = await this.callApi<{ username?: string }>("getMe", {});
      this.botUsername = me?.username;
      this.log(`Telegram relay connected as @${this.botUsername ?? "unknown"}`);
    } catch (e: any) {
      this.state = "error";
      this.lastError = `Telegram getMe failed: ${e?.message ?? e}`;
      this.log(this.lastError);
      return;
    }

    this.eventSubscription = this.chatApiServer.onEvent((event) =>
      this.handleChatEvent(event),
    );
    this.state = "running";
    void this.pollLoop(++this.pollGeneration);

    if (announceHandoff) {
      void this.broadcastToAllowedChats(
        `✅ Now connected to "${this.workspaceName || "(unnamed window)"}"`,
      );
    }
  }

  stop(): void {
    this.pollGeneration++;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    this.eventSubscription?.dispose();
    this.eventSubscription = undefined;
    this.pendingTurns.clear();
    this.state = "stopped";
  }

  dispose(): void {
    this.stop();
  }

  // ---------------------------------------------------------------------
  // Telegram -> Continue
  // ---------------------------------------------------------------------

  private async pollLoop(generation: number): Promise<void> {
    let offset = 0;
    while (generation === this.pollGeneration && this.options) {
      try {
        this.pollAbort = new AbortController();
        const updates = await this.callApi<
          { update_id: number; message?: any }[]
        >(
          "getUpdates",
          { timeout: LONG_POLL_TIMEOUT_SECONDS, offset },
          this.pollAbort.signal,
          (LONG_POLL_TIMEOUT_SECONDS + 10) * 1000,
        );
        for (const update of updates ?? []) {
          offset = Math.max(offset, update.update_id + 1);
          await this.handleTelegramUpdate(update);
        }
      } catch (e: any) {
        if (generation !== this.pollGeneration) {
          return;
        }
        this.log(`Telegram polling error: ${e?.message ?? e}`);
        // Back off so a bad token / network outage doesn't spin.
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async handleTelegramUpdate(update: { message?: any }): Promise<void> {
    const message = update.message;
    const chatId: number | undefined = message?.chat?.id;
    const text: string | undefined = message?.text;
    if (chatId === undefined || typeof text !== "string" || !text.trim()) {
      return;
    }

    if (!this.isChatAllowed(chatId)) {
      this.log(`Rejected Telegram message from disallowed chat ${chatId}`);
      await this.sendToChat(
        chatId,
        `This chat is not authorized. To allow it, add ${chatId} to "Allowed Chat IDs" in the Continue JV Chat API settings.`,
      );
      return;
    }

    if (text.trim().startsWith("/")) {
      await this.handleCommand(text.trim(), chatId);
      return;
    }

    this.rememberInjected(text);
    try {
      await this.chatApiServer.sendUserMessage(text);
    } catch (e: any) {
      await this.sendToChat(
        chatId,
        `Failed to deliver message to Continue: ${e?.message ?? e}`,
      );
    }
  }

  /**
   * Bot commands. Everything not starting with "/" goes into the chat, so
   * these never collide with normal messages.
   */
  private async handleCommand(text: string, chatId: number): Promise<void> {
    const [command, ...args] = text.split(/\s+/);
    switch (command.toLowerCase()) {
      case "/start":
      case "/help":
        await this.sendToChat(
          chatId,
          [
            "Messages you send here go into the Continue chat in VS Code, and assistant replies come back.",
            "",
            "/windows — list open VS Code windows",
            "/window <n> — move the bot to window n",
            "/help — this message",
          ].join("\n"),
        );
        return;

      case "/window":
      case "/windows": {
        const windows = (await this.coordinator?.listWindows()) ?? [];
        const target = args[0];
        if (!target) {
          if (windows.length === 0) {
            await this.sendToChat(
              chatId,
              `Connected to "${this.workspaceName || "(unnamed window)"}". No other windows available.`,
            );
            return;
          }
          const lines = windows.map((w, i) => {
            const here = this.coordinator?.windowId === w.windowId;
            return `${i + 1}. ${w.workspaceName || "(unnamed window)"}${here ? " ← connected" : ""}`;
          });
          await this.sendToChat(
            chatId,
            [
              "Open VS Code windows:",
              ...lines,
              "",
              "Switch with /window <n>",
            ].join("\n"),
          );
          return;
        }
        const index = Number.parseInt(target, 10) - 1;
        const chosen = windows[index];
        if (!chosen) {
          await this.sendToChat(
            chatId,
            `No window ${target}. Use /windows to list them.`,
          );
          return;
        }
        if (chosen.windowId === this.coordinator?.windowId) {
          await this.sendToChat(
            chatId,
            `Already connected to "${chosen.workspaceName || "(unnamed window)"}".`,
          );
          return;
        }
        await this.coordinator?.requestSwitch(chosen.windowId);
        await this.sendToChat(
          chatId,
          `Handing over to "${chosen.workspaceName || "(unnamed window)"}" — takes a few seconds…`,
        );
        return;
      }

      default:
        await this.sendToChat(chatId, `Unknown command ${command}. Try /help.`);
    }
  }

  private isChatAllowed(chatId: number): boolean {
    const allowed = (this.options?.allowedChatIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    return allowed.includes(String(chatId));
  }

  private rememberInjected(text: string) {
    const now = Date.now();
    this.recentlyInjected = this.recentlyInjected.filter(
      (e) => now - e.at < 30_000,
    );
    this.recentlyInjected.push({ text, at: now });
  }

  private consumeInjected(text: string): boolean {
    const index = this.recentlyInjected.findIndex((e) => e.text === text);
    if (index >= 0) {
      this.recentlyInjected.splice(index, 1);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Continue -> Telegram
  // ---------------------------------------------------------------------

  private handleChatEvent(event: ChatStreamEvent) {
    if (this.state !== "running") {
      return;
    }
    if (event.type === "user_message") {
      const text = extractText((event.data as any)?.content ?? event.data);
      // Skip the mirror of a message we injected from Telegram ourselves.
      if (text && !this.consumeInjected(text)) {
        void this.broadcastToAllowedChats(`👤 ${text}`);
      }
    } else if (event.type === "assistant_delta") {
      const text = extractText((event.data as any)?.content);
      if (text) {
        this.pendingTurns.set(
          event.turnId,
          (this.pendingTurns.get(event.turnId) ?? "") + text,
        );
      }
    } else if (event.type === "assistant_done") {
      const finalText = extractText((event.data as any)?.content);
      const accumulated = this.pendingTurns.get(event.turnId) ?? "";
      this.pendingTurns.delete(event.turnId);
      const text = accumulated || finalText;
      if (text.trim()) {
        void this.broadcastToAllowedChats(text);
      }
    }
  }

  private async broadcastToAllowedChats(text: string): Promise<void> {
    const allowed = (this.options?.allowedChatIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    for (const chatId of allowed) {
      for (const chunk of splitMessage(text)) {
        await this.sendToChat(chatId, chunk);
      }
    }
  }

  private async sendToChat(
    chatId: number | string,
    text: string,
  ): Promise<void> {
    try {
      await this.callApi("sendMessage", { chat_id: chatId, text });
    } catch (e: any) {
      this.log(`Telegram sendMessage to ${chatId} failed: ${e?.message ?? e}`);
    }
  }

  // ---------------------------------------------------------------------
  // Telegram Bot API plumbing
  // ---------------------------------------------------------------------

  private async callApi<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs: number = 30_000,
  ): Promise<T> {
    if (!this.options) {
      throw new Error("Telegram relay is not configured");
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(
      `${TELEGRAM_API_BASE}/bot${this.options.botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, timeoutSignal])
          : timeoutSignal,
      },
    );
    const json: any = await response.json();
    if (!json.ok) {
      throw new Error(json.description ?? `HTTP ${response.status}`);
    }
    return json.result as T;
  }
}

/**
 * Extract plain text from the various shapes chat content arrives in:
 * a string, a ChatMessage ({ role, content }), an array of message parts
 * ({ type: "text", text }), or arrays of any of those.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(extractText).join("");
  }
  if (content && typeof content === "object") {
    const obj = content as any;
    if (typeof obj.text === "string") {
      return obj.text;
    }
    if ("content" in obj) {
      return extractText(obj.content);
    }
  }
  return "";
}

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(i, i + TELEGRAM_MESSAGE_LIMIT));
  }
  return chunks;
}
