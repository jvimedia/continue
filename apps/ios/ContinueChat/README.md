# Continue Chat (iOS)

A SwiftUI companion app that mirrors the Continue JV chat session running in
your VS Code sidebar: watch assistant responses stream live on your phone and
send messages into the same conversation.

It talks to the extension's local Chat API server
(HTTP/SSE/WebSocket, see `docs/guides/chat-streaming-api.mdx`).

## Setup in VS Code

1. Open the Continue sidebar → **Settings** → **Remote Access**.
2. Enable **Chat API Server**.
3. Enable **Allow LAN Access** (binds `0.0.0.0` so your phone can reach it)
   and keep **Bonjour Auto-Discovery** on.
4. Copy the **Token** shown there (also available via the
   `Continue JV: Show Chat API Token` command).

## Building the app

The Xcode project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```bash
brew install xcodegen
cd apps/ios/ContinueChat
xcodegen generate
open ContinueChat.xcodeproj
```

Then select your team under _Signing & Capabilities_ and run on a device or
simulator (iOS 16+). Note: the iOS Simulator cannot browse Bonjour services
from the host network in all configurations — manual entry always works.

## Connecting

- **Auto-discovery**: with the Mac and iPhone on the same network, the editor
  appears under _Discovered Servers_. Tap it, paste the token, connect.
- **Manual**: enter the host/IP (or a full URL like
  `http://192.168.1.20:65433`) and port, plus the token.

The last-used server is remembered (token in the Keychain).

## Security

The Chat API is plain HTTP on your LAN, authenticated with a bearer token.
Anyone with the token can read and write your chat session — only enable LAN
access on networks you trust, and keep the token secret.
