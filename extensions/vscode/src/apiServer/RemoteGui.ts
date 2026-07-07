import * as vscode from "vscode";

import { getTheme, getThemeString } from "../util/getTheme";
import { getExtensionVersion, getvsCodeUriScheme } from "../util/util";
import { getUniqueId } from "../util/vscode";

/**
 * Renders the extension's real React GUI for a plain browser context (the
 * iOS app's WKWebView), replicating what ContinueGUIWebviewViewProvider
 * injects into the sidebar webview - with two substitutions:
 *
 * 1. `acquireVsCodeApi()` is replaced by a WebSocket bridge to `/gui-ws`,
 *    which the ChatApiServer forwards into the same VsCodeWebviewProtocol
 *    the sidebar uses. The GUI code is unmodified - it just talks to a
 *    different transport.
 * 2. VS Code normally injects `--vscode-*` CSS variables into webviews;
 *    outside VS Code we synthesize them from the active color theme (plus
 *    dark-theme fallbacks for colors the theme file doesn't define).
 */

/**
 * Fallback values (VS Code Dark Modern) for every `--vscode-*` variable the
 * GUI's stylesheets reference. Theme colors override these when defined.
 */
const DARK_FALLBACK_VARS: Record<string, string> = {
  "--vscode-editor-background": "#1f1f1f",
  "--vscode-editor-foreground": "#cccccc",
  "--vscode-editor-font-family": 'Menlo, Monaco, "Courier New", monospace',
  "--vscode-editor-font-size": "12px",
  "--vscode-editor-findMatchBackground": "#9e6a03",
  "--vscode-editor-findMatchHighlightBackground": "#ea5c0055",
  "--vscode-editorError-foreground": "#f85149",
  "--vscode-editorWarning-foreground": "#cca700",
  "--vscode-font-family":
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', sans-serif",
  "--vscode-font-size": "13px",
  "--vscode-sideBar-background": "#181818",
  "--vscode-sideBar-foreground": "#cccccc",
  "--vscode-sideBar-border": "#2b2b2b",
  "--vscode-panel-background": "#181818",
  "--vscode-panel-border": "#2b2b2b",
  "--vscode-panel-foreground": "#cccccc",
  "--vscode-input-background": "#313131",
  "--vscode-input-foreground": "#cccccc",
  "--vscode-input-border": "#3c3c3c",
  "--vscode-input-placeholderForeground": "#989898",
  "--vscode-badge-background": "#616161",
  "--vscode-badge-foreground": "#f8f8f8",
  "--vscode-button-background": "#0078d4",
  "--vscode-button-foreground": "#ffffff",
  "--vscode-button-hoverBackground": "#026ec1",
  "--vscode-button-secondaryBackground": "#313131",
  "--vscode-button-secondaryForeground": "#cccccc",
  "--vscode-button-secondaryHoverBackground": "#3c3c3c",
  "--vscode-list-activeSelectionBackground": "#04395e",
  "--vscode-list-activeSelectionForeground": "#ffffff",
  "--vscode-list-hoverBackground": "#2a2d2e",
  "--vscode-list-deemphasizedForeground": "#8c8c8c",
  "--vscode-list-errorForeground": "#f88070",
  "--vscode-list-warningForeground": "#cca700",
  "--vscode-descriptionForeground": "#9d9d9d",
  "--vscode-focusBorder": "#0078d4",
  "--vscode-commandCenter-background": "#313131",
  "--vscode-commandCenter-foreground": "#cccccc",
  "--vscode-commandCenter-activeBorder": "#454545",
  "--vscode-commandCenter-inactiveBorder": "#3c3c3c",
  "--vscode-textLink-foreground": "#4daafc",
  "--vscode-textCodeBlock-background": "#242424",
  "--vscode-tab-activeBorderTop": "#0078d4",
  "--vscode-tab-hoverBackground": "#2a2d2e",
  "--vscode-tree-tableOddRowsBackground": "rgba(204, 204, 204, 0.04)",
  "--vscode-charts-blue": "#3794ff",
  "--vscode-charts-green": "#89d185",
  "--vscode-gitDecoration-addedResourceForeground": "#81b88b",
  "--vscode-terminal-ansiGreen": "#16c60c",
  "--vscode-testing-iconPassed": "#73c991",
  "--vscode-notebookStatusRunningIcon-foreground": "#75beff",
  "--vscode-notebookStatusSuccessIcon-foreground": "#89d185",
};

