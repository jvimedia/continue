import SwiftUI

/// Root view: shows the onboarding/settings screen until a server URL and
/// token are configured, then shows the chat screen. Keyed by the current
/// config so that saving new settings from within the app (via the chat
/// screen's gear button) tears down and rebuilds the chat session/client
/// cleanly against the new server.
struct ContentView: View {
    @EnvironmentObject private var settings: AppSettings

    var body: some View {
        Group {
            if settings.isConfigured, let config = settings.makeConfig() {
                ChatView(client: ContinueAPIClient(config: config))
                    .id("\(config.baseURL.absoluteString)|\(config.token)")
            } else {
                SettingsView()
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppSettings())
}
