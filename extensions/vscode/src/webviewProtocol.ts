import { FromWebviewProtocol, ToWebviewProtocol } from "core/protocol";
import { Message } from "core/protocol/messenger";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";

import { IMessenger } from "../../../core/protocol/messenger";

import { handleLLMError } from "./util/errorHandling";

/**
 * Imperative messages that make a GUI *do* something (start a turn, change
 * focus, rewrite the input box). These must only reach the sidebar webview:
 * if they were broadcast, every connected remote GUI would execute them too -
 * e.g. `userInput` would start one duplicate LLM turn per connected client.
 * Pure state/notification messages (configUpdate, sessionUpdate, streaming
 * responses) are broadcast to everyone.
 */
const SIDEBAR_ONLY_MESSAGE_TYPES = new Set<string>([
  "userInput",
  "newSession",
  "newSessionWithPrompt",
  "focusContinueInput",
  "focusContinueInputWithoutClear",
  "focusContinueInputWithNewSession",
  "focusContinueSessionId",
  "highlightedCode",
  "setCodeToEdit",
  "addToChat",
  "applyCodeFromChat",
  "focusEdit",
  "exitEditMode",
  "navigateTo",
  "addModel",
  "setupApiKey",
  "setupLocalConfig",
  "openOnboardingCard",
  "incrementFtc",
  "setInactive",
]);

