import SwiftUI

/// Shows what's going on in one VS Code window: the session currently open
/// in the sidebar plus recent sessions, any of which can be joined.
struct SessionListView: View {
    let connection: ServerConnection

    @State private var info: ServerInfo?
    @State private var sessions: [SessionMeta] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    private var client: ApiClient {
        ApiClient(connection: connection)
    }

    var body: some View {
        List {
            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                        .font(.subheadline)
                    Button("Retry") {
                        Task { await load() }
                    }
                }
            }

            Section {
                // Follow the sidebar: no sessionId means the remote GUI shows
                // whatever the editor currently has open.
                NavigationLink {
                    GuiView(connection: connection, sessionId: nil)
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Current Session")
                            if let current = currentSession {
                                Text(current.title)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    } icon: {
                        Image(systemName: "rectangle.on.rectangle")
                            .foregroundStyle(.tint)
                    }
                }
            } header: {
                if let workspaceName = info?.workspaceName, !workspaceName.isEmpty {
                    Text(workspaceName)
                } else {
                    Text("\(connection.host):\(String(connection.port))")
                }
            }

            Section("Sessions") {
                if isLoading {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading sessions…")
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                    }
                } else if sessions.isEmpty {
                    Text("No sessions yet")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(sessions) { session in
                        NavigationLink {
                            GuiView(connection: connection, sessionId: session.sessionId)
                        } label: {
                            sessionRow(session)
                        }
                    }
                }
            }
        }
        .navigationTitle(info?.workspaceName ?? "Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable {
            await load()
        }
        .task {
            await load()
        }
    }

    private var currentSession: SessionMeta? {
        guard let currentId = info?.currentSessionId else {
            return nil
        }
        return sessions.first { $0.sessionId == currentId }
    }

    private func sessionRow(_ session: SessionMeta) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                if session.sessionId == info?.currentSessionId {
                    Circle()
                        .fill(.green)
                        .frame(width: 7, height: 7)
                }
                Text(session.title.isEmpty ? "Untitled" : session.title)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                if let date = session.date {
                    Text(date, style: .relative)
                }
                if let dir = session.workspaceDirectory, !dir.isEmpty {
                    Text((dir as NSString).lastPathComponent)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        errorMessage = nil
        do {
            async let infoTask = client.info()
            async let sessionsTask = client.sessions()
            let (loadedInfo, loadedSessions) = try await (infoTask, sessionsTask)
            info = loadedInfo
            // Newest first; dateCreated sorting handles both formats via `date`
            sessions = loadedSessions.sorted {
                ($0.date ?? .distantPast) > ($1.date ?? .distantPast)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
