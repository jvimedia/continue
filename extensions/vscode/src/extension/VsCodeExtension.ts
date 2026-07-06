import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { IContextProvider } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { EXTENSION_NAME } from "core/util/constants";
import { Core } from "core/core";
import { FromCoreProtocol, ToCoreProtocol } from "core/protocol";
import { ChatApiSettingsUpdate, ChatApiStatus } from "core/protocol/ideWebview";
import { InProcessMessenger } from "core/protocol/messenger";
import {
  getConfigJsonPath,
  getConfigTsPath,
  getConfigYamlPath,
  getContinueGlobalPath,
} from "core/util/paths";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";

import { ContinueCompletionProvider } from "../autocomplete/completionProvider";
import {
  monitorBatteryChanges,
  setupStatusBar,
  StatusBarStatus,
} from "../autocomplete/statusBar";
import { registerAllCommands } from "../commands";
import { ContinueConsoleWebviewViewProvider } from "../ContinueConsoleWebviewViewProvider";
import { ContinueGUIWebviewViewProvider } from "../ContinueGUIWebviewViewProvider";
import { VerticalDiffManager } from "../diff/vertical/manager";
import { registerAllCodeLensProviders } from "../lang-server/codeLens";
import { registerAllPromptFilesCompletionProviders } from "../lang-server/promptFileCompletions";
import EditDecorationManager from "../quickEdit/EditDecorationManager";
import { QuickEdit } from "../quickEdit/QuickEditQuickPick";
import { UriEventHandler } from "../stubs/uriHandler";
import { Battery } from "../util/battery";
import { FileSearch } from "../util/FileSearch";
import { VsCodeIdeUtils } from "../util/ideUtils";
import { VsCodeIde } from "../VsCodeIde";

import { ChatApiServer } from "../apiServer/ChatApiServer";
import { MdnsAdvertiser } from "../apiServer/MdnsAdvertiser";
import { TelegramBotRelay } from "../apiServer/TelegramBotRelay";

import { ConfigYamlDocumentLinkProvider } from "./ConfigYamlDocumentLinkProvider";
import { VsCodeMessenger } from "./VsCodeMessenger";

import { modelSupportsNextEdit } from "core/llm/autodetect";
import { NEXT_EDIT_MODELS } from "core/llm/constants";
import { NextEditProvider } from "core/nextEdit/NextEditProvider";
import { isNextEditTest } from "core/nextEdit/utils";
import { JumpManager } from "../activation/JumpManager";
import setupNextEditWindowManager, {
  NextEditWindowManager,
} from "../activation/NextEditWindowManager";
import {
  HandlerPriority,
  SelectionChangeManager,
} from "../activation/SelectionChangeManager";
import { GhostTextAcceptanceTracker } from "../autocomplete/GhostTextAcceptanceTracker";
import { getDefinitionsFromLsp } from "../autocomplete/lsp";
import {
  clearDocumentContentCache,
  handleTextDocumentChange,
  initDocumentContentCache,
} from "../util/editLoggingUtils";
import type { VsCodeWebviewProtocol } from "../webviewProtocol";

export class VsCodeExtension {
  // Currently some of these are public so they can be used in testing (test/test-suites)

  private configHandler: ConfigHandler;
  private extensionContext: vscode.ExtensionContext;
  private ide: VsCodeIde;
  private ideUtils: VsCodeIdeUtils;
  private consoleView: ContinueConsoleWebviewViewProvider;
  private sidebar: ContinueGUIWebviewViewProvider;
  private windowId: string;
  private editDecorationManager: EditDecorationManager;
  private verticalDiffManager: VerticalDiffManager;
  webviewProtocolPromise: Promise<VsCodeWebviewProtocol>;
  private core: Core;
  private battery: Battery;
  private fileSearch: FileSearch;
  private uriHandler = new UriEventHandler();
  private completionProvider: ContinueCompletionProvider;
  private chatApiServer?: ChatApiServer;
  private chatApiMdns?: MdnsAdvertiser;
  private telegramRelay?: TelegramBotRelay;

