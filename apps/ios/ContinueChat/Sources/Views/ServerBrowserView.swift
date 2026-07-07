import SwiftUI

/// Entry screen: pick a VS Code window. Servers are discovered via Bonjour
/// (showing which project/workspace each window has open) or entered
/// manually as host/URL + port.
struct ServerBrowserView: View {
    @StateObject private var discovery = ServerDiscovery()

    @State private var manualHost: String = ""
    @State private var manualPort: String = "65433"
    @State private var errorMessage: String?
    @State private var isResolving = false

    /// Set when a server was picked but has no stored token yet.
    @State private var tokenPrompt: PendingServer?
    @State private var tokenInput: String = ""

    /// Pushed to SessionListView once host/port/token are known.
    @State private var path = NavigationPath()

    struct PendingServer: Identifiable {
        let host: String
        let port: Int
        var id: String { "\(host):\(port)" }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                Section {
                    if discovery.servers.isEmpty {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Searching for open editors…")
                                .foregroundStyle(.secondary)
                                .font(.subheadline)
                        }
                    } else {
                        ForEach(discovery.servers) { server in
                            Button {
                                select(server)
                            } label: {
                                HStack {
                                    Image(systemName: "desktopcomputer")
                                        .foregroundStyle(.tint)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(server.workspace ?? server.name)
                                            .foregroundStyle(.primary)
                                        if server.workspace != nil {
                                            Text(server.name)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                    if isResolving {
                                        ProgressView()
                                    } else {
                                        Image(systemName: "chevron.right")
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                }
                            }
                            .disabled(isResolving)
                        }
                    }
                } header: {
                    Text("Open Editors")
                } footer: {
                    Text(
                        "Each VS Code window with the Chat API enabled shows up here. Enable \"Allow LAN Access\" and \"Bonjour Auto-Discovery\" under Settings → Remote Access in the Continue sidebar."
                    )
                }

                Section("Manual Connection") {
                    TextField("Host, IP, or URL", text: $manualHost)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Port", text: $manualPort)
                        .keyboardType(.numberPad)
                    Button("Connect") {
                        connectManually()
                    }
                    .disabled(manualHost.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.subheadline)
                    }
                }
            }
            .navigationTitle("Continue")
            .navigationDestination(for: ServerConnection.self) { connection in
                SessionListView(connection: connection)
            }
            .onAppear {
                if let last = ConnectionStore.loadLast() {
                    manualHost = last.host
                    manualPort = String(last.port)
                }
                discovery.start()
            }
            .onDisappear {
                discovery.stop()
            }
            .sheet(item: $tokenPrompt) { pending in
                tokenSheet(for: pending)
            }
        }
    }

    // MARK: Token entry

    private func tokenSheet(for pending: PendingServer) -> some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("API Token", text: $tokenInput)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text(
                        "Copy it from the Continue sidebar under Settings → Remote Access (or the \"Continue JV: Show Chat API Token\" command)."
                    )
                }
            }
            .navigationTitle("\(pending.host):\(String(pending.port))")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        tokenPrompt = nil
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        let connection = ServerConnection(
                            host: pending.host,
                            port: pending.port,
                            token: tokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        )
                        tokenPrompt = nil
                        open(connection)
                    }
                    .disabled(tokenInput.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: Actions

    private func open(_ connection: ServerConnection) {
        ConnectionStore.saveLast(connection)
        errorMessage = nil
        path.append(connection)
    }

    private func proceed(host: String, port: Int) {
        if let token = ConnectionStore.loadToken(host: host) {
            open(ServerConnection(host: host, port: port, token: token))
        } else {
            tokenInput = ""
            tokenPrompt = PendingServer(host: host, port: port)
        }
    }

    private func select(_ server: ServerDiscovery.DiscoveredServer) {
        errorMessage = nil
        isResolving = true
        Task {
            defer { isResolving = false }
            do {
                let (host, port) = try await discovery.resolve(server.endpoint)
                proceed(host: host, port: port)
            } catch {
                errorMessage =
                    "Could not resolve \(server.workspace ?? server.name): \(error.localizedDescription)"
            }
        }
    }

    private func connectManually() {
        errorMessage = nil
        var value = manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        var port = Int(manualPort)
        // Accept full URLs like http://192.168.1.20:65433 as well as bare hosts
        if value.contains("://"), let url = URL(string: value), let urlHost = url.host {
            port = url.port ?? port
            value = urlHost
        }
        if value.hasSuffix("/") {
            value.removeLast()
        }
        guard let port else {
            errorMessage = "Enter a valid port."
            return
        }
        let host = value
        isResolving = true
        Task {
            defer { isResolving = false }
            if let reachablePort = await findReachablePort(host: host, preferred: port) {
                if reachablePort != port {
                    manualPort = String(reachablePort)
                }
                proceed(host: host, port: reachablePort)
            } else {
                errorMessage =
                    "No Chat API server reachable at \(host). Check that the server is enabled with LAN access in VS Code."
            }
        }
    }

    /// Servers walk to the next free port when several VS Code windows are
    /// open, so if the entered port doesn't answer, scan the range around
    /// the default before giving up.
    private func findReachablePort(host: String, preferred: Int) async -> Int? {
        if await ApiClient.probeHealth(host: host, port: preferred) {
            return preferred
        }
        let basePort = 65433
        let candidates = (basePort ..< basePort + 10).filter { $0 != preferred }
        return await withTaskGroup(of: Int?.self) { group in
            for candidate in candidates {
                group.addTask {
                    await ApiClient.probeHealth(host: host, port: candidate)
                        ? candidate : nil
                }
            }
            var found: Int?
            for await result in group {
                if let result {
                    found = result
                    group.cancelAll()
                    break
                }
            }
            return found
        }
    }
}
