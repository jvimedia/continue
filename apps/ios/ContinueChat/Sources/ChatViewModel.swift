import Foundation

/// Connects to the Chat API server, mirrors the sidebar conversation, and
/// sends user messages into it.
@MainActor
final class ChatViewModel: ObservableObject {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    @Published private(set) var messages: [DisplayMessage] = []
    @Published private(set) var state: ConnectionState = .disconnected
    @Published private(set) var connection: ServerConnection?

    private var webSocketTask: URLSessionWebSocketTask?
    /// Maps a turnId from the stream to the streaming assistant bubble it
    /// belongs to.
    private var streamingTurns: [String: UUID] = [:]
    private let session = URLSession(configuration: .default)

    // MARK: Lifecycle

    func connect(_ connection: ServerConnection) {
        disconnect()
        guard let wsURL = connection.webSocketURL else {
            state = .error("Invalid server address")
            return
        }
        self.connection = connection
        state = .connecting
        ConnectionStore.save(connection)

        Task {
            do {
                try await loadSnapshot(connection)
            } catch {
                state = .error("Could not reach server: \(error.localizedDescription)")
                return
            }
            let task = session.webSocketTask(with: wsURL)
            webSocketTask = task
            task.resume()
            state = .connected
            receiveLoop(task)
        }
    }

    func disconnect() {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        streamingTurns.removeAll()
        messages.removeAll()
        state = .disconnected
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let task = webSocketTask else {
            return
        }
        let payload: [String: String] = ["type": "message", "input": trimmed]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8)
        else {
            return
        }
        task.send(.string(json)) { [weak self] error in
            if let error {
                Task { @MainActor in
                    self?.state = .error("Send failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: History snapshot

    /// Fetch `/session` so the app shows the conversation so far, not just
    /// what streams in after connecting.
    private func loadSnapshot(_ connection: ServerConnection) async throws {
        guard let baseURL = connection.baseURL else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: baseURL.appendingPathComponent("session"))
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            throw URLError(.userAuthenticationRequired)
        }

        let snapshot = try JSONDecoder().decode(JSONValue.self, from: data)
        var restored: [DisplayMessage] = []
        for item in snapshot["session"]?["history"]?.arrayValue ?? [] {
            guard let message = item["message"],
                  let role = message["role"]?.stringValue
            else {
                continue
            }
            let text = message.chatText
            guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
                continue
            }
            if role == "user" {
                restored.append(DisplayMessage(kind: .user, text: text))
            } else if role == "assistant" {
                restored.append(DisplayMessage(kind: .assistant, text: text))
            }
        }
        messages = restored
    }

    // MARK: Live stream

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, task === self.webSocketTask else {
                    return
                }
                switch result {
                case .success(let message):
                    if case .string(let json) = message,
                       let data = json.data(using: .utf8),
                       let event = try? JSONDecoder().decode(ChatStreamEvent.self, from: data) {
                        self.handle(event)
                    }
                    self.receiveLoop(task)
                case .failure(let error):
                    self.state = .error("Connection lost: \(error.localizedDescription)")
                    self.webSocketTask = nil
                }
            }
        }
    }

    private func handle(_ event: ChatStreamEvent) {
        switch event.type {
        case "user_message":
            let text = event.data?.chatText ?? ""
            if !text.isEmpty {
                messages.append(DisplayMessage(kind: .user, text: text))
            }

        case "assistant_delta":
            let delta = event.data?["content"]?.chatText ?? ""
            guard !delta.isEmpty else { return }
            if let messageId = streamingTurns[event.turnId],
               let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].text += delta
            } else {
                let message = DisplayMessage(kind: .assistant, text: delta, isStreaming: true)
                streamingTurns[event.turnId] = message.id
                messages.append(message)
            }

        case "assistant_done":
            if let messageId = streamingTurns.removeValue(forKey: event.turnId),
               let index = messages.firstIndex(where: { $0.id == messageId }) {
                messages[index].isStreaming = false
            }

        default:
            break
        }
    }
}
