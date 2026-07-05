import SwiftUI

/// Drives the chat timeline: loads history, opens the SSE stream, and
/// accumulates deltas per `turnId` into live timeline rows.
@MainActor
final class ChatViewModel: ObservableObject {
    enum ConnectionState {
        case connecting
        case live
        case disconnected
    }

    @Published private(set) var messages: [TimelineMessage] = []
    @Published private(set) var connectionState: ConnectionState = .connecting
    @Published var errorBanner: String?
    @Published var inputText: String = ""

    private let client: ContinueAPIClient
    private var streamTask: Task<Void, Never>?
    /// Counts of "role|text" pairs loaded from `/session` history, so the
    /// `user_message` event for a message that's already in history (echoed
    /// back once the sidebar issues its next request) isn't added twice.
    private var seenHistoryUserTexts: [String: Int] = [:]

    init(client: ContinueAPIClient) {
        self.client = client
    }

    func start() async {
        await loadSession()
        connectStream()
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func loadSession() async {
        do {
            let response = try await client.fetchSession()
            let historyItems = response.session?.history ?? []
            var loaded: [TimelineMessage] = []
            seenHistoryUserTexts.removeAll()
            for (index, item) in historyItems.enumerated() {
                let role: TimelineMessage.Role = item.message.role == "user" ? .user : .assistant
                let text = item.message.content.displayText
                loaded.append(TimelineMessage(id: "history-\(index)", turnId: nil, role: role, text: text))
                if role == .user {
                    seenHistoryUserTexts["user|\(text)", default: 0] += 1
                }
            }
            messages = loaded
            errorBanner = nil
        } catch {
            errorBanner = "Couldn't load session history: \(error.localizedDescription)"
        }
    }

    func connectStream() {
        streamTask?.cancel()
        connectionState = .connecting
        streamTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                self.connectionState = .connecting
                do {
                    for try await event in self.client.eventStream() {
                        self.connectionState = .live
                        self.handle(event: event)
                    }
                } catch is CancellationError {
                    return
                } catch {
                    // Fall through to the retry delay below.
                }
                if Task.isCancelled { return }
                self.connectionState = .disconnected
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputText = ""
        Task {
            do {
                try await client.sendMessage(text)
            } catch {
                errorBanner = "Failed to send message: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Event handling

    private func handle(event: StreamEvent) {
        switch event.eventType {
        case .userMessage:
            appendUserMessage(turnId: event.turnId, text: event.userMessageText)
        case .assistantDelta:
            upsertAssistantMessage(
                turnId: event.turnId,
                text: event.assistantChunkText,
                replaceFullText: false,
                isStreaming: true,
                isError: event.status == "error"
            )
        case .assistantDone:
            // `assistant_done.data.content` is absent when the turn errored
            // before producing a completion - fall back to `data.error`, and
            // if neither is present, leave whatever text streamed in from
            // `assistant_delta` events alone rather than blanking it out.
            let chunkText = event.assistantChunkText
            let finalText = chunkText.isEmpty ? (event.errorMessage ?? "") : chunkText
            upsertAssistantMessage(
                turnId: event.turnId,
                text: finalText,
                replaceFullText: !finalText.isEmpty,
                isStreaming: false,
                isError: event.status == "error"
            )
        case .session, .error, .unknown:
            break
        }
    }

    private func appendUserMessage(turnId: String, text: String) {
        let key = "user|\(text)"
        if let remaining = seenHistoryUserTexts[key], remaining > 0 {
            seenHistoryUserTexts[key] = remaining - 1
            return
        }
        guard !messages.contains(where: { $0.turnId == turnId && $0.role == .user }) else { return }
        messages.append(TimelineMessage(id: "user-\(turnId)", turnId: turnId, role: .user, text: text))
    }

    private func upsertAssistantMessage(turnId: String, text: String, replaceFullText: Bool, isStreaming: Bool, isError: Bool) {
        if let index = messages.firstIndex(where: { $0.turnId == turnId && $0.role == .assistant }) {
            messages[index].text = replaceFullText ? text : messages[index].text + text
            messages[index].isStreaming = isStreaming
            messages[index].isError = isError
        } else {
            messages.append(
                TimelineMessage(
                    id: "assistant-\(turnId)",
                    turnId: turnId,
                    role: .assistant,
                    text: text,
                    isStreaming: isStreaming,
                    isError: isError
                )
            )
        }
    }
}

/// Continue's chat panel reads as a linear, full-width document: a scrollable
/// message list with an input box pinned at the bottom (no side-by-side
/// avatars or bubble backgrounds). This view mirrors that layout using native
/// iOS idioms (NavigationStack, safeAreaInset for keyboard-avoiding input).
struct ChatView: View {
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var viewModel: ChatViewModel
    @State private var showSettings = false
    @FocusState private var inputFocused: Bool

    init(client: ContinueAPIClient) {
        _viewModel = StateObject(wrappedValue: ChatViewModel(client: client))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let banner = viewModel.errorBanner {
                    Text(banner)
                        .font(.footnote)
                        .foregroundColor(.white)
                        .padding(8)
                        .frame(maxWidth: .infinity)
                        .background(ContinueTheme.error)
                }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(viewModel.messages) { message in
                                MessageRowView(message: message)
                                    .id(message.id)
                            }
                        }
                        .padding(16)
                    }
                    .background(ContinueTheme.background(colorScheme))
                    .onChange(of: viewModel.messages.count) { _ in
                        scrollToBottom(proxy: proxy)
                    }
                    .onChange(of: viewModel.messages.last?.text) { _ in
                        scrollToBottom(proxy: proxy)
                    }
                }
            }
            .background(ContinueTheme.background(colorScheme).ignoresSafeArea())
            .safeAreaInset(edge: .bottom) {
                inputBar
            }
            .navigationTitle("Continue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    connectionIndicator
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(isDismissable: true)
                    .environmentObject(settings)
            }
            .task {
                await viewModel.start()
            }
            .onDisappear {
                viewModel.stop()
            }
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message Continue…", text: $viewModel.inputText, axis: .vertical)
                .lineLimit(1...5)
                .focused($inputFocused)
                .padding(10)
                .background(ContinueTheme.inputBackground(colorScheme))
                .cornerRadius(8)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(ContinueTheme.border(colorScheme), lineWidth: 1)
                )

