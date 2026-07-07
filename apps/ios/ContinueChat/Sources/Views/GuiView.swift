import SwiftUI
import WebKit

/// The actual Continue sidebar GUI, served by the extension and rendered in
/// a WKWebView - identical markdown, mode selector, model picker, session
/// tabs, and settings, because it *is* the same app the sidebar runs.
struct GuiView: View {
    @State private var connection: ServerConnection
    let sessionId: String?

    @State private var isLoading = true
    @State private var reloadCounter = 0
    @State private var showTokenPrompt = false
    @State private var tokenInput = ""

    init(connection: ServerConnection, sessionId: String?) {
        _connection = State(initialValue: connection)
        self.sessionId = sessionId
    }

    var body: some View {
        ZStack {
            if let url = connection.guiURL(sessionId: sessionId) {
                WebView(
                    url: url,
                    reloadCounter: reloadCounter,
                    isLoading: $isLoading,
                    onUnauthorized: {
                        tokenInput = ""
                        showTokenPrompt = true
                    }
                )
                .ignoresSafeArea(edges: .bottom)
                .id(url) // recreate the webview when the token changes
            } else {
                Text("Invalid server address")
                    .foregroundStyle(.secondary)
            }
            if isLoading {
                ProgressView()
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    reloadCounter += 1
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
            }
        }
        // Agent runs can take minutes with no touches - don't let the
        // screen lock kill the connection mid-stream.
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .alert("API token rejected", isPresented: $showTokenPrompt) {
            SecureField("New API Token", text: $tokenInput)
            Button("Save & Retry") {
                let token = tokenInput.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !token.isEmpty else { return }
                ConnectionStore.saveToken(token, host: connection.host)
                connection.token = token
                isLoading = true
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "The stored token for \(connection.host) was rejected. Paste the current one from Settings → Remote Access in the Continue sidebar."
            )
        }
    }
}

private struct WebView: UIViewRepresentable {
    let url: URL
    let reloadCounter: Int
    @Binding var isLoading: Bool
    let onUnauthorized: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(isLoading: $isLoading, onUnauthorized: onUnauthorized)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        // The GUI manages its own scrolling; rubber-banding the whole page
        // just makes it feel like a website instead of an app.
        webView.scrollView.bounces = false
        #if DEBUG
            if #available(iOS 16.4, *) {
                webView.isInspectable = true
            }
        #endif
        webView.load(URLRequest(url: url))
        context.coordinator.lastReloadCounter = reloadCounter
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastReloadCounter != reloadCounter {
            context.coordinator.lastReloadCounter = reloadCounter
            isLoading = true
            webView.reload()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        @Binding var isLoading: Bool
        let onUnauthorized: () -> Void
        var lastReloadCounter = 0

        init(isLoading: Binding<Bool>, onUnauthorized: @escaping () -> Void) {
            _isLoading = isLoading
            self.onUnauthorized = onUnauthorized
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isLoading = false
        }

        func webView(
            _ webView: WKWebView,
            didFail navigation: WKNavigation!,
            withError error: Error
        ) {
            isLoading = false
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            isLoading = false
        }

        /// WebKit kills background content processes under memory pressure;
        /// without this the user comes back to a blank white view.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            isLoading = true
            webView.reload()
        }

        /// A rejected/rotated token otherwise renders as a blank page with a
        /// terse 401 body - surface it as a token re-entry prompt instead.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse
        ) async -> WKNavigationResponsePolicy {
            if navigationResponse.isForMainFrame,
               let http = navigationResponse.response as? HTTPURLResponse,
               http.statusCode == 401 {
                isLoading = false
                onUnauthorized()
                return .cancel
            }
            return .allow
        }

        // Keep the GUI itself in the webview, but hand links it opens (docs,
        // "open in browser" actions) to Safari.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            guard let url = navigationAction.request.url else {
                return .allow
            }
            let isSameServer =
                url.host == webView.url?.host && url.port == webView.url?.port
            if navigationAction.navigationType == .linkActivated && !isSameServer {
                await UIApplication.shared.open(url)
                return .cancel
            }
            return .allow
        }
    }
}
