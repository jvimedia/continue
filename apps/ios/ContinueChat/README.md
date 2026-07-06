# Continue Chat (iOS)

A companion app that shows the **actual Continue JV sidebar GUI** on your
phone - not a re-implementation. The extension serves its real React app
over the Chat API server; this app discovers your open editors, lets you
pick a window and session, and renders that GUI in a WKWebView. Markdown
formatting, the Chat/Plan/Agent mode selector, model picker, session tabs,
and settings are all identical to VS Code because it is the same app.

## Setup in VS Code

1. Open the Continue sidebar → **Settings** → **Remote Access**.
2. Enable **Chat API Server**.
3. Enable **Allow LAN Access** (binds `0.0.0.0` so your phone can reach it)
   and keep **Bonjour Auto-Discovery** on.
4. Copy the **Token** shown there (also available via the
   `Continue JV: Show Chat API Token` command).

Every VS Code window runs its own server (ports are picked automatically if
the configured one is taken), and each advertises itself with its workspace
name - so the app's editor list shows which project each window has open.

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

## Using it

1. **Pick an editor**: windows advertising on your network appear under
   _Open Editors_ with their project name; or enter a host/IP (or full URL
   like `http://192.168.1.20:65433`) and port manually.
2. **Enter the token** (asked once per server, stored in the Keychain).
3. **Pick a session**: the list shows every session of that window, with the
   one currently open in the sidebar marked green. _Current Session_ follows
   whatever the sidebar has open.
4. The full Continue GUI loads. A turn you start on the phone streams live
   on the phone; turns started elsewhere appear when the session is
   (re)loaded - use the reload button in the toolbar to catch up.

## Security

The Chat API is plain HTTP on your LAN, authenticated with a bearer token.
Anyone with the token gets the full GUI - including your code context and
tools. Only enable LAN access on networks you trust, and keep the token
secret.
