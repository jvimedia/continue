import Foundation
import Security

/// Where the Chat API server lives and how to authenticate against it.
struct ServerConnection: Equatable {
    var host: String
    var port: Int
    var token: String

    private var bracketedHost: String {
        host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    }

    var baseURL: URL? {
        URL(string: "http://\(bracketedHost):\(port)")
    }

    var webSocketURL: URL? {
        let encodedToken = token.addingPercentEncoding(
            withAllowedCharacters: .urlQueryAllowed
        ) ?? token
        return URL(string: "ws://\(bracketedHost):\(port)/ws?token=\(encodedToken)")
    }
}

/// Persists the last-used connection: host/port in UserDefaults, token in
/// the Keychain.
enum ConnectionStore {
    private static let hostKey = "chatApi.host"
    private static let portKey = "chatApi.port"
    private static let tokenService = "me.valouch.continuechat.apiToken"

    static func load() -> ServerConnection? {
        let defaults = UserDefaults.standard
        guard let host = defaults.string(forKey: hostKey), !host.isEmpty else {
            return nil
        }
        let port = defaults.integer(forKey: portKey)
        return ServerConnection(
            host: host,
            port: port > 0 ? port : 65433,
            token: loadToken() ?? ""
        )
    }

    static func save(_ connection: ServerConnection) {
        let defaults = UserDefaults.standard
        defaults.set(connection.host, forKey: hostKey)
        defaults.set(connection.port, forKey: portKey)
        saveToken(connection.token)
    }

    // MARK: Keychain

    private static var tokenQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: tokenService,
        ]
    }

    private static func loadToken() -> String? {
        var query = tokenQuery
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

    private static func saveToken(_ token: String) {
        SecItemDelete(tokenQuery as CFDictionary)
        guard !token.isEmpty, let data = token.data(using: .utf8) else {
            return
        }
        var query = tokenQuery
        query[kSecValueData as String] = data
        SecItemAdd(query as CFDictionary, nil)
    }
}
