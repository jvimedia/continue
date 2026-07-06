import SwiftUI

/// Pick a server: either one discovered on the LAN via Bonjour, or an
/// explicitly entered host/URL and port. Plus the API token.
struct ConnectView: View {
    @ObservedObject var viewModel: ChatViewModel
    @StateObject private var discovery = ServerDiscovery()

    @State private var host: String = ""
    @State private var port: String = "65433"
    @State private var token: String = ""
    @State private var resolveError: String?
    @State private var isResolving = false

    var body: some View {
        Form {
            Section {
                if discovery.servers.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Searching for Continue on your network…")
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
                                Text(server.name)
                                Spacer()
                                if isResolving {
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(isResolving)
                    }
                }
            } header: {
                Text("Discovered Servers")
            } footer: {
                Text(
                    "Enable \"Allow LAN Access\" and \"Bonjour Auto-Discovery\" in the Continue JV settings in VS Code for the editor to show up here."
                )
            }

            Section("Manual Connection") {
                TextField("Host or IP (e.g. 192.168.1.20)", text: $host)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("Port", text: $port)
                    .keyboardType(.numberPad)
            }

            Section {
                SecureField("API Token", text: $token)
            } footer: {
                Text(
                    "Shown in the Continue sidebar under Settings → Remote Access, or via the \"Continue JV: Show Chat API Token\" command."
                )
            }

            if let error = errorText {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.subheadline)
                }
            }

            Section {
                Button {
                    connectManually()
                } label: {
                    if viewModel.state == .connecting {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Connecting…")
                        }
                    } else {
                        Text("Connect")
                    }
                }
                .disabled(!canConnect || viewModel.state == .connecting)
            }
        }
        .navigationTitle("Continue Chat")
        .onAppear {
            if let saved = ConnectionStore.load() {
                host = saved.host
                port = String(saved.port)
                token = saved.token
            }
            discovery.start()
        }
        .onDisappear {
            discovery.stop()
        }
    }

    private var canConnect: Bool {
        !host.trimmingCharacters(in: .whitespaces).isEmpty
            && Int(port) != nil
            && !token.isEmpty
    }

    private var errorText: String? {
        if let resolveError {
            return resolveError
        }
        if case .error(let message) = viewModel.state {
            return message
        }
        return nil
    }

    private func normalizedHost(_ input: String) -> (host: String, port: Int?) {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // Accept full URLs like http://192.168.1.20:65433 as well as bare hosts
        if value.contains("://"), let url = URL(string: value), let urlHost = url.host {
            return (urlHost, url.port)
        }
        if value.hasSuffix("/") {
            value.removeLast()
        }
        return (value, nil)
    }

    private func connectManually() {
        resolveError = nil
        let (parsedHost, parsedPort) = normalizedHost(host)
        guard let portNumber = parsedPort ?? Int(port) else {
            return
        }
        viewModel.connect(
            ServerConnection(host: parsedHost, port: portNumber, token: token)
        )
    }

    private func select(_ server: ServerDiscovery.DiscoveredServer) {
        resolveError = nil
        isResolving = true
        Task {
            defer { isResolving = false }
            do {
                let (resolvedHost, resolvedPort) = try await discovery.resolve(server.endpoint)
                host = resolvedHost
                port = String(resolvedPort)
                if !token.isEmpty {
                    viewModel.connect(
                        ServerConnection(
                            host: resolvedHost,
                            port: resolvedPort,
                            token: token
                        )
                    )
                } else {
                    resolveError = "Enter the API token to connect."
                }
            } catch {
                resolveError = "Could not resolve \(server.name): \(error.localizedDescription)"
            }
        }
    }
}