  private ARBITRARY_TYPING_DELAY = 2000;

  /**
   * This is how you turn next edit on or off at the extension level.
   * This is called on config reload and autocomplete menu updates.
   * This is also the place you want to check to enable/disable next edit during e2e tests,
   * because it tends to stain other e2e tests and make them fail.
   */
  private async updateNextEditState(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    const { config: continueConfig } = await this.configHandler.loadConfig();
    const autocompleteModel = continueConfig?.selectedModelByRole.autocomplete;
    const vscodeConfig = vscode.workspace.getConfiguration(EXTENSION_NAME);

    const modelSupportsNext =
      autocompleteModel &&
      modelSupportsNextEdit(
        autocompleteModel.capabilities,
        autocompleteModel.model,
        autocompleteModel.title,
      );

    // Use smart defaults.
    let nextEditEnabled = vscodeConfig.get<boolean>("enableNextEdit");
    if (nextEditEnabled === undefined) {
      // First time - set smart default.
      nextEditEnabled = modelSupportsNext ?? false;
      await vscodeConfig.update(
        "enableNextEdit",
        nextEditEnabled,
        vscode.ConfigurationTarget.Global,
      );
    }

    // Check if Next Edit is enabled but model doesn't support it.
    if (
      nextEditEnabled &&
      !modelSupportsNext &&
      !isNextEditTest() &&
      process.env.CONTINUE_E2E_NON_NEXT_EDIT_TEST === "true"
    ) {
      vscode.window
        .showWarningMessage(
          `The current autocomplete model (${autocompleteModel?.title || "unknown"}) does not support Next Edit.`,
          "Disable Next Edit",
          "Select different model",
        )
        .then((selection) => {
          if (selection === "Disable Next Edit") {
            vscodeConfig.update(
              "enableNextEdit",
              false,
              vscode.ConfigurationTarget.Global,
            );
          } else if (selection === "Select different model") {
            vscode.commands.executeCommand(
              "continueJv.openTabAutocompleteConfigMenu",
            );
          }
        });
    }

    const shouldEnableNextEdit =
      (modelSupportsNext && nextEditEnabled) || isNextEditTest();

    if (shouldEnableNextEdit) {
      await setupNextEditWindowManager(context);
      this.activateNextEdit();
      await NextEditWindowManager.freeTabAndEsc();

      const jumpManager = JumpManager.getInstance();
      jumpManager.registerSelectionChangeHandler();

      const ghostTextAcceptanceTracker =
        GhostTextAcceptanceTracker.getInstance();
      ghostTextAcceptanceTracker.registerSelectionChangeHandler();

      const nextEditWindowManager = NextEditWindowManager.getInstance();
      nextEditWindowManager.registerSelectionChangeHandler();
    } else {
      NextEditWindowManager.clearInstance();
      this.deactivateNextEdit();
      await NextEditWindowManager.freeTabAndEsc();

      JumpManager.clearInstance();
      GhostTextAcceptanceTracker.clearInstance();
    }
  }

