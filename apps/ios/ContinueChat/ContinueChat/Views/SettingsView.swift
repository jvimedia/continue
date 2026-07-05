import SwiftUI

/// Onboarding / settings screen for entering the Continue Chat API's base URL
/// and bearer token. Reachable both as the first-launch screen and later via
/// the gear icon on the chat screen.
struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    /// When true this is being shown as a dismissible sheet from the chat
    /// screen rather than as the mandatory first-launch flow.
    var isDismissable: Bool = false

    @State private var baseURLText: String = ""
    @State private var tokenText: String = ""
    @State private var isTesting = false
    @State private var testResultMessage: String?
    @State private var testSucceeded = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Server URL")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(ContinueTheme.foreground(colorScheme))
                        TextField("http://127.0.0.1:65432", text: $baseURLText)
                            .textFieldStyle(.plain)
                            .padding(12)
                            .background(ContinueTheme.inputBackground(colorScheme))
                            .cornerRadius(8)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(ContinueTheme.border(colorScheme), lineWidth: 1)
                            )
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Text("The machine running VS Code. Use \"http://localhost:65432\" for the iOS Simulator, or the Mac's LAN IP for a physical device.")
                            .font(.caption)
                            .foregroundColor(ContinueTheme.secondaryForeground(colorScheme))
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("API Token")
                            .font(.subheadline.weight(.semibold))
                            .foregroundColor(ContinueTheme.foreground(colorScheme))
                        SecureField("Paste token from \"Continue: Show Chat API Token\"", text: $tokenText)
                            .textFieldStyle(.plain)
                            .padding(12)
                            .background(ContinueTheme.inputBackground(colorScheme))
                            .cornerRadius(8)
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(ContinueTheme.border(colorScheme), lineWidth: 1)
                            )
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    if let testResultMessage {
                        Text(testResultMessage)
                            .font(.footnote)
                            .foregroundColor(testSucceeded ? ContinueTheme.success : ContinueTheme.error)
                    }

                    VStack(spacing: 12) {
                        Button(action: testConnection) {
                            HStack {
                                if isTesting {
                                    ProgressView()
                                        .tint(ContinueTheme.primaryForeground)
                                }
                                Text(isTesting ? "Testing…" : "Test Connection")
                                    .fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                        }
                        .background(canTest ? ContinueTheme.primary : ContinueTheme.primary.opacity(0.5))
                        .foregroundColor(ContinueTheme.primaryForeground)
                        .cornerRadius(8)
                        .disabled(!canTest || isTesting)

                        Button(action: save) {
                            Text("Save")
                                .fontWeight(.semibold)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                        }
                        .background(ContinueTheme.inputBackground(colorScheme))
                        .foregroundColor(ContinueTheme.foreground(colorScheme))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(ContinueTheme.border(colorScheme), lineWidth: 1)
                        )
                        .cornerRadius(8)
                        .disabled(!canSave)
                    }
                }
                .padding(20)
            }
            .background(ContinueTheme.background(colorScheme).ignoresSafeArea())
            .navigationTitle("Connect to Continue")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if isDismissable {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
            }
        }
        .onAppear {
            baseURLText = settings.baseURLString
            tokenText = settings.token
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Continue Chat")
                .font(.title2.weight(.bold))
                .foregroundColor(ContinueTheme.foreground(colorScheme))
            Text("Enter the local Chat API address shown by VS Code (Settings → continue.chatApi) and the token from \"Continue: Show Chat API Token\".")
                .font(.footnote)
                .foregroundColor(ContinueTheme.secondaryForeground(colorScheme))
        }
    }

    private var canTest: Bool {
        URL(string: baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
    }

    private var canSave: Bool {
        canTest && !tokenText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func testConnection() {
        let trimmedURL = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmedURL) else { return }

        isTesting = true
        testResultMessage = nil

        Task {
            let client = ContinueAPIClient(config: APIConfig(baseURL: url, token: trimmedToken))
            do {
                let healthy = try await client.checkHealth()
                guard healthy else {
                    throw APIError.invalidResponse
                }
                _ = try await client.fetchSession()
                await MainActor.run {
                    testSucceeded = true
                    testResultMessage = "Connected successfully."
                    isTesting = false
                }
            } catch {
                await MainActor.run {
                    testSucceeded = false
                    testResultMessage = "Couldn't connect: \(error.localizedDescription)"
                    isTesting = false
                }
            }
        }
    }

    private func save() {
        settings.baseURLString = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.token = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
        if isDismissable {
            dismiss()
        }
    }
}

#Preview {
    SettingsView()
        .environmentObject(AppSettings())
}
