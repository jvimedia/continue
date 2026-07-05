# Continue Telegram Bot

A small Telegram bot that bridges a Telegram chat to the Continue VS Code
extension's [Chat Streaming API](../../docs/guides/chat-streaming-api.mdx).
It lets you talk to the chat session running in your VS Code sidebar from
Telegram: messages you send in Telegram are forwarded into Continue, and the
assistant's reply streams back into the same Telegram chat.

This is a reference implementation - a small, self-contained Node/TypeScript
project. It is not part of the pnpm/monorepo workspace and is installed and
run independently.

## What it does

- Long-polls Telegram for new messages (no public webhook/HTTPS endpoint or
  open inbound port required).
- Forwards text messages from an allowed Telegram chat to `POST /message` on
  the Continue Chat API.
- Subscribes to `GET /events` (Server-Sent Events) and relays the assistant's
  reply back into the same Telegram chat, editing a single "in progress"
  message roughly every 1.5 seconds as text streams in, then finalizing it
  when the turn completes.
- Restricts usage to an allowlist of Telegram chat IDs; messages from any
  other chat are silently ignored (and logged server-side).
- Reconnects the event stream automatically (with exponential backoff) if it
  drops or the Continue API is temporarily unreachable, without crashing.

## Prerequisites

1. **VS Code with Continue and the Chat API enabled.** In VS Code settings,
   set:

   - `continue.chatApi.enabled`: `true`
   - `continue.chatApi.port` (optional, default `65432`)
   - `continue.chatApi.host` (optional, default `127.0.0.1` - if the bot
     runs on a different machine than VS Code, see "Running against a
     remote VS Code" below)

   Reload the VS Code window. A notification appears with the server URL and
   a **Copy Token** button. You can retrieve the token again later via the
   **Continue: Show Chat API Token** command. Full details:
   [`docs/guides/chat-streaming-api.mdx`](../../docs/guides/chat-streaming-api.mdx).

2. **A Telegram bot token from [@BotFather](https://t.me/BotFather).**

   - Open a chat with `@BotFather` in Telegram.
   - Send `/newbot` and follow the prompts (choose a name and a username
     ending in `bot`).
   - BotFather replies with an API token that looks like
     `123456789:AAF...`. This is your `TELEGRAM_BOT_TOKEN`.

3. **Your Telegram chat ID.**
   - Easiest: message [`@userinfobot`](https://t.me/userinfobot) (or
     `@getidsbot`) - it replies with your numeric chat ID.
   - Alternatively, send a message to your new bot, then call
     `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates` in a
     browser or with `curl` and read `message.chat.id` from the JSON
     response.
   - For a group chat, add the bot to the group and use the group's
     (negative) chat ID instead.

## Install

```bash
cd integrations/telegram-bot
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:AAF...          # from @BotFather
CONTINUE_API_URL=http://127.0.0.1:65432      # default; change if you customized host/port
CONTINUE_API_TOKEN=...                        # from "Continue: Show Chat API Token"
ALLOWED_TELEGRAM_CHAT_IDS=111111111           # your chat ID; comma-separate for more than one
```

## Run

Build once and run the compiled output:

```bash
npm run build
npm start
```

Or run directly from TypeScript source during development (via `tsx`, no
build step):

```bash
npm run dev
```

Either way, once the process logs that it's connected, send your bot a
message in Telegram.

## Commands

- `/start` - usage help.
- `/session` - fetches `GET /session` and prints a short summary (title and
  the last few messages) of the currently active Continue session.
- `/reset` - **not supported**. The Chat API doesn't currently expose an
  endpoint to start a new session or clear history remotely, so this command
  just explains that and points you at starting a new chat from the Continue
  sidebar in VS Code instead. (We didn't want to fake a "reset" that doesn't
  actually do anything.)

Any other text message is forwarded to Continue as-is.

## Running against a remote VS Code instance

If the bot doesn't run on the same machine as VS Code, set
`continue.chatApi.host` to `0.0.0.0` in VS Code and point
`CONTINUE_API_URL` at that machine's LAN IP (or, better, tunnel the port
over SSH/Tailscale rather than exposing it directly - see the
[Troubleshooting section of the API docs](../../docs/guides/chat-streaming-api.mdx#troubleshooting)).
The Chat API token grants full read/write access to your chat session, so
treat it like a secret.

## Known limitations

- **Single conversation, allowlisted chats only.** This bot is designed for
  one person (or a small trusted group) talking to one Continue instance,
  not multi-tenant use. All allowlisted chat IDs share the same underlying
  Continue session and will all see the same conversation.
- **No true token-by-token streaming.** Telegram's `editMessageText` API
  rate-limits frequent edits to the same message, so replies are relayed by
  editing a single "in progress" message roughly every 1.5 seconds as text
  accumulates, rather than a smooth per-token stream. Very long replies
  (over Telegram's 4096-character message limit) are split across multiple
  messages when finalized.
- **No remote session reset.** See `/reset` above - the underlying API
  doesn't support it yet.
- **No attribution for sidebar-originated turns.** If someone types directly
  into the Continue sidebar in VS Code (rather than through this bot), the
  resulting reply is broadcast to every allowlisted chat, since the API
  doesn't say which client (if any) should "own" that turn.
- **Best-effort error handling.** Network hiccups to the Continue API are
  retried with backoff and logged; Telegram API errors when sending/editing
  messages are logged and skipped rather than retried indefinitely.
