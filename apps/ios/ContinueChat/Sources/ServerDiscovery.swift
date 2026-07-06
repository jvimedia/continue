import Foundation
import Network

enum DiscoveryError: LocalizedError {
    case resolutionFailed

    var errorDescription: String? {
        switch self {
        case .resolutionFailed:
            return "Could not resolve the server's address"
        }
    }
}

/// Browses the local network for Chat API servers advertised by the VS Code
/// extension via Bonjour (`_continuejv._tcp`).
@MainActor
final class ServerDiscovery: ObservableObject {
    struct DiscoveredServer: Identifiable, Equatable {
        let id: String
        let name: String
        /// Workspace/project name advertised in the TXT record, so the list
        /// shows which VS Code window this is.
        let workspace: String?
        let endpoint: NWEndpoint

        static func == (lhs: DiscoveredServer, rhs: DiscoveredServer) -> Bool {
            lhs.id == rhs.id && lhs.workspace == rhs.workspace
        }
    }

    @Published private(set) var servers: [DiscoveredServer] = []
    @Published private(set) var isBrowsing = false

    private var browser: NWBrowser?

    func start() {
        stop()
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        let browser = NWBrowser(
            for: .bonjourWithTXTRecord(type: "_continuejv._tcp", domain: nil),
            using: parameters
        )
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let servers = results.compactMap { result -> DiscoveredServer? in
                guard case let .service(name, _, _, _) = result.endpoint else {
                    return nil
                }
                var workspace: String?
                if case let .bonjour(txtRecord) = result.metadata {
                    let value = txtRecord.dictionary["workspace"]
                    workspace = (value?.isEmpty ?? true) ? nil : value
                }
                return DiscoveredServer(
                    id: name,
                    name: name,
                    workspace: workspace,
                    endpoint: result.endpoint
                )
            }
            Task { @MainActor in
                self?.servers = servers.sorted { $0.name < $1.name }
            }
        }
        browser.start(queue: .main)
        self.browser = browser
        isBrowsing = true
    }

    func stop() {
        browser?.cancel()
        browser = nil
        isBrowsing = false
    }

    /// Resolve a Bonjour service endpoint to a concrete host/port by opening
    /// a short-lived TCP connection to it and reading the remote endpoint.
    nonisolated func resolve(_ endpoint: NWEndpoint) async throws -> (host: String, port: Int) {
        try await withCheckedThrowingContinuation { continuation in
            let connection = NWConnection(to: endpoint, using: .tcp)
            let hasResumed = ResumeGuard()
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard hasResumed.tryResume() else { return }
                    defer { connection.cancel() }
                    if let remote = connection.currentPath?.remoteEndpoint,
                       case let .hostPort(host, port) = remote {
                        let hostString: String
                        switch host {
                        case .ipv4(let address):
                            hostString = "\(address)"
                        case .ipv6(let address):
                            hostString = "\(address)"
                        case .name(let name, _):
                            hostString = name
                        @unknown default:
                            hostString = "\(host)"
                        }
                        // IP addresses can carry a scope suffix like "%en0"
                        let cleaned = hostString.components(separatedBy: "%").first ?? hostString
                        continuation.resume(returning: (cleaned, Int(port.rawValue)))
                    } else {
                        continuation.resume(throwing: DiscoveryError.resolutionFailed)
                    }
                case .failed(let error):
                    guard hasResumed.tryResume() else { return }
                    connection.cancel()
                    continuation.resume(throwing: error)
                case .cancelled:
                    guard hasResumed.tryResume() else { return }
                    continuation.resume(throwing: DiscoveryError.resolutionFailed)
                default:
                    break
                }
            }
            connection.start(queue: .main)
        }
    }
}

/// Ensures a checked continuation is resumed at most once across the
/// connection's state callbacks.
private final class ResumeGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    func tryResume() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if resumed {
            return false
        }
        resumed = true
        return true
    }
}
