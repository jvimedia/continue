import SwiftUI
import WebKit

/// The actual Continue sidebar GUI, served by the extension and rendered in
/// a WKWebView - identical markdown, mode selector, model picker, session
/// tabs, and settings, because it *is* the same app the sidebar runs.
struct GuiView: View {
    let connection: ServerConnection
    let sessionId: String?

    @State private var isLoading = true
    @State private var reloadCounter = 0

    var body: some View {
        ZStack {
            if let url = connection.guiURL(sessionId: sessionId) {
                WebView(url: url, reloadCounter: reloadCounter, isLoading: $isLoading)
                    .ignoresSafeArea(edges: .bottom)
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
    }
}

private struct WebView: UIViewRepresentable {
    let url: URL
    let reloadCounter: Int
    @Binding var isLoading: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(isLoading: $isLoading)
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
        var lastReloadCounter = 0

        init(isLoading: Binding<Bool>) {
            _isLoading = isLoading
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
