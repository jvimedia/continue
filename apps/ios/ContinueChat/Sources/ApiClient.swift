import Foundation

/// `GET /info` - identifies the VS Code window behind a server.
struct ServerInfo: Decodable {
    let workspaceName: String?
    let workspacePaths: [String]?
    let appName: String?
    let extensionVersion: String?
    let currentSessionId: String?
    let port: Int?
}

/// One entry from `GET /sessions` (Continue's session metadata).
struct SessionMeta: Decodable, Identifiable {
    let sessionId: String
    let title: String
    let dateCreated: String
    let workspaceDirectory: String?

    var id: String { sessionId }

    /// `dateCreated` is either an ISO string or epoch milliseconds.
    var date: Date? {
        if let millis = Double(dateCreated) {
            return Date(timeIntervalSince1970: millis / 1000)
        }
        return ISO8601DateFormatter().date(from: dateCreated)
    }
}

enum ApiError: LocalizedError {
    case badURL
    case unauthorized
    case http(Int)

    var errorDescription: String? {
        switch self {
        case .badURL:
            return "Invalid server address"
        case .unauthorized:
            return "Invalid API token"
        case .http(let code):
            return "Server error (HTTP \(code))"
        }
    }
}

/// Minimal client for the Chat API's JSON endpoints. The chat itself runs in
/// the remote GUI (WKWebView); this is only used for the server/session
/// browser.
struct ApiClient {
    let connection: ServerConnection

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard let baseURL = connection.baseURL else {
            throw ApiError.badURL
        }
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.setValue(
            "Bearer \(connection.token)",
            forHTTPHeaderField: "Authorization"
        )
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 401 {
                throw ApiError.unauthorized
            }
            guard (200 ..< 300).contains(http.statusCode) else {
                throw ApiError.http(http.statusCode)
            }
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func info() async throws -> ServerInfo {
        try await get("info", as: ServerInfo.self)
    }

    func sessions() async throws -> [SessionMeta] {
        struct SessionsResponse: Decodable {
            let sessions: [SessionMeta]
        }
        return try await get("sessions", as: SessionsResponse.self).sessions
    }
}
