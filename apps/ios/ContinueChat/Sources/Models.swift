import Foundation

// MARK: - Display model

struct DisplayMessage: Identifiable, Equatable {
    enum Kind {
        case user
        case assistant
    }

    let id: UUID
    let kind: Kind
    var text: String
    var isStreaming: Bool

    init(id: UUID = UUID(), kind: Kind, text: String, isStreaming: Bool = false) {
        self.id = id
        self.kind = kind
        self.text = text
        self.isStreaming = isStreaming
    }
}

// MARK: - Wire model

/// One event from the Chat API stream (`/ws` WebSocket or `/events` SSE).
/// Mirrors `ChatStreamEvent` in the VS Code extension.
struct ChatStreamEvent: Decodable {
    let type: String
    let turnId: String
    let data: JSONValue?
}

/// Tolerant JSON value so we can decode the several shapes chat content
/// arrives in (string, ChatMessage object, arrays of message parts, ...).
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
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let number = try? container.decode(Double.self) {
            self = .number(number)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else if let array = try? container.decode([JSONValue].self) {
            self = .array(array)
        } else if let object = try? container.decode([String: JSONValue].self) {
            self = .object(object)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let obj) = self { return obj[key] }
        return nil
    }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    /// Extract plain chat text from a string, a ChatMessage ({role, content}),
    /// an array of message parts ({type: "text", text}), or arrays thereof.
    var chatText: String {
        switch self {
        case .string(let s):
            return s
        case .array(let items):
            return items.map(\.chatText).joined()
        case .object(let obj):
            if case .string(let text)? = obj["text"] {
                return text
            }
            if let content = obj["content"] {
                return content.chatText
            }
            return ""
        default:
            return ""
        }
    }
}
