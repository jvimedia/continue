import { ChatStreamEvent, ContinueApiClient } from "./continueApiClient";
import { logger } from "./logger";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
// Consider a connection "healthy" (and reset backoff) if it stayed up at
// least this long before dropping.
const HEALTHY_CONNECTION_MS = 10_000;

/**
 * Keeps a `GET /events` SSE connection alive against the Continue Chat API,
 * automatically reconnecting with exponential backoff if it drops or the
 * server is temporarily unreachable. Runs until `stop()` is called.
 */
export class EventStreamManager {
  private stopped = false;
  private abortController: AbortController | undefined;
  private backoffMs = INITIAL_BACKOFF_MS;
  private runPromise: Promise<void> | undefined;

  constructor(
    private readonly client: ContinueApiClient,
    private readonly onEvent: (event: ChatStreamEvent) => void,
    private readonly onConnectionChange?: (connected: boolean) => void,
  ) {}

  start(): void {
    if (this.runPromise) {
      return;
    }
    this.stopped = false;
    this.runPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    await this.runPromise;
    this.runPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const startedAt = Date.now();
      this.abortController = new AbortController();
      try {
        logger.info("Connecting to Continue Chat API event stream...");
        this.onConnectionChange?.(true);
        await this.client.openEventStream(
          this.onEvent,
          this.abortController.signal,
        );
        if (!this.stopped) {
          logger.warn("Event stream closed by server, reconnecting...");
        }
      } catch (e) {
        if (this.stopped) {
          break;
        }
        logger.error(
          `Event stream error: ${(e as Error).message}. Reconnecting...`,
        );
      } finally {
        this.onConnectionChange?.(false);
      }

      if (this.stopped) {
        break;
      }

      const connectedFor = Date.now() - startedAt;
      if (connectedFor >= HEALTHY_CONNECTION_MS) {
        this.backoffMs = INITIAL_BACKOFF_MS;
      } else {
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }

      logger.info(`Waiting ${this.backoffMs}ms before reconnecting...`);
      await sleep(this.backoffMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