  constructor(context: vscode.ExtensionContext) {
    this.editDecorationManager = new EditDecorationManager(context);

    let resolveWebviewProtocol: any = undefined;
    this.webviewProtocolPromise = new Promise<VsCodeWebviewProtocol>(
      (resolve) => {
        resolveWebviewProtocol = resolve;
      },
    );
    this.ide = new VsCodeIde(this.webviewProtocolPromise, context);
    this.ideUtils = new VsCodeIdeUtils();
    this.extensionContext = context;
    this.windowId = uuidv4();

    // Check if model supports next edit to determine if we should use full file diff.
    const getUsingFullFileDiff = async () => {
      const { config } = await this.configHandler.loadConfig();
      const autocompleteModel = config?.selectedModelByRole.autocomplete;

      if (!autocompleteModel) {
        return false;
      }

      if (
        !modelSupportsNextEdit(
          autocompleteModel.capabilities,
          autocompleteModel.model,
          autocompleteModel.title,
        )
      ) {
        return false;
      }

      if (autocompleteModel.model.includes(NEXT_EDIT_MODELS.INSTINCT)) {
        return false;
      }

      return true;
    };

    const usingFullFileDiff = true;
    const selectionManager = SelectionChangeManager.getInstance();
    selectionManager.initialize(this.ide, usingFullFileDiff);

    selectionManager.registerListener(
      "typing",
      async (e, state) => {
        const timeSinceLastDocChange =
          Date.now() - state.lastDocumentChangeTime;
        if (
          state.isTypingSession &&
          timeSinceLastDocChange < this.ARBITRARY_TYPING_DELAY &&
          !NextEditWindowManager.getInstance().hasAccepted()
        ) {
          // console.debug(
          //   "VsCodeExtension: typing in progress, preserving chain",
          // );
          return true;
        }

        return false;
      },
      HandlerPriority.NORMAL,
    );

    // Dependencies of core
    let resolveVerticalDiffManager: any = undefined;
    const verticalDiffManagerPromise = new Promise<VerticalDiffManager>(
      (resolve) => {
        resolveVerticalDiffManager = resolve;
      },
    );
    let resolveConfigHandler: any = undefined;
    const configHandlerPromise = new Promise<ConfigHandler>((resolve) => {
      resolveConfigHandler = resolve;
    });
    this.sidebar = new ContinueGUIWebviewViewProvider(
      this.windowId,
      this.extensionContext,
    );

    // Sidebar
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "continueJv.continueGUIView",
        this.sidebar,
        {
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
    );
    resolveWebviewProtocol(this.sidebar.webviewProtocol);

    const inProcessMessenger = new InProcessMessenger<
      ToCoreProtocol,
      FromCoreProtocol
    >();

    new VsCodeMessenger(
      inProcessMessenger,
      this.sidebar.webviewProtocol,
      this.ide,
      verticalDiffManagerPromise,
      configHandlerPromise,
      this.editDecorationManager,
      context,
      this,
    );

    this.core = new Core(inProcessMessenger, this.ide);
    this.configHandler = this.core.configHandler;
    resolveConfigHandler?.(this.configHandler);

    this.chatApiServer = new ChatApiServer(
      this.sidebar.webviewProtocol,
      inProcessMessenger,
    );
    this.chatApiMdns = new MdnsAdvertiser();
    const chatApiLog = (message: string) => this.chatApiServer?.log(message);
    this.telegramRelay = new TelegramBotRelay(this.chatApiServer, chatApiLog);
    context.subscriptions.push({
      dispose: () => {
        this.chatApiServer?.dispose();
        this.chatApiMdns?.stop();
        this.telegramRelay?.dispose();
      },
    });
    void this.setupChatApiServer(context);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${EXTENSION_NAME}.chatApi`)) {
          void this.setupChatApiServer(context);
        }
      }),
    );
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "continueJv.chatApi.showToken",
        async () => await this.showChatApiToken(context),
      ),
    );
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "continueJv.chatApi.setTelegramBotToken",
        async () => {
          const botToken = await vscode.window.showInputBox({
            title: "Telegram Bot Token",
            prompt:
              "Paste the bot token from @BotFather (leave empty to clear)",
            password: true,
            ignoreFocusOut: true,
          });
          if (botToken !== undefined) {
            await this.setTelegramBotToken(botToken);
          }
        },
      ),
    );

    void this.configHandler.loadConfig();

    this.verticalDiffManager = new VerticalDiffManager(
      this.sidebar.webviewProtocol,
      this.editDecorationManager,
      this.ide,
    );
    resolveVerticalDiffManager?.(this.verticalDiffManager);

    void this.configHandler.loadConfig().then(async ({ config }) => {
      const shouldUseFullFileDiff = await getUsingFullFileDiff();
      this.completionProvider.updateUsingFullFileDiff(shouldUseFullFileDiff);
      selectionManager.updateUsingFullFileDiff(shouldUseFullFileDiff);

      const { verticalDiffCodeLens } = registerAllCodeLensProviders(
        context,
        this.verticalDiffManager.fileUriToCodeLens,
        config,
      );

      this.verticalDiffManager.refreshCodeLens =
        verticalDiffCodeLens.refresh.bind(verticalDiffCodeLens);
    });

    this.configHandler.onConfigUpdate(
      async ({ config: newConfig, configLoadInterrupted }) => {
        const shouldUseFullFileDiff = await getUsingFullFileDiff();
        this.completionProvider.updateUsingFullFileDiff(shouldUseFullFileDiff);
        selectionManager.updateUsingFullFileDiff(shouldUseFullFileDiff);

        await this.updateNextEditState(context);

        if (configLoadInterrupted) {
          // Show error in status bar
          setupStatusBar(undefined, undefined, true);
        } else if (newConfig) {
          setupStatusBar(undefined, undefined, false);

          registerAllCodeLensProviders(
            context,
            this.verticalDiffManager.fileUriToCodeLens,
            newConfig,
          );
        }
      },
    );

    // Tab autocomplete
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const enabled = config.get<boolean>("enableTabAutocomplete");

    // Register inline completion provider
    setupStatusBar(
      enabled ? StatusBarStatus.Enabled : StatusBarStatus.Disabled,
    );
    this.completionProvider = new ContinueCompletionProvider(
      this.configHandler,
      this.ide,
      this.sidebar.webviewProtocol,
      usingFullFileDiff,
    );
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        [{ pattern: "**" }],
        this.completionProvider,
      ),
    );

    // Handle uri events
    this.uriHandler.event((uri) => {
      const queryParams = new URLSearchParams(uri.query);
      let profileId = queryParams.get("profile_id");

      this.core.invoke("config/refreshProfiles", {
        reason: "VS Code deep link",
        selectProfileId:
          profileId === "null" ? undefined : (profileId ?? undefined),
      });
    });

    // Battery
    this.battery = new Battery();
    context.subscriptions.push(this.battery);
    context.subscriptions.push(monitorBatteryChanges(this.battery));

    // FileSearch
    this.fileSearch = new FileSearch(this.ide);
    registerAllPromptFilesCompletionProviders(
      context,
      this.fileSearch,
      this.ide,
    );

    const quickEdit = new QuickEdit(
      this.verticalDiffManager,
      this.configHandler,
      this.sidebar.webviewProtocol,
      this.ide,
      context,
      this.fileSearch,
    );

    // LLM Log view
    this.consoleView = new ContinueConsoleWebviewViewProvider(
      this.windowId,
      this.extensionContext,
      this.core.llmLogger,
    );

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "continueJv.continueConsoleView",
        this.consoleView,
      ),
    );

    // Commands
    registerAllCommands(
      context,
      this.ide,
      context,
      this.sidebar,
      this.consoleView,
      this.configHandler,
      this.verticalDiffManager,
      this.battery,
      quickEdit,
      this.core,
      this.editDecorationManager,
    );

    // Disabled due to performance issues
    // registerDebugTracker(this.sidebar.webviewProtocol, this.ide);

    // Listen for file saving - use global file watcher so that changes
    // from outside the window are also caught
    fs.watchFile(getConfigJsonPath(), { interval: 1000 }, async (stats) => {
      if (stats.size === 0) {
        return;
      }
      await this.configHandler.reloadConfig(
        "Global JSON config updated - fs file watch",
      );
    });

    fs.watchFile(
      getConfigYamlPath("vscode"),
      { interval: 1000 },
      async (stats) => {
        if (stats.size === 0) {
          return;
        }
        await this.configHandler.reloadConfig(
          "Global YAML config updated - fs file watch",
        );
      },
    );

    fs.watchFile(getConfigTsPath(), { interval: 1000 }, (stats) => {
      if (stats.size === 0) {
        return;
      }
      void this.configHandler.reloadConfig("config.ts updated - fs file watch");
    });

    // watch global rules directory for changes
    const globalRulesDir = path.join(getContinueGlobalPath(), "rules");
    if (fs.existsSync(globalRulesDir)) {
      fs.watch(globalRulesDir, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith(".md")) {
          void this.configHandler.reloadConfig(
            "Global rules directory updated - fs file watch",
          );
        }
      });
    }

    // Initialize document content cache for tracking pre-edit content
    vscode.workspace.onDidOpenTextDocument((document) => {
      initDocumentContentCache(document);
    });

    // Initialize cache for all currently open documents
    for (const document of vscode.workspace.textDocuments) {
      initDocumentContentCache(document);
    }

    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (event.contentChanges.length > 0) {
        selectionManager.documentChanged();
      }

      const editInfo = await handleTextDocumentChange(
        event,
        this.configHandler,
        this.ide,
        this.completionProvider,
        getDefinitionsFromLsp,
      );

      if (editInfo) this.core.invoke("files/smallEdit", editInfo);
    });

    vscode.workspace.onDidSaveTextDocument(async (event) => {
      this.core.invoke("files/changed", {
        uris: [event.uri.toString()],
      });
    });

    vscode.workspace.onDidDeleteFiles(async (event) => {
      this.core.invoke("files/deleted", {
        uris: event.files.map((uri) => uri.toString()),
      });
    });

    vscode.workspace.onDidCloseTextDocument(async (event) => {
      clearDocumentContentCache(event.uri.toString());
      this.core.invoke("files/closed", {
        uris: [event.uri.toString()],
      });
    });

    vscode.workspace.onDidCreateFiles(async (event) => {
      this.core.invoke("files/created", {
        uris: event.files.map((uri) => uri.toString()),
      });
    });

    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      const dirs = vscode.workspace.workspaceFolders?.map(
        (folder) => folder.uri,
      );

      this.ideUtils.setWokspaceDirectories(dirs);

      this.core.invoke("index/forceReIndex", {
        dirs: [
          ...event.added.map((folder) => folder.uri.toString()),
          ...event.removed.map((folder) => folder.uri.toString()),
        ],
      });
    });

    // TODO merge this and re-enable https://github.com/continuedev/continue/pull/8364
    // vscode.workspace.onDidOpenTextDocument(async (event) => {
    //   const ast = await getAst(event.fileName, event.getText());
    //   if (ast) {
    //     DocumentHistoryTracker.getInstance().addDocument(
    //       localPathOrUriToPath(event.fileName),
    //       event.getText(),
    //       ast,
    //     );
    //   }
    // });

    // When GitHub sign-in status changes, reload config
    vscode.authentication.onDidChangeSessions(async (e) => {
      if (e.provider.id === "github") {
        this.configHandler.reloadConfig("Github sign-in status changed");
      }
    });

    // Listen for editor changes to clean up decorations when editor closes.
    vscode.window.onDidChangeVisibleTextEditors(async () => {
      // If our active editor is no longer visible, clear decorations.
      console.log("deleteChain called from onDidChangeVisibleTextEditors");
      await NextEditProvider.getInstance().deleteChain();
    });

    // Listen for selection changes to hide tooltip when cursor moves.
    vscode.window.onDidChangeTextEditorSelection(async (e) => {
      await selectionManager.handleSelectionChange(e);
    });

    // Refresh index when branch is changed
    void this.ide.getWorkspaceDirs().then((dirs) =>
      dirs.forEach(async (dir) => {
        const repo = await this.ide.getRepo(dir);
        if (repo) {
          repo.state.onDidChange(() => {
            // args passed to this callback are always undefined, so keep track of previous branch
            const currentBranch = repo?.state?.HEAD?.name;
            if (currentBranch) {
              if (this.PREVIOUS_BRANCH_FOR_WORKSPACE_DIR[dir]) {
                if (
                  currentBranch !== this.PREVIOUS_BRANCH_FOR_WORKSPACE_DIR[dir]
                ) {
                  // Trigger refresh of index only in this directory
                  this.core.invoke("index/forceReIndex", { dirs: [dir] });
                }
              }

              this.PREVIOUS_BRANCH_FOR_WORKSPACE_DIR[dir] = currentBranch;
            }
          });
        }
      }),
    );

    // Register a content provider for the readonly virtual documents
    const documentContentProvider = new (class
      implements vscode.TextDocumentContentProvider
    {
      // emitter and its event
      onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
      onDidChange = this.onDidChangeEmitter.event;

      provideTextDocumentContent(uri: vscode.Uri): string {
        return uri.query;
      }
    })();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        VsCodeExtension.continueVirtualDocumentScheme,
        documentContentProvider,
      ),
    );

    const linkProvider = vscode.languages.registerDocumentLinkProvider(
      { language: "yaml" },
      new ConfigYamlDocumentLinkProvider(),
    );
    context.subscriptions.push(linkProvider);

    this.ide.onDidChangeActiveTextEditor((filepath) => {
      void this.core.invoke("files/opened", { uris: [filepath] });
    });

    // initializes openedFileLruCache with files that are already open when the extension is activated
    let initialOpenedFilePaths = this.ideUtils
      .getOpenFiles()
      .map((uri) => uri.toString());
    this.core.invoke("files/opened", { uris: initialOpenedFilePaths });

    // This is how you would enable/disable next edit in the autocomplete menu.
    // See extensions/vscode/src/autocomplete/statusBar.ts.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(EXTENSION_NAME)) {
        const settings = await this.ide.getIdeSettings();
        void this.core.invoke("config/ideSettingsUpdate", settings);

        if (event.affectsConfiguration(`${EXTENSION_NAME}.enableNextEdit`)) {
          await this.updateNextEditState(context);
        }
      }
    });
  }

  static continueVirtualDocumentScheme = EXTENSION_NAME;

  // eslint-disable-next-line @typescript-eslint/naming-convention
  private PREVIOUS_BRANCH_FOR_WORKSPACE_DIR: { [dir: string]: string } = {};

  registerCustomContextProvider(contextProvider: IContextProvider) {
    this.configHandler.registerCustomContextProvider(contextProvider);
  }

  public activateNextEdit() {
    this.completionProvider.activateNextEdit();
  }

  public deactivateNextEdit() {
    this.completionProvider.deactivateNextEdit();
  }

  private async getOrCreateChatApiToken(
    context: vscode.ExtensionContext,
  ): Promise<string> {
    const secretKey = "continue-jv.chatApi.token";
    let token = await context.secrets.get(secretKey);
    if (!token) {
      token = crypto.randomBytes(24).toString("hex");
      await context.secrets.store(secretKey, token);
    }
    return token;
  }

  private async showChatApiToken(context: vscode.ExtensionContext) {
    const token = await this.getOrCreateChatApiToken(context);
    const action = await vscode.window.showInformationMessage(
      `Continue JV Chat API token: ${token}`,
      "Copy Token",
    );
    if (action === "Copy Token") {
      await vscode.env.clipboard.writeText(token);
    }
  }

  private async setupChatApiServer(context: vscode.ExtensionContext) {
    if (!this.chatApiServer) {
      return;
    }
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const enabled = config.get<boolean>("chatApi.enabled", false);
    const port = config.get<number>("chatApi.port", 65433);
    const host = config.get<string>("chatApi.host", "127.0.0.1");
    const mdnsEnabled = config.get<boolean>("chatApi.mdns", true);

    this.chatApiMdns?.stop();

    if (!enabled) {
      await this.chatApiServer.stop();
    } else {
      const token = await this.getOrCreateChatApiToken(context);
      try {
        await this.chatApiServer.start(port, host, token);
        // Advertising a loopback-only server would let other devices discover
        // something they can't reach, so only advertise non-loopback binds.
        if (mdnsEnabled && !isLoopbackHost(host)) {
          this.chatApiMdns?.advertise(
            // The server may have moved to a nearby port if another VS Code
            // window already took the configured one
            this.chatApiServer.actualPort,
            vscode.workspace.name ?? "",
            (m) => this.chatApiServer?.log(m),
          );
        }
      } catch (e: any) {
        void vscode.window.showErrorMessage(
          `Failed to start Continue JV Chat API server on ${host}:${port}: ${e?.message ?? e}`,
        );
      }
    }

    await this.setupTelegramRelay(context);
  }

  private async setupTelegramRelay(context: vscode.ExtensionContext) {
    if (!this.telegramRelay) {
      return;
    }
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const enabled = config.get<boolean>("chatApi.telegram.enabled", false);
    const allowedChatIds = config.get<string>(
      "chatApi.telegram.allowedChatIds",
      "",
    );
    const botToken = await context.secrets.get(TELEGRAM_BOT_TOKEN_SECRET_KEY);

    if (!enabled || !botToken) {
      this.telegramRelay.stop();
      return;
    }
    await this.telegramRelay.start({ botToken, allowedChatIds });
  }

  public async getChatApiStatus(): Promise<ChatApiStatus> {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const enabled = config.get<boolean>("chatApi.enabled", false);
    const configuredPort = config.get<number>("chatApi.port", 65433);
    // Show the port actually bound (may differ with multiple windows open)
    const port = this.chatApiServer?.isRunning
      ? this.chatApiServer.actualPort
      : configuredPort;
    const host = config.get<string>("chatApi.host", "127.0.0.1");
    const mdnsEnabled = config.get<boolean>("chatApi.mdns", true);
    const token = await this.getOrCreateChatApiToken(this.extensionContext);
    const botToken = await this.extensionContext.secrets.get(
      TELEGRAM_BOT_TOKEN_SECRET_KEY,
    );
    const telegramStatus = this.telegramRelay?.status;

    const urls: string[] = [];
    if (host === "0.0.0.0" || host === "::") {
      urls.push(`http://127.0.0.1:${port}`);
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family === "IPv4" && !address.internal) {
            urls.push(`http://${address.address}:${port}`);
          }
        }
      }
    } else {
      urls.push(`http://${host}:${port}`);
    }

    return {
      enabled,
      running: this.chatApiServer?.isRunning ?? false,
      host,
      port,
      token,
      mdnsEnabled,
      urls,
      telegram: {
        enabled: config.get<boolean>("chatApi.telegram.enabled", false),
        botTokenSet: !!botToken,
        botUsername: telegramStatus?.botUsername,
        allowedChatIds: config.get<string>(
          "chatApi.telegram.allowedChatIds",
          "",
        ),
        status: telegramStatus?.state ?? "stopped",
        error: telegramStatus?.error,
      },
    };
  }

  public async updateChatApiSettings(
    update: ChatApiSettingsUpdate,
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const target = vscode.ConfigurationTarget.Global;
    if (update.enabled !== undefined) {
      await config.update("chatApi.enabled", update.enabled, target);
    }
    if (update.port !== undefined) {
      await config.update("chatApi.port", update.port, target);
    }
    if (update.lanAccess !== undefined) {
      await config.update(
        "chatApi.host",
        update.lanAccess ? "0.0.0.0" : "127.0.0.1",
        target,
      );
    }
    if (update.mdnsEnabled !== undefined) {
      await config.update("chatApi.mdns", update.mdnsEnabled, target);
    }
    if (update.telegramEnabled !== undefined) {
      await config.update(
        "chatApi.telegram.enabled",
        update.telegramEnabled,
        target,
      );
    }
    if (update.telegramAllowedChatIds !== undefined) {
      await config.update(
        "chatApi.telegram.allowedChatIds",
        update.telegramAllowedChatIds,
        target,
      );
    }
    // Config change events re-run setupChatApiServer, so no restart needed here.
  }

  public async setTelegramBotToken(botToken: string): Promise<void> {
    if (botToken.trim()) {
      await this.extensionContext.secrets.store(
        TELEGRAM_BOT_TOKEN_SECRET_KEY,
        botToken.trim(),
      );
    } else {
      await this.extensionContext.secrets.delete(TELEGRAM_BOT_TOKEN_SECRET_KEY);
    }
    // Secret changes don't fire onDidChangeConfiguration - restart manually.
    await this.setupTelegramRelay(this.extensionContext);
  }
}

const TELEGRAM_BOT_TOKEN_SECRET_KEY = "continue-jv.chatApi.telegramBotToken";

function isLoopbackHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "::1" ||
    host.startsWith("127.")
  );
}
