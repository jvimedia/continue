import * as crypto from "node:crypto";
import * as http from "node:http";

import { ChatMessage } from "core";
import { ToCoreProtocol, FromCoreProtocol } from "core/protocol";
import { InProcessMessenger, Message } from "core/protocol/messenger";
import cors from "cors";
import express from "express";
import * as vscode from "vscode";
import { WebSocket, WebSocketServer } from "ws";

import { VsCodeWebviewProtocol } from "../webviewProtocol";

/**
 * A single update pushed to subscribers of the chat stream (SSE or
 * WebSocket). `turnId` correlates the user message that started a turn with
 * the assistant deltas/completion that follow it - it is the same
 * `messageId` Continue already uses internally for the `llm/streamChat`
 * request/response pair.
 */
export interface ChatStreamEvent {
  type:
    | "user_message"
    | "assistant_delta"
    | "assistant_done"
    | "session"
    | "error";
  turnId: string;
  timestamp: number;
  data: unknown;
}

const CHAT_API_OUTPUT_CHANNEL_NAME = "Continue Chat API";

/**
 * Exposes the chat session that's active in the Continue sidebar over a
 * small local HTTP/SSE/WebSocket API, so external clients (an iOS app, a
 * Telegram bot, etc.) can watch the conversation stream live and send
 * messages into it.
 *
 * It works by tapping the two hooks on `VsCodeWebviewProtocol`
 * (`onDidSendMessage` / `onDidReceiveWebviewMessage`): every message that
 * already flows between Core and the chat webview passes through here too,
 * so this server never talks to the LLM or session storage directly - it
 * mirrors exactly what the sidebar renders, and re-uses the existing
 * `userInput` mechanism (the same one used by "Ask Continue about this
 * terminal error") to inject messages back in.
 */
export class ChatApiServer {
  private app = express();
  private httpServer?: http.Server;
  private wss?: WebSocketServer;
  private wsClients = new Set<WebSocket>();
  private sseClients = new Set<express.Response>();
  private outputChannel: vscode.OutputChannel;
  private token: string = "";
  private port: number = 0;

  constructor(
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly inProcessMessenger: InProcessMessenger<
      ToCoreProtocol,
      FromCoreProtocol
    >,
  ) {
    this.outputChannel = vscode.window.createOutputChannel(
      CHAT_API_OUTPUT_CHANNEL_NAME,
    );
    this.webviewProtocol.onDidSendMessage = (messageType, data, messageId) =>
      this.handleOutgoingWebviewMessage(messageType, data, messageId);
    this.webviewProtocol.onDidReceiveWebviewMessage = (msg) =>
      this.handleIncomingWebviewMessage(msg);
  }

  get isRunning(): boolean {
    return this.httpServer !== undefined;
  }

