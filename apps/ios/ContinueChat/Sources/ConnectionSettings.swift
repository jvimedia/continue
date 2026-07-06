import Foundation
import Security

/// Where a Chat API server lives and how to authenticate against it.
struct ServerConnection: Hashable {
    var host: String
    var port: Int
    var token: String

    private var bracketedHost: String {
        host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    }

    var baseURL: URL? {
        URL(string: "http://\(bracketedHost):\(port)")
    }

    /// The remote GUI page - the actual Continue sidebar app served by the
    /// extension. `sessionId` opens a specific session after loading.
    func guiURL(sessionId: String? = nil) -> URL? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = host
        components.port = port
        components.path = "/gui/"
        var items = [URLQueryItem(name: "token", value: token)]
        if let sessionId {
            items.append(URLQueryItem(name: "sessionId", value: sessionId))
        }
        components.queryItems = items
        return components.url
    }
}

/// Persists known servers: host/port of the last used server in
/// UserDefaults, API tokens per server in the Keychain.
enum ConnectionStore {
    private static let hostKey = "chatApi.host"
    private static let portKey = "chatApi.port"
    private static let tokenService = "me.valouch.continuechat.apiToken"

    static func loadLast() -> (host: String, port: Int)? {
        let defaults = UserDefaults.standard
        guard let host = defaults.string(forKey: hostKey), !host.isEmpty else {
            return nil
        }
        let port = defaults.integer(forKey: portKey)
        return (host, port > 0 ? port : 65433)
    }

    static func saveLast(_ connection: ServerConnection) {
        let defaults = UserDefaults.standard
        defaults.set(connection.host, forKey: hostKey)
        defaults.set(connection.port, forKey: portKey)
        saveToken(connection.token, host: connection.host, port: connection.port)
    }

    // MARK: Keychain (one entry per server, account = "host:port")

    private static func tokenQuery(host: String, port: Int) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
            kSecAttrAccount as String: "\(host):\(port)",
        ]
    }

    static func loadToken(host: String, port: Int) -> String? {
        var query = tokenQuery(host: host, port: port)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    static func saveToken(_ token: String, host: String, port: Int) {
        let query = tokenQuery(host: host, port: port)
        SecItemDelete(query as CFDictionary)
        guard !token.isEmpty, let data = token.data(using: .utf8) else {
            return
        }
        var addQuery = query
        addQuery[kSecValueData as String] = data
        SecItemAdd(addQuery as CFDictionary, nil)
    }
}
