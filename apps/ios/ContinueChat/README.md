# Continue Chat (iOS)

A minimal SwiftUI reference client for Continue's [Chat Streaming API](../../../docs/guides/chat-streaming-api.mdx). It connects to a Continue VS Code extension instance over HTTP/SSE, mirrors the live chat sidebar, and lets you send messages into it from your phone.

This is a reference implementation, not a production app: no message persistence beyond what `/session` returns on load, no offline queueing, no push notifications.

## Requirements

- Xcode 15 or later
- iOS 16.0+ Simulator or device
- A Mac running VS Code with the Continue extension and its Chat API enabled (see the main repo's `docs/guides/chat-streaming-api.mdx`)

## Setup

1. Open `ContinueChat.xcodeproj` in Xcode.
2. Select the `ContinueChat` target, go to **Signing & Capabilities**, and choose your own Development Team (the project ships with automatic code signing but no team assigned — Xcode will prompt for this on first run since it isn't something that can be encoded in a shared project file).
3. Build and run on a Simulator (use `http://127.0.0.1:<port>` or `http://localhost:<port>` as the server URL — Simulator shares the Mac's network namespace) or a physical device on the same network as your Mac (use the Mac's LAN IP and set `continue.chatApi.host` to `0.0.0.0` in VS Code).
4. On first launch, enter:
   - **Server URL** — e.g. `http://127.0.0.1:65432` (default port), shown in the VS Code notification when the Chat API server starts.
   - **API Token** — from VS Code's **Continue: Show Chat API Token** command.
5. Tap **Test Connection** to verify (`GET /health` then `GET /session`), then **Save**.

## What it does

- Loads the current chat session's history via `GET /session` on launch.
- Opens `GET /events` (Server-Sent Events) and keeps it open for the life of the chat screen, auto-reconnecting a couple of seconds after any drop. A colored dot in the top-left shows connection status (green = live, amber = connecting, red = disconnected).
- Renders the timeline as a linear, full-width scrolling list (matching `gui/src/`'s document-like layout, not classic chat bubbles): plain text for assistant replies, a boxed input-style block for user turns.
- Sends new messages via `POST /message`; the message you typed is cleared immediately and reappears in the timeline once it comes back as a `user_message` SSE event (this is the API's actual behavior — it does not echo synchronously).
- Groups `assistant_delta` / `assistant_done` events by `turnId`, concatenating delta text live and finalizing on `assistant_done`.
- The gear icon reopens the server URL/token screen at any time.

## Project layout

```
ContinueChat/
  ContinueChatApp.swift        App entry point (@main)
  ContentView.swift            Chooses Settings (onboarding) vs. ChatView based on saved config
  Views/
    ChatView.swift             Message list + input bar + ChatViewModel (SSE-driven state)
    MessageRowView.swift       Single timeline row
    SettingsView.swift         Server URL / token entry + Test Connection
  Models/
    ChatModels.swift           Codable types matching the API's JSON shapes
  Networking/
    ContinueAPIClient.swift    URLSession client: fetchSession(), sendMessage(), hand-rolled SSE reader, Keychain-backed AppSettings
  Theme/
    Theme.swift                Light/dark color palette mirroring gui/src/styles/theme.ts
```

## Notes

- The API token is stored in the iOS Keychain; the server URL is stored in `UserDefaults` (not sensitive).
- SSE parsing is hand-written (splitting `URLSession.bytes(for:)`'s line stream on `data:` prefixes and blank-line event boundaries) — no third-party dependencies.
- Not implemented (out of scope for a reference client): WebSocket transport (`/ws`), multi-session switching, rich content parts (images/tool calls) in messages — non-string `content` renders as `[unsupported content]`.
