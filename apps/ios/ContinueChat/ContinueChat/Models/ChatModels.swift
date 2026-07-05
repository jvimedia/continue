import Foundation

// MARK: - Loose JSON value

/// A minimal untyped JSON representation used to decode the `data` payload of
/// stream events, whose shape depends on the event's `type`.
enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let boolValue = try? container.decode(Bool.self) {
            self = .bool(boolValue)
        } else if let numberValue = try? container.decode(Double.self) {
            self = .number(numberValue)
        } else if let stringValue = try? container.decode(String.self) {
            self = .string(stringValue)
        } else if let arrayValue = try? container.decode([JSONValue].self) {
            self = .array(arrayValue)
        } else if let objectValue = try? container.decode([String: JSONValue].self) {
            self = .object(objectValue)
        } else {
            self = .null
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let dict) = self {
            return dict[key]
        }
        return nil
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
}

// MARK: - Chat message content

/// The `content` field of a `ChatMessage` from the Continue API. In practice it
/// is almost always a plain string; per the v1 contract we fall back to a
/// placeholder for the (theoretical) array-of-parts form.
enum MessageContent: Codable, Hashable {
    case text(String)
    case unsupported

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let stringValue = try? container.decode(String.self) {
            self = .text(stringValue)
        } else {
            self = .unsupported
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .text(let value):
            try container.encode(value)
        case .unsupported:
            try container.encode("[unsupported content]")
        }
    }

    var displayText: String {
        switch self {
        case .text(let value):
            return value
        case .unsupported:
            return "[unsupported content]"
        }
    }
}

/// Mirrors the `ChatMessage` shape used throughout the Continue chat history API.
struct ChatMessage: Codable, Hashable {
    let role: String
    let content: MessageContent
}

// MARK: - Session snapshot (GET /session)

struct SessionHistoryItem: Codable {
    let message: ChatMessage
}

struct SessionSnapshot: Codable {
    let sessionId: String?
    let title: String?
    let history: [SessionHistoryItem]?
}

struct SessionResponse: Codable {
    let sessionId: String?
    let session: SessionSnapshot?
}

// MARK: - Streaming events (GET /events)

enum StreamEventType: String {
    case userMessage = "user_message"
    case assistantDelta = "assistant_delta"
    case assistantDone = "assistant_done"
    case session
    case error
    case unknown
}

struct StreamEvent: Decodable {
    let type: String
    let turnId: String
    let timestamp: Double
    let data: JSONValue

    var eventType: StreamEventType {
        StreamEventType(rawValue: type) ?? .unknown
    }
}

extension StreamEvent {
    /// For `user_message` events: `data` is `{ role: "user", content: string }`.
    /// Falls back to a placeholder if `content` isn't a plain string.
    var userMessageText: String {
        data["content"]?.stringValue ?? "[unsupported content]"
    }

    /// For `assistant_delta` / `assistant_done` events: `data.content` is a
    /// `ChatMessage` or an array of them. Concatenates the `content` text of
    /// each chunk, mirroring the reference JS example in the API docs.
    var assistantChunkText: String {
        guard let contentValue = data["content"] else { return "" }
        let items: [JSONValue] = contentValue.arrayValue ?? [contentValue]
        return items.compactMap { $0["content"]?.stringValue }.joined()
    }

    var status: String? {
        data["status"]?.stringValue
    }

    /// For `assistant_done` events that ended in an error before any
    /// completion was produced: `data.content` is absent, but `data.error`
    /// holds the message (see docs/guides/chat-streaming-api.mdx).
    var errorMessage: String? {
        data["error"]?.stringValue
    }
}

// MARK: - Timeline (UI-facing model)

/// A single row in the chat timeline. Live turns produce up to two of these
/// (one user message, one accumulating assistant reply) sharing a `turnId`;
/// history loaded from `/session` produces one per stored message.
struct TimelineMessage: Identifiable, Equatable {
    enum Role: Equatable {
        case user
        case assistant
    }

    let id: String
    let turnId: String?
    let role: Role
    var text: String
    var isStreaming: Bool = false
    var isError: Bool = false
}
