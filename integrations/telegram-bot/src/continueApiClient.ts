import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

/**
 * Mirrors `ChatStreamEvent` from
 * extensions/vscode/src/apiServer/ChatApiServer.ts.
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

export interface SessionSnapshot {
  sessionId: string | undefined;
  session: unknown;
}

/**
 * Thin client for the Continue Chat Streaming API
 * (docs/guides/chat-streaming-api.mdx). Implemented with Node's built-in
 * http/https modules only, so the bot doesn't need extra runtime
 * dependencies (fetch/undici/eventsource) to talk to it.
 */
export class ContinueApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(path, this.baseUrl);
      } catch (e) {
        reject(e);
        return;
      }
      const lib = url.protocol === "https:" ? https : http;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;

      const req = lib.request(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(payload
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload).toString(),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(
                new Error(
                  `Continue API ${method} ${path} failed with ${status}: ${text || res.statusMessage}`,
                ),
              );
              return;
            }
            if (text.length === 0) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (e) {
              reject(
                new Error(
                  `Continue API ${method} ${path} returned invalid JSON: ${(e as Error).message}`,
                ),
              );
            }
          });
        },
      );

      req.on("error", reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.requestJson<{ ok: boolean }>("GET", "/health");
      return res?.ok === true;
    } catch {
      return false;
    }
  }

  getSession(): Promise<SessionSnapshot> {
    return this.requestJson<SessionSnapshot>("GET", "/session");
  }

  postMessage(input: string): Promise<{ ok: boolean }> {
    return this.requestJson<{ ok: boolean }>("POST", "/message", { input });
  }

  /**
   * Opens a long-lived `GET /events` SSE connection and invokes `onEvent`
   * for every parsed event. The returned promise settles once the
   * connection ends - normally (server closed it), because of a transport
   * error, or because `signal` was aborted - so the caller is responsible
   * for reconnecting (see eventStream.ts).
   */
  openEventStream(
    onEvent: (event: ChatStreamEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL("/events", this.baseUrl);
      } catch (e) {
        reject(e);
        return;
      }
      url.searchParams.set("token", this.token);
      const lib = url.protocol === "https:" ? https : http;

      const req = lib.request(
        url,
        { method: "GET", headers: { Accept: "text/event-stream" } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status !== 200) {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              reject(
                new Error(
                  `GET /events failed with ${status}: ${Buffer.concat(chunks).toString("utf8")}`,
                ),
              );
            });
            res.resume();
            return;
          }

          res.setEncoding("utf8");
          let buffer = "";

          res.on("data", (chunk: string) => {
            buffer += chunk;
            let sepIndex: number;
            // SSE frames are separated by a blank line ("\n\n").
            while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
              const rawFrame = buffer.slice(0, sepIndex);
              buffer = buffer.slice(sepIndex + 2);
              this.parseSseFrame(rawFrame, onEvent);
            }
          });

          res.on("end", () => resolve());
          res.on("error", (e) => reject(e));
        },
      );

      req.on("error", reject);

      if (signal.aborted) {
        req.destroy(new Error("aborted"));
      } else {
        const onAbort = () => req.destroy(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }

      req.end();
    });
  }

  private parseSseFrame(
    rawFrame: string,
    onEvent: (event: ChatStreamEvent) => void,
  ): void {
    const dataLines = rawFrame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length === 0) {
      // Comment/keepalive line (e.g. ": connected") - nothing to parse.
      return;
    }
    const payload = dataLines.join("\n");
    try {
      onEvent(JSON.parse(payload) as ChatStreamEvent);
    } catch {
      // Malformed event - drop it but keep the stream alive.
    }
  }
}
