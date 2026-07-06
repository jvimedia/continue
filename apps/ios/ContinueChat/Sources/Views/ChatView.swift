import SwiftUI

/// The live mirror of the Continue sidebar conversation.
struct ChatView: View {
    @ObservedObject var viewModel: ChatViewModel
    @State private var draft: String = ""
    @FocusState private var inputFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(viewModel.messages) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                }
                .onChange(of: viewModel.messages) { messages in
                    if let last = messages.last {
                        withAnimation(.easeOut(duration: 0.15)) {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            Divider()

            HStack(spacing: 10) {
                TextField("Message Continue…", text: $draft, axis: .vertical)
                    .lineLimit(1 ... 5)
                    .textFieldStyle(.plain)
                    .focused($inputFocused)
                    .onSubmit(sendDraft)
                Button(action: sendDraft) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(
                    draft.trimmingCharacters(in: .whitespaces).isEmpty
                        || viewModel.state != .connected
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Disconnect") {
                    viewModel.disconnect()
                }
            }
        }
    }

    private var title: String {
        if case .error = viewModel.state {
            return "Reconnecting…"
        }
        if let connection = viewModel.connection {
            return connection.host
        }
        return "Continue Chat"
    }

    private func sendDraft() {
        let text = draft
        draft = ""
        viewModel.send(text)
    }
}

private struct MessageBubble: View {
    let message: DisplayMessage

    var body: some View {
        HStack {
            if message.kind == .user {
                Spacer(minLength: 40)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(message.text)
                    .textSelection(.enabled)
                if message.isStreaming {
                    ProgressView()
                        .controlSize(.mini)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                message.kind == .user
                    ? AnyShapeStyle(Color.accentColor.opacity(0.9))
                    : AnyShapeStyle(.thinMaterial)
            )
            .foregroundStyle(message.kind == .user ? .white : .primary)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if message.kind == .assistant {
                Spacer(minLength: 40)
            }
        }
    }
}