export class VsCodeWebviewProtocol
  implements IMessenger<FromWebviewProtocol, ToWebviewProtocol>
{
  listeners = new Map<
    keyof FromWebviewProtocol,
    ((message: Message) => any)[]
  >();

  /**
   * Optional hook invoked for every message pushed to the webview, before it
   * is posted. Used by the chat API server to mirror chat traffic (e.g.
   * `llm/streamChat` deltas) to external clients without affecting delivery
   * to the real webview.
   */
  onDidSendMessage?: (
    messageType: string,
    data: any,
    messageId: string,
  ) => void;

  /**
   * Optional hook invoked for every message received from the webview,
   * before it is dispatched to handlers. Used by the chat API server to
   * observe outgoing chat requests (e.g. the full message list sent with
   * `llm/streamChat`) without interfering with the real handler chain.
   */
  onDidReceiveWebviewMessage?: (message: Message) => void;

  /**
   * Remote GUI clients (the browser-hosted GUI served by the chat API
   * server, rendered e.g. in the iOS app). They receive every message the
   * sidebar webview receives and can send the same messages a webview can -
   * each GUI instance filters responses by the messageIds it generated, so
   * broadcasting to everyone is safe.
   */
  private remoteSinks = new Set<(msg: Message) => void>();

  /** Resolvers for in-flight `request()`s, so remote clients can answer them too. */
  private pendingResponses = new Map<string, (data: any) => void>();

  addRemoteClient(sink: (msg: Message) => void): vscode.Disposable {
    this.remoteSinks.add(sink);
    return new vscode.Disposable(() => this.remoteSinks.delete(sink));
  }

  send(messageType: string, data: any, messageId?: string): string {
    const id = messageId ?? uuidv4();
    this.onDidSendMessage?.(messageType, data, id);
    const msg: Message = { messageType, data, messageId: id };
    this.webview?.postMessage(msg);
    if (!SIDEBAR_ONLY_MESSAGE_TYPES.has(messageType)) {
      for (const sink of this.remoteSinks) {
        try {
          sink(msg);
        } catch {
          // A broken remote client must never break sidebar delivery
        }
      }
    }
    return id;
  }

  /**
   * Entry point for messages arriving from a remote GUI client. Mirrors what
   * `set webview` does for the real webview: responses to in-flight
   * extension-side `request()`s resolve those, everything else is dispatched
   * to the normal handler chain (responses are broadcast back via `send`).
   */
  async handleRemoteMessage(msg: Message): Promise<void> {
    const pending = this.pendingResponses.get(msg.messageId);
    if (pending) {
      this.pendingResponses.delete(msg.messageId);
      pending(msg.data);
      return;
    }
    await this.handleWebviewMessage(msg);
  }

  on<T extends keyof FromWebviewProtocol>(
    messageType: T,
    handler: (
      message: Message<FromWebviewProtocol[T][0]>,
    ) => Promise<FromWebviewProtocol[T][1]> | FromWebviewProtocol[T][1],
  ): void {
    if (!this.listeners.has(messageType)) {
      this.listeners.set(messageType, []);
    }
    this.listeners.get(messageType)?.push(handler);
  }

  _webview?: vscode.Webview;
  _webviewListener?: vscode.Disposable;

  get webview(): vscode.Webview | undefined {
    return this._webview;
  }

  set webview(webView: vscode.Webview) {
    this._webview = webView;
    this._webviewListener?.dispose();

    this._webviewListener = this._webview.onDidReceiveMessage((msg) =>
      this.handleWebviewMessage(msg),
    );
  }

  private async handleWebviewMessage(msg: Message): Promise<void> {
    if (!("messageType" in msg) || !("messageId" in msg)) {
      throw new Error(`Invalid webview protocol msg: ${JSON.stringify(msg)}`);
    }

    const respond = (message: any) =>
      this.send(msg.messageType, message, msg.messageId);

    this.onDidReceiveWebviewMessage?.(msg);

    const handlers =
      this.listeners.get(msg.messageType as keyof FromWebviewProtocol) || [];
    for (const handler of handlers) {
      try {
        const response = await handler(msg);
        // For generator types e.g. llm/streamChat
        if (response && typeof response[Symbol.asyncIterator] === "function") {
          let next = await response.next();
          while (!next.done) {
            respond({
              done: false,
              content: next.value,
              status: "success",
            });
            next = await response.next();
          }
          respond({
            done: true,
            content: next.value,
            status: "success",
          });
        } else {
          respond({ done: true, content: response, status: "success" });
        }
      } catch (e: any) {
        if (await handleLLMError(e)) {
          // Respond without an error, so the UI doesn't show the error component
          respond({ done: true, status: "error" });
        }
        let message = e.message;
        respond({ done: true, error: message, status: "error" });

        const stringified = JSON.stringify({ msg }, null, 2);
        console.error(`Error handling webview message: ${stringified}\n\n${e}`);

        if (
          stringified.includes("llm/streamChat") ||
          stringified.includes("chatDescriber/describe")
        ) {
          return;
        }

        if (e.cause) {
          if (e.cause.name === "ConnectTimeoutError") {
            message = `Connection timed out. If you expect it to take a long time to connect, you can increase the timeout in your config by setting "requestOptions": { "timeout": 10000 }. You can find the full config reference here: https://docs.continue.dev/reference/config`;
          } else if (e.cause.code === "ECONNREFUSED") {
            message = `Connection was refused. This likely means that there is no server running at the specified URL. If you are running your own server you may need to set the "apiBase" parameter in config.json. For example, you can set up an OpenAI-compatible server like here: https://docs.continue.dev/reference/Model%20Providers/openai#openai-compatible-servers--apis`;
          } else {
            message = `The request failed with "${e.cause.name}": ${e.cause.message}. If you're having trouble setting up Continue, please see the troubleshooting guide for help.`;
          }
        }
      }
    }
  }

  constructor() {}

  invoke<T extends keyof FromWebviewProtocol>(
    messageType: T,
    data: FromWebviewProtocol[T][0],
    messageId?: string,
  ): FromWebviewProtocol[T][1] {
    throw new Error("Method not implemented.");
  }

  onError(handler: (message: Message, error: Error) => void): void {
    throw new Error("Method not implemented.");
  }

  public request<T extends keyof ToWebviewProtocol>(
    messageType: T,
    data: ToWebviewProtocol[T][0],
    retry: boolean = true,
  ): Promise<ToWebviewProtocol[T][1]> {
    const messageId = uuidv4();
    return new Promise(async (resolve) => {
      if (retry) {
        let i = 0;
        while (!this.webview) {
          if (i >= 10) {
            resolve(undefined);
            return;
          } else {
            await new Promise((res) => setTimeout(res, i >= 5 ? 1000 : 500));
            i++;
          }
        }
      }

      // Whichever client answers first wins: the sidebar webview via the
      // listener below, or a remote GUI client via handleRemoteMessage.
      // Many messages sent via request() are fire-and-forget notifications
      // that never get a response, so expire the entry to keep the map small.
      const expiry = setTimeout(
        () => this.pendingResponses.delete(messageId),
        10 * 60 * 1000,
      );
      const settle = (data: ToWebviewProtocol[T][1]) => {
        clearTimeout(expiry);
        this.pendingResponses.delete(messageId);
        resolve(data);
      };
      this.pendingResponses.set(messageId, settle);

      this.send(messageType, data, messageId);

      if (this.webview) {
        const disposable = this.webview.onDidReceiveMessage(
          (msg: Message<ToWebviewProtocol[T][1]>) => {
            if (msg.messageId === messageId) {
              settle(msg.data);
              disposable?.dispose();
            }
          },
        );
      } else if (!retry && this.remoteSinks.size === 0) {
        this.pendingResponses.delete(messageId);
        resolve(undefined);
      }
    });
  }
}