            Button(action: viewModel.send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
            }
            .foregroundColor(sendButtonEnabled ? ContinueTheme.primary : ContinueTheme.secondaryForeground(colorScheme))
            .disabled(!sendButtonEnabled)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            ContinueTheme.background(colorScheme)
                .overlay(
                    Rectangle()
                        .frame(height: 1)
                        .foregroundColor(ContinueTheme.border(colorScheme)),
                    alignment: .top
                )
        )
    }

    private var sendButtonEnabled: Bool {
        !viewModel.inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var connectionIndicator: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(connectionColor)
                .frame(width: 8, height: 8)
            Text(connectionLabel)
                .font(.caption)
                .foregroundColor(ContinueTheme.secondaryForeground(colorScheme))
        }
    }

    private var connectionColor: Color {
        switch viewModel.connectionState {
        case .live: return ContinueTheme.success
        case .connecting: return ContinueTheme.warning
        case .disconnected: return ContinueTheme.error
        }
    }

    private var connectionLabel: String {
        switch viewModel.connectionState {
        case .live: return "Live"
        case .connecting: return "Connecting…"
        case .disconnected: return "Disconnected"
        }
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        guard let lastId = viewModel.messages.last?.id else { return }
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(lastId, anchor: .bottom)
        }
    }
}

#Preview {
    ChatView(client: ContinueAPIClient(config: APIConfig(baseURL: URL(string: "http://127.0.0.1:65432")!, token: "preview")))
        .environmentObject(AppSettings())
}
