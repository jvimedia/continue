import SwiftUI

/// Renders a single timeline row. Continue's own chat panel is a linear,
/// full-width document rather than side-by-side chat bubbles: assistant text
/// renders as plain full-width text, while user turns render in a slightly
/// boxed, input-like block (mirroring `gui/src/` styling).
struct MessageRowView: View {
    @Environment(\.colorScheme) private var colorScheme
    let message: TimelineMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message.role == .user ? "You" : "Continue")
                .font(.caption.weight(.semibold))
                .foregroundColor(ContinueTheme.secondaryForeground(colorScheme))

            HStack(alignment: .top, spacing: 8) {
                Text(message.text.isEmpty && message.isStreaming ? "…" : message.text)
                    .font(.body)
                    .foregroundColor(
                        message.isError
                            ? ContinueTheme.error
                            : ContinueTheme.foreground(colorScheme)
                    )
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if message.isStreaming {
                    ProgressView()
                        .scaleEffect(0.7)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(rowBackground)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(message.role == .user ? ContinueTheme.border(colorScheme) : .clear, lineWidth: 1)
        )
        .cornerRadius(8)
    }

    private var rowBackground: Color {
        switch message.role {
        case .user:
            return ContinueTheme.inputBackground(colorScheme)
        case .assistant:
            return .clear
        }
    }
}

#Preview {
    VStack(spacing: 12) {
        MessageRowView(message: TimelineMessage(id: "1", turnId: "t1", role: .user, text: "What does this repo do?"))
        MessageRowView(message: TimelineMessage(id: "2", turnId: "t1", role: .assistant, text: "This repo is Continue, an open-source AI coding assistant…", isStreaming: true))
    }
    .padding()
    .background(Color.black)
}
