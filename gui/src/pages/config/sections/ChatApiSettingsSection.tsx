import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";
import { ChatApiSettingsUpdate, ChatApiStatus } from "core/protocol/ideWebview";
import { useContext, useEffect, useRef, useState } from "react";
import { Card } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ConfigHeader } from "../components/ConfigHeader";
import { UserSetting } from "../components/UserSetting";

function CopyableValue({ label, value }: { label: string; value: string }) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-2 overflow-hidden">
      <span className="text-xs text-gray-500">{label}</span>
      <code className="truncate text-xs">{value}</code>
      <div
        className="cursor-pointer"
        onClick={() => {
          ideMessenger.post("copyText", { text: value });
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? (
          <span className="text-xs text-green-500">Copied</span>
        ) : (
          <ClipboardDocumentIcon className="h-3.5 w-3.5 hover:opacity-80" />
        )}
      </div>
    </div>
  );
}

/**
 * Settings for the local Chat API server (used by the iOS app), Bonjour
 * auto-discovery, and the Telegram bot relay. VS Code only - these settings
 * live in VS Code configuration, not in Continue's shared config.
 */
export function ChatApiSettingsSection() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [status, setStatus] = useState<ChatApiStatus | null>(null);
  const [formPort, setFormPort] = useState<number | null>(null);
  const [formChatIds, setFormChatIds] = useState<string | null>(null);
  const [formBotToken, setFormBotToken] = useState("");
  const refreshTimeout = useRef<ReturnType<typeof setTimeout>>();
  const portDebounce = useRef<ReturnType<typeof setTimeout>>();

  async function refresh() {
    const result = await ideMessenger.request("chatApi/getStatus", undefined);
    if (result.status === "success") {
      setStatus(result.content);
    }
  }

  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 5000);
    return () => {
      clearInterval(interval);
      if (refreshTimeout.current) {
        clearTimeout(refreshTimeout.current);
      }
    };
  }, []);

  async function update(settingsUpdate: ChatApiSettingsUpdate) {
    await ideMessenger.request("chatApi/updateSettings", settingsUpdate);
    // The server restarts asynchronously after the config change; refresh
    // once now and once after it has had time to come up.
    void refresh();
    refreshTimeout.current = setTimeout(() => void refresh(), 1000);
  }

  if (!status) {
    return null;
  }

  const lanAccess = status.host === "0.0.0.0" || status.host === "::";
  const port = formPort ?? status.port;
  const chatIds = formChatIds ?? status.telegram.allowedChatIds;
  const telegram = status.telegram;

  const telegramStatusText = !telegram.enabled
    ? undefined
    : telegram.status === "running"
      ? `Connected${telegram.botUsername ? ` as @${telegram.botUsername}` : ""}`
      : telegram.status === "standby"
        ? `Standby — ${telegram.ownerWorkspace ? `"${telegram.ownerWorkspace}"` : "another window"} owns the bot (switch with /window in Telegram)`
        : telegram.status === "error"
          ? (telegram.error ?? "Error")
          : !telegram.botTokenSet
            ? "Waiting for a bot token"
            : "Starting…";

  return (
    <div>
      <ConfigHeader title="Remote Access" variant="sm" />
      <Card>
        <div className="flex flex-col gap-4">
          <UserSetting
            type="toggle"
            title="Enable Chat API Server"
            description="Expose the current chat session over a local HTTP/SSE/WebSocket API so external clients like the Continue JV iOS app can stream and send messages."
            value={status.enabled}
            onChange={(value) => update({ enabled: value })}
          />
          <UserSetting
            type="number"
            title="Port"
            description="Port the Chat API server listens on."
            value={port}
            min={1024}
            max={65535}
            onChange={(value) => {
              setFormPort(value);
              // Debounce so intermediate values while typing don't restart
              // the server on a wrong port.
              if (portDebounce.current) {
                clearTimeout(portDebounce.current);
              }
              portDebounce.current = setTimeout(() => {
                if (value >= 1024 && value <= 65535) {
                  void update({ port: value });
                }
              }, 800);
            }}
          />
          <UserSetting
            type="toggle"
            title="Allow LAN Access"
            description="Bind to 0.0.0.0 so other devices on your network (e.g. your iPhone) can connect. Anyone with the API token can read and write your chat - keep it secret."
            value={lanAccess}
            onChange={(value) => update({ lanAccess: value })}
          />
          <UserSetting
            type="toggle"
            title="Bonjour Auto-Discovery"
            description="Advertise the server on the local network (_continuejv._tcp) so the iOS app can find it without typing an address. Requires LAN access."
            value={status.mdnsEnabled}
            disabled={!lanAccess}
            onChange={(value) => update({ mdnsEnabled: value })}
          />
          {status.enabled && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {status.running ? "Server running" : "Server not running"}
              </span>
              {status.running &&
                status.urls.map((url) => (
                  <CopyableValue key={url} label="URL" value={url} />
                ))}
              <CopyableValue label="Token" value={status.token} />
            </div>
          )}
        </div>
      </Card>

      <div className="mt-4" />
      <ConfigHeader title="Telegram Bot" variant="sm" />
      <Card>
        <div className="flex flex-col gap-4">
          <UserSetting
            type="toggle"
            title="Enable Telegram Relay"
            description="Chat with the Continue session from Telegram: messages to your bot appear in the sidebar chat and assistant replies are sent back. Create a bot with @BotFather to get a token."
            value={telegram.enabled}
            onChange={(value) => update({ telegramEnabled: value })}
          />
          <UserSetting
            type="input"
            title={`Bot Token${telegram.botTokenSet ? " (set)" : ""}`}
            description={
              telegram.botTokenSet
                ? "A bot token is stored securely. Paste a new one to replace it, or save an empty value to clear it."
                : "Paste the token from @BotFather. It is stored in VS Code's secret storage, never in settings files."
            }
            placeholder="123456789:AAF..."
            value={formBotToken}
            onChange={setFormBotToken}
            onSubmit={() => {
              void ideMessenger
                .request("chatApi/setTelegramBotToken", {
                  botToken: formBotToken,
                })
                .then(() => {
                  setFormBotToken("");
                  void refresh();
                  refreshTimeout.current = setTimeout(
                    () => void refresh(),
                    1500,
                  );
                });
            }}
            onCancel={() => setFormBotToken("")}
            isDirty={formBotToken.length > 0}
            isValid={true}
          />
          <UserSetting
            type="input"
            title="Allowed Chat IDs"
            description="Comma-separated Telegram chat IDs allowed to use the bot. Message your bot once and it replies with your chat ID."
            placeholder="123456789, -987654321"
            value={chatIds}
            onChange={setFormChatIds}
            onSubmit={() => {
              void update({ telegramAllowedChatIds: chatIds.trim() });
              setFormChatIds(null);
            }}
            onCancel={() => setFormChatIds(null)}
            isDirty={
              formChatIds !== null &&
              formChatIds !== status.telegram.allowedChatIds
            }
            isValid={true}
          />
          {telegramStatusText && (
            <div className="flex flex-col">
              <span className="text-sm font-medium">Status</span>
              <span
                className={`mt-0.5 text-xs ${
                  telegram.status === "error"
                    ? "text-red-500"
                    : telegram.status === "running"
                      ? "text-green-500"
                      : "text-gray-500"
                }`}
              >
                {telegramStatusText}
              </span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
