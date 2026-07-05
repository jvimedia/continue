import Foundation
import Security

// MARK: - Keychain helper

/// A tiny wrapper around the Keychain Services API used to store the bearer
/// token more safely than UserDefaults. No third-party dependency required.
enum KeychainHelper {
    private static let service = "dev.continue.chat"

    static func save(_ value: String, forKey key: String) {
        guard let data = value.data(using: .utf8) else { return }
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        // Remove any existing item first so this always behaves like an upsert.
        SecItemDelete(baseQuery as CFDictionary)

        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func load(forKey key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(forKey key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Persisted app settings

/// Holds the user-configured server URL + token, persisted across launches.
/// The base URL is not sensitive so it lives in UserDefaults; the token is
/// stored in the Keychain.
@MainActor
final class AppSettings: ObservableObject {
    private enum Keys {
        static let baseURL = "continueChat.baseURL"
        static let tokenKeychainKey = "continueChat.token"
    }

    @Published var baseURLString: String {
        didSet { UserDefaults.standard.set(baseURLString, forKey: Keys.baseURL) }
    }

    @Published var token: String {
        didSet { KeychainHelper.save(token, forKey: Keys.tokenKeychainKey) }
    }

    init() {
        self.baseURLString = UserDefaults.standard.string(forKey: Keys.baseURL) ?? ""
        self.token = KeychainHelper.load(forKey: Keys.tokenKeychainKey) ?? ""
    }

    var isConfigured: Bool {
        !baseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && URL(string: baseURLString) != nil
    }

    func clear() {
        baseURLString = ""
        token = ""
    }

    func makeConfig() -> APIConfig? {
        guard let url = URL(string: baseURLString) else { return nil }
        return APIConfig(baseURL: url, token: token)
    }
}

// MARK: - API client

struct APIConfig {
    let baseURL: URL
    let token: String
}

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case http(status: Int, body: String)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid server URL."
        case .invalidResponse:
            return "The server returned an unexpected response."
        case .http(let status, let body):
            return "Server returned HTTP \(status): \(body.isEmpty ? "no details" : body)"
        case .decoding(let error):
            return "Failed to decode server response: \(error.localizedDescription)"
        }
    }
}

/// Thin URLSession-based client for the Continue Chat Streaming API. See
/// docs/guides/chat-streaming-api.mdx in the main repo for the full contract.
final class ContinueAPIClient {
    let config: APIConfig
    private let session: URLSession

    init(config: APIConfig) {
        self.config = config
        self.session = URLSession(configuration: .default)
    }

    // MARK: Request building

    private func url(path: String, includeTokenQueryParam: Bool = false) throws -> URL {
        guard var components = URLComponents(
            url: config.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.invalidURL
        }
        if includeTokenQueryParam {
            components.queryItems = [URLQueryItem(name: "token", value: config.token)]
        }
        guard let resolved = components.url else { throw APIError.invalidURL }
        return resolved
    }

    private func authorizedRequest(
        path: String,
        method: String = "GET",
        body: Data? = nil,
        includeTokenQueryParam: Bool = false
    ) throws -> URLRequest {
        var request = URLRequest(url: try url(path: path, includeTokenQueryParam: includeTokenQueryParam))
        request.httpMethod = method
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    private static func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw APIError.http(status: http.statusCode, body: body)
        }
    }

    // MARK: Endpoints

    /// `GET /health` — no auth required.
    func checkHealth() async throws -> Bool {
        let url = config.baseURL.appendingPathComponent("health")
        let (data, response) = try await session.data(from: url)
        try Self.validate(response: response, data: data)
        struct HealthResponse: Decodable { let ok: Bool }
        do {
            return try JSONDecoder().decode(HealthResponse.self, from: data).ok
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// `GET /session`
    func fetchSession() async throws -> SessionResponse {
        let request = try authorizedRequest(path: "session")
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
        do {
            return try JSONDecoder().decode(SessionResponse.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// `POST /message`
    func sendMessage(_ text: String) async throws {
        let body = try JSONEncoder().encode(["input": text])
        let request = try authorizedRequest(path: "message", method: "POST", body: body)
        let (data, response) = try await session.data(for: request)
        try Self.validate(response: response, data: data)
    }

    // MARK: Streaming

    /// `GET /events` — parsed by hand as SSE: read the response body as an
    /// async sequence of lines, buffer `data:` lines until a blank line, then
    /// decode the buffered JSON payload as a `StreamEvent`.
    func eventStream() -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let request = try authorizedRequest(path: "events", includeTokenQueryParam: true)
                    let (bytes, response) = try await session.bytes(for: request)

                    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                        continuation.finish(throwing: APIError.http(status: status, body: ""))
                        return
                    }

                    var dataBuffer = ""
                    for try await line in bytes.lines {
                        try Task.checkCancellation()

                        if line.isEmpty {
                            if !dataBuffer.isEmpty {
                                if let jsonData = dataBuffer.data(using: .utf8),
                                   let event = try? JSONDecoder().decode(StreamEvent.self, from: jsonData) {
                                    continuation.yield(event)
                                }
                                dataBuffer = ""
                            }
                            continue
                        }

                        if line.hasPrefix("data:") {
                            let value = line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
                            dataBuffer = dataBuffer.isEmpty ? value : dataBuffer + value
                        }
                        // Other SSE fields (event:, id:, retry:, `:` comments) are ignored -
                        // the API only ever sends unnamed `data:` events.
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}
