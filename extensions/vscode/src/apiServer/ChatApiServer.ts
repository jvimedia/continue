import * as crypto from "node:crypto";
import * as http from "node:http";
import * as path from "node:path";

import { ChatMessage } from "core";
import { ToCoreProtocol, FromCoreProtocol } from "core/protocol";
import { InProcessMessenger, Message } from "core/protocol/messenger";
import cors from "cors";
import express from "express";
import * as vscode from "vscode";
import { WebSocket, WebSocketServer } from "ws";

import { getExtensionVersion } from "../util/util";
import { getExtensionUri } from "../util/vscode";
import { VsCodeWebviewProtocol } from "../webviewProtocol";

import { renderRemoteGuiHtml } from "./RemoteGui";

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

const CHAT_API_OUTPUT_CHANNEL_NAME = "Continue JV Chat API";

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
  private guiWss?: WebSocketServer;
  private wsClients = new Set<WebSocket>();
  private guiWsClients = new Set<WebSocket>();
  private guiClientDisposables = new Map<WebSocket, vscode.Disposable>();
  private sseClients = new Set<express.Response>();
  private outputChannel: vscode.OutputChannel;
  private token: string = "";
  private port: number = 0;
  private eventListeners = new Set<(event: ChatStreamEvent) => void>();

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

  /**
   * Subscribe to the mirrored chat stream. Fires for every event, even while
   * the HTTP server itself is stopped - in-process consumers (e.g. the
   * Telegram relay) don't require the network API to be enabled.
   */
  onEvent(listener: (event: ChatStreamEvent) => void): vscode.Disposable {
    this.eventListeners.add(listener);
    return new vscode.Disposable(() => this.eventListeners.delete(listener));
  }

  /** Inject a user message into the sidebar chat session. */
  async sendUserMessage(input: string): Promise<void> {
    await vscode.commands.executeCommand("continueJv.continueGUIView.focus");
    await this.webviewProtocol.request("userInput", { input });
  }

  /** The port the server is actually listening on (differs from the
   * configured port when it was taken, e.g. by another VS Code window). */
  get actualPort(): number {
    return this.port;
  }

  async start(port: number, host: string, token: string): Promise<void> {
    if (this.isRunning) {
      await this.stop();
    }

    this.token = token;

    this.app = express();
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use((req, res, next) => this.requireAuth(req, res, next));

    this.registerRoutes();

    this.httpServer = http.createServer(this.app);
    // Both WebSocket servers must use noServer + a single manual upgrade
    // router: a WebSocketServer bound directly to the HTTP server aborts
    // every upgrade whose path doesn't match its own (400), killing the
    // other endpoint's handshakes.
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (ws, req) => this.handleWsConnection(ws, req));
    this.guiWss = new WebSocketServer({ noServer: true });
    this.guiWss.on("connection", (ws, req) =>
      this.handleGuiWsConnection(ws, req),
    );
    this.httpServer.on("upgrade", (req, socket, head) => {
      const { pathname } = new URL(req.url ?? "", "http://localhost");
      const target =
        pathname === "/ws"
          ? this.wss
          : pathname === "/gui-ws"
            ? this.guiWss
            : undefined;
      if (!target) {
        socket.destroy();
        return;
      }
      target.handleUpgrade(req, socket, head, (ws) => {
        target.emit("connection", ws, req);
      });
    });

    // Each VS Code window runs its own server, so the configured port may
    // already be taken by another window - walk forward to the next free one.
    let lastError: Error | undefined;
    for (let candidate = port; candidate < port + 10; candidate++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (e: Error) => reject(e);
          this.httpServer!.once("error", onError);
          this.httpServer!.listen(candidate, host, () => {
            this.httpServer!.removeListener("error", onError);
            resolve();
          });
        });
        this.port = candidate;
        lastError = undefined;
        break;
      } catch (e: any) {
        lastError = e;
        if (e?.code !== "EADDRINUSE") {
          break;
        }
      }
    }
    if (lastError) {
      this.httpServer = undefined;
      throw lastError;
    }

    this.log(
      `Chat API server listening on http://${host}:${this.port} (SSE: /events, WebSocket: /ws, remote GUI: /gui)`,
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

    for (const client of this.guiWsClients) {
      client.close();
    }
    this.guiWsClients.clear();
    for (const disposable of this.guiClientDisposables.values()) {
      disposable.dispose();
    }
    this.guiClientDisposables.clear();

    this.wss?.close();
    this.wss = undefined;
    this.guiWss?.close();
    this.guiWss = undefined;

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

  log(message: string) {
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
    // /gui/* serves only the static GUI app bundle (no user data); the page
    // itself can't do anything without a valid token for its /gui-ws bridge.
    if (req.path === "/health" || req.path.startsWith("/gui")) {
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

    // ------ Remote GUI: the real React app, served for browsers/WKWebView

    this.app.get(["/gui", "/gui/"], (req, res) => {
      const queryToken =
        typeof req.query.token === "string" ? req.query.token : undefined;
      if (!this.isTokenValid(queryToken)) {
        res.status(401).send("Invalid or missing API token");
        return;
      }
      res.type("html").send(renderRemoteGuiHtml());
    });

    this.app.use(
      "/gui",
      express.static(path.join(getExtensionUri().fsPath, "gui"), {
        index: false,
        fallthrough: false,
      }),
    );

    // ------ Window/session browser (used by the iOS app's server list)

    this.app.get("/info", async (_req, res) => {
      const workspaceFolders =
        vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ??
        [];
      const currentSessionId = await Promise.race([
        this.webviewProtocol.request("getCurrentSessionId", undefined),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 3000),
        ),
      ]);
      res.json({
        workspaceName:
          vscode.workspace.name ??
          workspaceFolders.map((f) => path.basename(f)).join(", "),
        workspacePaths: workspaceFolders,
        appName: vscode.env.appName,
        extensionVersion: getExtensionVersion(),
        currentSessionId,
        port: this.port,
      });
    });

    this.app.get("/sessions", async (_req, res) => {
      try {
        const sessions = await this.inProcessMessenger.externalRequest(
          "history/list",
          {},
        );
        res.json({ sessions });
      } catch (e: any) {
        res.status(500).json({ error: e?.message ?? String(e) });
      }
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
      await this.sendUserMessage(input);
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

  /**
   * A remote GUI client: a full instance of the React sidebar app running in
   * a browser/WKWebView. Frames in both directions are the exact webview
   * protocol messages; VsCodeWebviewProtocol broadcasts every outbound
   * message to all clients and each GUI filters by the messageIds it owns.
   */
  private handleGuiWsConnection(ws: WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? undefined;
    if (!this.isTokenValid(token)) {
      ws.close(4401, "Invalid or missing API token");
      return;
    }
    const requestedSessionId = url.searchParams.get("sessionId") ?? undefined;

    this.guiWsClients.add(ws);
    const disposable = this.webviewProtocol.addRemoteClient((msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });
    this.guiClientDisposables.set(ws, disposable);
    this.log("Remote GUI client connected");

    // A fresh GUI instance boots into an empty session; immediately point it
    // at the requested session, or whatever the sidebar currently shows, so
    // the phone opens with the conversation already there. Triggered by the
    // client's first protocol message (proof the React app is up), with a
    // timer as fallback.
    let focusPushed = false;
    const pushSessionFocus = async () => {
      if (focusPushed) {
        return;
      }
      focusPushed = true;
      clearTimeout(focusFallback);
      // Small grace period: the first requests fire while some webview
      // listeners (including focusContinueSessionId's) are still mounting.
      await new Promise((resolve) => setTimeout(resolve, 700));
      const sessionId =
        requestedSessionId ??
        (await Promise.race([
          this.webviewProtocol.request("getCurrentSessionId", undefined),
          new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 3000),
          ),
        ]));
      if (sessionId && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            messageType: "focusContinueSessionId",
            data: { sessionId },
            messageId: crypto.randomUUID(),
          }),
        );
        this.log(`Remote GUI focused on session ${sessionId}`);
      }
    };
    const focusFallback = setTimeout(() => void pushSessionFocus(), 3000);

    ws.on("close", () => {
      clearTimeout(focusFallback);
      this.guiWsClients.delete(ws);
      this.guiClientDisposables.get(ws)?.dispose();
      this.guiClientDisposables.delete(ws);
      this.log("Remote GUI client disconnected");
    });
    ws.on("message", async (raw) => {
      void pushSessionFocus();
      try {
        const parsed = JSON.parse(raw.toString());
        await this.webviewProtocol.handleRemoteMessage(parsed);
      } catch (e: any) {
        this.log(`Failed to handle remote GUI message: ${e?.message ?? e}`);
      }
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
          await this.sendUserMessage(parsed.input);
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
      const { done, content, status } = data ?? {};
      this.broadcast({
        type: done ? "assistant_done" : "assistant_delta",
        turnId: messageId,
        timestamp: Date.now(),
        data: { content, status },
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
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (e: any) {
        this.log(`Chat event listener threw: ${e?.message ?? e}`);
      }
    }

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
