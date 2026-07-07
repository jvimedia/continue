import * as fs from "node:fs/promises";
import * as path from "node:path";

const HEARTBEAT_INTERVAL_MS = 10_000;
/** An owner/presence heartbeat older than this means the window is gone. */
const STALE_MS = 30_000;
/** A `/window` switch request is honored for this long, then forgotten. */
const PREFERRED_TTL_MS = 60_000;

export interface RelayWindowInfo {
  windowId: string;
  workspaceName: string;
  updatedAt: number;
}

/**
 * Telegram allows exactly one `getUpdates` consumer per bot token, but every
 * VS Code window runs its own extension host - so with the relay enabled in
 * user settings, all windows would poll the same bot and fight (409s,
 * messages landing in random windows).
 *
 * This class elects a single owner across windows using files in the
 * extension's global storage (shared by all windows of an installation):
 *
 * - `windows/<pid>.json`: presence heartbeat of every window that *wants*
 *   the relay (bot enabled + token set). Powers the bot's `/windows` list.
 * - `owner.json`: heartbeat of the current owner. Stale = owner window
 *   closed/crashed, first standby window to notice takes over.
 * - `preferred.json`: a handoff request written on `/window <n>`. The owner
 *   releases the lock when it sees it; the preferred window picks it up.
 */
export class TelegramRelayCoordinator {
  readonly windowId = String(process.pid);
  private timer?: ReturnType<typeof setInterval>;
  private owned = false;

  constructor(
    private readonly dir: string,
    private readonly workspaceName: string,
    private readonly log: (message: string) => void,
    private readonly callbacks: {
      /** This window won the election - start polling Telegram. */
      start: (announceHandoff: boolean) => Promise<void> | void;
      /** This window lost/released ownership - stop polling. */
      stop: () => void;
    },
  ) {}

  get isOwner(): boolean {
    return this.owned;
  }

  private get windowsDir() {
    return path.join(this.dir, "windows");
  }
  private get ownerFile() {
    return path.join(this.dir, "owner.json");
  }
  private get preferredFile() {
    return path.join(this.dir, "preferred.json");
  }

  async enable(): Promise<void> {
    if (this.timer) {
      return;
    }
    await fs.mkdir(this.windowsDir, { recursive: true });
    this.timer = setInterval(
      () =>
        void this.tick().catch((e) =>
          this.log(`Telegram relay election error: ${e?.message ?? e}`),
        ),
      HEARTBEAT_INTERVAL_MS,
    );
    await this.tick().catch((e) =>
      this.log(`Telegram relay election error: ${e?.message ?? e}`),
    );
  }

  async disable(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await fs
      .rm(path.join(this.windowsDir, `${this.windowId}.json`), { force: true })
      .catch(() => {});
    if (this.owned) {
      this.owned = false;
      await fs.rm(this.ownerFile, { force: true }).catch(() => {});
      this.callbacks.stop();
    }
  }

  /** Windows currently participating (fresh heartbeats), stably sorted. */
  async listWindows(): Promise<RelayWindowInfo[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.windowsDir);
    } catch {
      return [];
    }
    const windows: RelayWindowInfo[] = [];
    for (const file of files) {
      const fullPath = path.join(this.windowsDir, file);
      const info = await readJson<RelayWindowInfo>(fullPath);
      if (!info?.windowId) {
        continue;
      }
      if (Date.now() - info.updatedAt > STALE_MS) {
        await fs.rm(fullPath, { force: true }).catch(() => {});
        continue;
      }
      windows.push(info);
    }
    return windows.sort((a, b) => a.windowId.localeCompare(b.windowId));
  }

  /** Ask for ownership to move to another window (from `/window <n>`). */
  async requestSwitch(targetWindowId: string): Promise<void> {
    await fs.writeFile(
      this.preferredFile,
      JSON.stringify({ windowId: targetWindowId, at: Date.now() }),
    );
  }

  async currentOwner(): Promise<RelayWindowInfo | undefined> {
    const owner = await readJson<{ windowId: string; updatedAt: number }>(
      this.ownerFile,
    );
    if (!owner || Date.now() - owner.updatedAt > STALE_MS) {
      return undefined;
    }
    const windows = await this.listWindows();
    return windows.find((w) => w.windowId === owner.windowId);
  }

  private async tick(): Promise<void> {
    await fs.writeFile(
      path.join(this.windowsDir, `${this.windowId}.json`),
      JSON.stringify({
        windowId: this.windowId,
        workspaceName: this.workspaceName,
        updatedAt: Date.now(),
      } satisfies RelayWindowInfo),
    );

    const preferred = await readJson<{ windowId: string; at: number }>(
      this.preferredFile,
    );
    const preferredWindowId =
      preferred && Date.now() - preferred.at < PREFERRED_TTL_MS
        ? preferred.windowId
        : undefined;

    if (this.owned) {
      if (preferredWindowId && preferredWindowId !== this.windowId) {
        this.owned = false;
        await fs.rm(this.ownerFile, { force: true }).catch(() => {});
        this.callbacks.stop();
        this.log(
          `Handed the Telegram relay over to window ${preferredWindowId}`,
        );
        return;
      }
      await fs.writeFile(
        this.ownerFile,
        JSON.stringify({ windowId: this.windowId, updatedAt: Date.now() }),
      );
      return;
    }

    const owner = await readJson<{ windowId: string; updatedAt: number }>(
      this.ownerFile,
    );
    if (
      owner &&
      owner.windowId !== this.windowId &&
      Date.now() - owner.updatedAt < STALE_MS
    ) {
      return;
    }

    // Lock is free or stale. If another live window is preferred, leave the
    // takeover to it.
    if (preferredWindowId && preferredWindowId !== this.windowId) {
      const windows = await this.listWindows();
      if (windows.some((w) => w.windowId === preferredWindowId)) {
        return;
      }
    }

    await fs.writeFile(
      this.ownerFile,
      JSON.stringify({ windowId: this.windowId, updatedAt: Date.now() }),
    );
    // Cheap race guard: if another window wrote right after us, yield to
    // whatever ended up in the file.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const check = await readJson<{ windowId: string }>(this.ownerFile);
    if (check?.windowId !== this.windowId) {
      return;
    }

    this.owned = true;
    const wasHandoff = preferredWindowId === this.windowId;
    if (wasHandoff) {
      await fs.rm(this.preferredFile, { force: true }).catch(() => {});
    }
    this.log("This window now owns the Telegram relay");
    await this.callbacks.start(wasHandoff);
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}