function buildThemeCssVars(theme: any): string {
  const vars = { ...DARK_FALLBACK_VARS };
  const colors: Record<string, string> = theme?.colors ?? {};
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === "string") {
      vars[`--vscode-${key.replace(/\./g, "-")}`] = value;
    }
  }
  return Object.entries(vars)
    .map(([name, value]) => `${name}: ${value};`)
    .join("\n        ");
}

/**
 * The browser-side replacement for `acquireVsCodeApi()`: forwards
 * `vscode.postMessage` over a WebSocket and delivers inbound frames via
 * `window.postMessage`, which is exactly where the GUI already listens.
 */
const BRIDGE_SCRIPT = `
(function () {
  var params = new URLSearchParams(window.location.search);
  var token = params.get("token") || "";
  var sessionId = params.get("sessionId");
  var wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  // The server pushes a focusContinueSessionId for the requested session
  // (or the sidebar's current one when none is given) once the app is up.
  var wsUrl =
    wsProtocol + "//" + location.host + "/gui-ws?token=" + encodeURIComponent(token) +
    (sessionId ? "&sessionId=" + encodeURIComponent(sessionId) : "");

  var socket = null;
  var queue = [];

  function connect() {
    socket = new WebSocket(wsUrl);
    socket.onopen = function () {
      for (var i = 0; i < queue.length; i++) socket.send(queue[i]);
      queue = [];
    };
    socket.onmessage = function (event) {
      try {
        window.postMessage(JSON.parse(event.data), "*");
      } catch (e) {}
    };
    socket.onclose = function () {
      setTimeout(connect, 1000);
    };
  }
  connect();

  window.vscode = {
    postMessage: function (msg) {
      var payload = JSON.stringify(msg);
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
      else queue.push(payload);
    },
    getState: function () {
      return undefined;
    },
    setState: function () {},
  };
})();
`;

export function renderRemoteGuiHtml(): string {
  const theme = getTheme();
  const themeCssVars = buildThemeCssVars(theme);
  const workspacePaths = JSON.stringify(
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.toString()) ??
      [],
  );

  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
        <script>${BRIDGE_SCRIPT}</script>
        <link href="/gui/assets/index.css" rel="stylesheet">
        <style>
          :root {
            ${themeCssVars}
          }
          html, body {
            background-color: var(--vscode-sideBar-background);
            color: var(--vscode-sideBar-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            margin: 0;
            padding: 0;
            padding-top: env(safe-area-inset-top);
            padding-bottom: env(safe-area-inset-bottom);
          }
        </style>
        <title>Continue</title>
      </head>
      <body>
        <div id="root"></div>

        <script type="module" src="/gui/assets/index.js"></script>

        <script>localStorage.setItem("ide", '"vscode"')</script>
        <script>localStorage.setItem("vsCodeUriScheme", '"${getvsCodeUriScheme()}"')</script>
        <script>localStorage.setItem("extensionVersion", '"${getExtensionVersion()}"')</script>
        <script>window.windowId = "remote-gui-" + Math.random().toString(36).slice(2)</script>
        <script>window.vscMachineId = "${getUniqueId()}"</script>
        <script>window.vscMediaUrl = location.origin + "/gui"</script>
        <script>window.ide = "vscode"</script>
        <script>window.fullColorTheme = ${JSON.stringify(getTheme() ?? {})}</script>
        <script>window.colorThemeName = ${JSON.stringify(getThemeString())}</script>
        <script>window.workspacePaths = ${workspacePaths}</script>
        <script>window.isFullScreen = false</script>
      </body>
    </html>`;
}
