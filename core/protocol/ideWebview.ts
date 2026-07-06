import { ToIdeFromWebviewOrCoreProtocol } from "./ide";
import { ToWebviewFromIdeOrCoreProtocol } from "./webview";

import {
  AcceptOrRejectDiffPayload,
  AddToChatPayload,
  ApplyState,
  ApplyToFilePayload,
  HighlightedCodePayload,
  MessageContent,
  RangeInFileWithContents,
  SetCodeToEditPayload,
  ShowFilePayload,
} from "../";

export interface ChatApiTelegramStatus {
  enabled: boolean;
  botTokenSet: boolean;
  botUsername?: string;
  allowedChatIds: string;
  status: "stopped" | "starting" | "running" | "error";
  error?: string;
}

export interface ChatApiStatus {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  token: string;
  mdnsEnabled: boolean;
  /** URLs the server is reachable at, including LAN IPs when bound to 0.0.0.0 */
  urls: string[];
  telegram: ChatApiTelegramStatus;
}

export interface ChatApiSettingsUpdate {
  enabled?: boolean;
  port?: number;
  /** true = bind 0.0.0.0 (LAN access), false = bind 127.0.0.1 */
  lanAccess?: boolean;
  mdnsEnabled?: boolean;
  telegramEnabled?: boolean;
  telegramAllowedChatIds?: string;
}

export type ToIdeFromWebviewProtocol = ToIdeFromWebviewOrCoreProtocol & {
  openUrl: [string, void];
  applyToFile: [ApplyToFilePayload, void];
  overwriteFile: [{ filepath: string; prevFileContent: string | null }, void];
  showTutorial: [undefined, void];
  showFile: [ShowFilePayload, void];
  toggleDevTools: [undefined, void];
  reloadWindow: [undefined, void];
  focusEditor: [undefined, void];
  toggleFullScreen: [{ newWindow?: boolean } | undefined, void];
  insertAtCursor: [{ text: string }, void];
  copyText: [{ text: string }, void];
  "jetbrains/isOSREnabled": [undefined, boolean];
  "jetbrains/onLoad": [
    undefined,
    {
      windowId: string;
      serverUrl: string;
      workspacePaths: string[];
      vscMachineId: string;
      vscMediaUrl: string;
    },
  ];
  "jetbrains/getColors": [undefined, Record<string, string | null | undefined>];
  "vscode/openMoveRightMarkdown": [undefined, void];
  acceptDiff: [AcceptOrRejectDiffPayload, void];
  rejectDiff: [AcceptOrRejectDiffPayload, void];
  "edit/sendPrompt": [
    {
      prompt: MessageContent;
      range: RangeInFileWithContents;
    },
    string | undefined,
  ];
  "edit/addCurrentSelection": [undefined, void];
  "edit/clearDecorations": [undefined, void];
  "session/share": [{ sessionId: string }, void];
  "chatApi/getStatus": [undefined, ChatApiStatus];
  "chatApi/updateSettings": [ChatApiSettingsUpdate, void];
  "chatApi/setTelegramBotToken": [{ botToken: string }, void];
};

export type ToWebviewFromIdeProtocol = ToWebviewFromIdeOrCoreProtocol & {
  setInactive: [undefined, void];
  newSessionWithPrompt: [{ prompt: string }, void];
  userInput: [{ input: string }, void];
  focusContinueInput: [undefined, void];
  focusContinueInputWithoutClear: [undefined, void];
  focusContinueInputWithNewSession: [undefined, void];
  highlightedCode: [HighlightedCodePayload, void];
  setCodeToEdit: [SetCodeToEditPayload, void];
  navigateTo: [{ path: string; toggle?: boolean }, void];
  addModel: [undefined, void];

  focusContinueSessionId: [{ sessionId: string | undefined }, void];
  newSession: [undefined, void];
  setTheme: [{ theme: any }, void];
  setColors: [{ [key: string]: string }, void];
  "jetbrains/editorInsetRefresh": [undefined, void];
  "jetbrains/isOSREnabled": [boolean, void];
  setupApiKey: [undefined, void];
  setupLocalConfig: [undefined, void];
  incrementFtc: [undefined, void];
  openOnboardingCard: [undefined, void];
  applyCodeFromChat: [undefined, void];
  updateApplyState: [ApplyState, void];
  exitEditMode: [undefined, void];
  focusEdit: [undefined, void];
  addToChat: [AddToChatPayload, void];
};