  async start(port: number, host: string, token: string): Promise<void> {
    if (this.isRunning) {
      await this.stop();
    }

    this.token = token;
    this.port = port;

    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use((req, res, next) => this.requireAuth(req, res, next));

    this.registerRoutes();

    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer, path: "/ws" });
    this.wss.on("connection", (ws, req) => this.handleWsConnection(ws, req));

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once("error", reject);
      this.httpServer!.listen(port, host, () => resolve());
    });

    this.log(
      `Chat API server listening on http://${host}:${port} (SSE: /events, WebSocket: /ws)`,
    );
  }

  async stop(): Promise<void> {
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    for (const client of this.wsClients) {
      client.close();
    }
    this.wsClients.clear();

    this.wss?.close();
    this.wss = undefined;

    if (this.httpServer) {
      await new Promise<void>((resolve) =>
        this.httpServer!.close(() => resolve()),
      );
      this.httpServer = undefined;
    }
  }

  dispose(): void {
    void this.stop();
    this.outputChannel.dispose();
  }

  private log(message: string) {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------

  private isTokenValid(candidate: string | undefined): boolean {
    if (!candidate || !this.token) {
      return false;
    }
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  private requireAuth(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) {
    if (req.path === "/health") {
      next();
      return;
    }
    const header = req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    const queryToken =
      typeof req.query.token === "string" ? req.query.token : undefined;
    if (this.isTokenValid(bearer) || this.isTokenValid(queryToken)) {
      next();
      return;
    }
    res.status(401).json({ error: "Invalid or missing API token" });
  }

  // ---------------------------------------------------------------------
  // HTTP routes
  // ---------------------------------------------------------------------

  private registerRoutes() {
    this.app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    this.app.get("/session", async (_req, res) => {
      try {
        res.json(await this.getSessionSnapshot());
      } catch (e: any) {
        res.status(500).json({ error: e?.message ?? String(e) });
      }
    });

    this.app.post("/message", async (req, res) => {
      const input = req.body?.input;
      if (typeof input !== "string" || input.trim().length === 0) {
        res.status(400).json({ error: "Body must be { input: string }" });
        return;
      }
      await vscode.commands.executeCommand("continue.continueGUIView.focus");
      await this.webviewProtocol.request("userInput", { input });
      res.json({ ok: true });
    });

    this.app.get("/events", (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      this.sseClients.add(res);
      req.on("close", () => this.sseClients.delete(res));
    });
  }

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? undefined;
    if (!this.isTokenValid(token)) {
      ws.close(4401, "Invalid or missing API token");
      return;
    }

    this.wsClients.add(ws);
    ws.on("close", () => this.wsClients.delete(ws));
    ws.on("message", async (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        if (parsed?.type === "message" && typeof parsed.input === "string") {
          await vscode.commands.executeCommand(
            "continue.continueGUIView.focus",
          );
          await this.webviewProtocol.request("userInput", {
            input: parsed.input,
          });
        }
      } catch (e: any) {
        this.log(`Failed to handle WS message: ${e?.message ?? e}`);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Mirroring: tap the existing Core <-> webview traffic
  // ---------------------------------------------------------------------

  private handleIncomingWebviewMessage(msg: Message) {
    if (msg.messageType !== "llm/streamChat") {
      return;
    }
    const messages = (msg.data as { messages?: ChatMessage[] })?.messages;
    const lastUserMessage = [...(messages ?? [])]
      .reverse()
      .find((m) => m.role === "user");
    if (lastUserMessage) {
      this.broadcast({
        type: "user_message",
        turnId: msg.messageId,
        timestamp: Date.now(),
        data: lastUserMessage,
      });
    }
  }

  private handleOutgoingWebviewMessage(
    messageType: string,
    data: any,
    messageId: string,
  ) {
    if (messageType === "llm/streamChat") {
      const { done, content, status, error } = data ?? {};
      if (!done) {
        // Each non-final response carries one streamed ChatMessage chunk.
        this.broadcast({
          type: "assistant_delta",
          turnId: messageId,
          timestamp: Date.now(),
          data: { content, status },
        });
        return;
      }
      // The final response's `content` is the underlying async generator's
      // *return* value - a PromptLog (`{ modelTitle, prompt, completion }`),
      // not a ChatMessage like every delta before it. Normalize it into the
      // same `{ role, content }` shape so clients can treat `data.content`
      // consistently across delta/done events, while still passing the raw
      // PromptLog through as `promptLog` for anyone who wants the metadata.
      const promptLog = content as { completion?: string } | undefined;
      this.broadcast({
        type: "assistant_done",
        turnId: messageId,
        timestamp: Date.now(),
        data: {
          content:
            typeof promptLog?.completion === "string"
              ? { role: "assistant", content: promptLog.completion }
              : undefined,
          promptLog: content,
          status,
          error,
        },
      });
    } else if (messageType === "sessionUpdate") {
      this.broadcast({
        type: "session",
        turnId: messageId,
        timestamp: Date.now(),
        data,
      });
    }
  }

  private broadcast(event: ChatStreamEvent) {
    const payload = JSON.stringify(event);

    for (const client of this.sseClients) {
      client.write(`data: ${payload}\n\n`);
    }

    for (const client of this.wsClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Session snapshot
  // ---------------------------------------------------------------------

  private async getSessionSnapshot(): Promise<{
    sessionId: string | undefined;
    session: unknown;
  }> {
    const sessionId = await this.webviewProtocol.request(
      "getCurrentSessionId",
      undefined,
    );
    if (!sessionId) {
      return { sessionId: undefined, session: undefined };
    }
    const session = await this.inProcessMessenger.externalRequest(
      "history/load",
      { id: sessionId },
    );
    return { sessionId, session };
  }
}
