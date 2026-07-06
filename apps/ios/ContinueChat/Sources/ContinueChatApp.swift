import SwiftUI

@main
struct ContinueChatApp: App {
    @StateObject private var viewModel = ChatViewModel()

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if showChat {
                    ChatView(viewModel: viewModel)
                } else {
                    ConnectView(viewModel: viewModel)
                }
            }
        }
    }

    private var showChat: Bool {
        switch viewModel.state {
        case .connected, .connecting:
            return true
        case .error:
            // Stay on the chat screen for transient drops after a successful
            // connection; ConnectView also surfaces the error if we never
            // connected (no messages yet).
            return !viewModel.messages.isEmpty
        case .disconnected:
            return false
        }
    }
}
