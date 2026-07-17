import SwiftUI

/// Native settings screen with connection info, account, notifications, and unpair.
public struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @ObservedObject private var notificationManager = NotificationManager.shared
    @State private var analyticsEnabled = AnalyticsManager.shared.isEnabled
    @State private var showUnpairConfirmation = false
    @State private var showSignOutConfirmation = false
    @State private var showDeleteAccountConfirmation = false
    @State private var isDeletingAccount = false
    @State private var deleteAccountError: String?
    @State private var accountSwitchError: String?
    @Environment(\.dismiss) private var dismiss

    // Voice mode settings
    #if os(iOS)
    @State private var hasOpenAIApiKey = KeychainManager.getOpenAIApiKey() != nil
    @State private var voiceSettings = VoiceModeSettings.load()
    #endif

    public init() {}

    private var connectedDevices: [DeviceInfo] {
        appState.syncManager?.connectedDevices ?? []
    }

    public var body: some View {
        Form {
            connectionSection
            accountSection
            #if os(iOS)
            voiceModeSection
            notificationsSection
            analyticsSection
            #endif
            dangerSection
        }
        .navigationTitle("Settings")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.large)
        .task {
            await notificationManager.checkAuthorizationStatus()
        }
        #endif
    }

    // MARK: - Connection

    private var connectionSection: some View {
        Section("Connection") {
            HStack {
                Text("Status")
                Spacer()
                HStack(spacing: 6) {
                    Circle()
                        .fill(appState.isConnected ? NimbalystColors.success : NimbalystColors.textDisabled)
                        .frame(width: 8, height: 8)
                    Text(appState.isConnected ? "Connected" : "Disconnected")
                        .foregroundStyle(.secondary)
                }
            }

            if let serverUrl = KeychainManager.getServerUrl() {
                HStack {
                    Text("Server")
                    Spacer()
                    Text(serverUrl)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            if !connectedDevices.isEmpty {
                DisclosureGroup("Connected Devices (\(connectedDevices.count))") {
                    ForEach(connectedDevices, id: \.deviceId) { device in
                        HStack {
                            Image(systemName: deviceIcon(for: device.type))
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(device.name)
                                    .font(.body)
                                Text(device.platform)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section("Accounts") {
            ForEach(appState.accounts) { account in
                Button {
                    do {
                        try appState.switchAccount(to: account.id)
                    } catch {
                        accountSwitchError = error.localizedDescription
                    }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(account.email.isEmpty ? "Paired account" : account.email)
                                .foregroundStyle(.primary)
                            Text(account.personalOrgId)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        Spacer()
                        if account.id == appState.activeAccountId {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(NimbalystColors.success)
                        }
                    }
                }
                .disabled(account.id == appState.activeAccountId)
            }

            NavigationLink {
                PairingView()
                    .environmentObject(appState)
            } label: {
                Label("Add Account", systemImage: "person.badge.plus")
            }

            if let accountSwitchError {
                Text(accountSwitchError)
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.error)
            }
        }
    }

    // MARK: - Notifications

    #if os(iOS)
    private var notificationsSection: some View {
        Section {
            Toggle("Push Notifications", isOn: Binding(
                get: { notificationManager.isPushEnabledInApp },
                set: { newValue in
                    Task {
                        if newValue {
                            notificationManager.markPromptShown()
                        }
                        _ = await notificationManager.setPushNotificationsEnabled(newValue)
                    }
                }
            ))
        } header: {
            Text("Notifications")
        } footer: {
            Text(notificationFooterText)
        }
    }

    private var notificationFooterText: String {
        switch notificationManager.authorizationStatus {
        case .denied:
            return "Push is denied in iOS Settings. Turning this on opens the app's Settings page so you can allow notifications."
        case .authorized, .provisional, .ephemeral:
            return "Get notified when AI sessions complete or need your attention."
        case .notDetermined:
            return "Get notified when AI sessions complete or need your attention."
        @unknown default:
            return "Get notified when AI sessions complete or need your attention."
        }
    }
    #endif

    // MARK: - Voice Mode

    #if os(iOS)
    // Full GA Realtime voice list (desktop parity); marin and cedar are the
    // gpt-realtime-2 flagship voices.
    private static let voiceOptions = [
        "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse",
        "marin", "cedar",
    ]

    private var voiceModeSection: some View {
        Section {
            // API Key (synced from desktop)
            HStack {
                Text("OpenAI API Key")
                Spacer()
                if hasOpenAIApiKey {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(NimbalystColors.success)
                        Text("Synced from desktop")
                            .foregroundStyle(.secondary)
                    }
                    .font(.caption)
                } else {
                    Text("Not synced yet")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .init("OpenAIApiKeySynced"))) { _ in
                hasOpenAIApiKey = KeychainManager.getOpenAIApiKey() != nil
            }

            // Voice picker
            Picker("Voice", selection: $voiceSettings.voice) {
                ForEach(Self.voiceOptions, id: \.self) { voice in
                    Text(voice.capitalized).tag(voice)
                }
            }
            .onChange(of: voiceSettings.voice) { _ in saveVoiceSettings() }

            // Idle timeout
            Stepper(
                "Idle Timeout: \(Int(voiceSettings.idleTimeout))s",
                value: $voiceSettings.idleTimeout,
                in: 10...120,
                step: 10
            )
            .onChange(of: voiceSettings.idleTimeout) { _ in saveVoiceSettings() }

            // Auto-announce completions
            Toggle("Auto-Announce Completions", isOn: $voiceSettings.autoAnnounceCompletions)
                .onChange(of: voiceSettings.autoAnnounceCompletions) { _ in saveVoiceSettings() }

            // Prompt confirmation delay
            Stepper(
                "Confirm Delay: \(Int(voiceSettings.promptConfirmationDelay))s",
                value: $voiceSettings.promptConfirmationDelay,
                in: 1...10,
                step: 1
            )
            .onChange(of: voiceSettings.promptConfirmationDelay) { _ in saveVoiceSettings() }
        } header: {
            Text("Voice Mode")
        } footer: {
            Text("Voice mode uses OpenAI's Realtime API for voice-to-voice conversations. The API key is synced from your desktop app's OpenAI settings.")
        }
    }

    private func saveVoiceSettings() {
        voiceSettings.save()
        appState.voiceAgent?.settings = voiceSettings
    }
    #endif

    // MARK: - Analytics

    #if os(iOS)
    private var analyticsSection: some View {
        Section {
            Toggle("Usage Analytics", isOn: $analyticsEnabled)
                .onChange(of: analyticsEnabled) { newValue in
                    if newValue {
                        AnalyticsManager.shared.optIn()
                    } else {
                        AnalyticsManager.shared.optOut()
                    }
                }

            Link(destination: URL(string: "https://nimbalyst.com/privacy-policy")!) {
                HStack {
                    Text("Privacy Policy")
                    Spacer()
                    Image(systemName: "arrow.up.right.square")
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Privacy")
        } footer: {
            Text("Anonymous usage analytics help improve Nimbalyst. No session content or file paths are ever collected.")
        }
    }
    #endif

    // MARK: - Danger Zone

    private var dangerSection: some View {
        Section {
            // Sign out -- clears Stytch auth but keeps the device pairing and
            // encryption seed in Keychain. Routes the user to LoginView where
            // they can sign in again without re-pairing. Use this when sync
            // fails with auth errors that don't auto-recover (e.g. JWT signed
            // with a now-rotated key).
            if appState.authManager.isAuthenticated {
                Button {
                    showSignOutConfirmation = true
                } label: {
                    HStack {
                        Image(systemName: "rectangle.portrait.and.arrow.right")
                        Text("Sign Out")
                    }
                }
                .confirmationDialog(
                    "Sign out?",
                    isPresented: $showSignOutConfirmation,
                    titleVisibility: .visible
                ) {
                    Button("Sign Out", role: .destructive) {
                        appState.syncManager?.disconnect()
                        appState.authManager.logout()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("You'll need to sign in again. Pairing and synced data are kept on this device.")
                }
            }

            Button(role: .destructive) {
                showUnpairConfirmation = true
            } label: {
                HStack {
                    Image(systemName: "link.badge.plus")
                        .symbolRenderingMode(.multicolor)
                    Text("Unpair Device")
                }
            }
            .confirmationDialog(
                "Unpair this device?",
                isPresented: $showUnpairConfirmation,
                titleVisibility: .visible
            ) {
                Button("Unpair", role: .destructive) {
                    appState.unpair()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will remove all synced data from this device. You can re-pair later by scanning a new QR code.")
            }

            if appState.authManager.isAuthenticated {
                Button(role: .destructive) {
                    showDeleteAccountConfirmation = true
                } label: {
                    HStack {
                        if isDeletingAccount {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "trash")
                        }
                        Text("Delete Account")
                    }
                }
                .disabled(isDeletingAccount)
                .confirmationDialog(
                    "Delete your account?",
                    isPresented: $showDeleteAccountConfirmation,
                    titleVisibility: .visible
                ) {
                    Button("Delete Account", role: .destructive) {
                        Task {
                            await performAccountDeletion()
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This will permanently delete your account and all synced data, including sessions, shared links, and device pairings. This cannot be undone.")
                }
            }

            if let error = deleteAccountError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private func performAccountDeletion() async {
        guard let serverUrl = KeychainManager.getServerUrl() else {
            deleteAccountError = "No server URL configured"
            return
        }

        isDeletingAccount = true
        deleteAccountError = nil

        let result = await appState.authManager.deleteAccount(serverUrl: serverUrl)

        await MainActor.run {
            isDeletingAccount = false
            if result.success {
                appState.unpair()
            } else {
                deleteAccountError = result.error ?? "Account deletion failed"
            }
        }
    }

    // MARK: - Helpers

    private func deviceIcon(for type: String) -> String {
        switch type {
        case "desktop": return "desktopcomputer"
        case "mobile": return "iphone"
        case "tablet": return "ipad"
        default: return "display"
        }
    }
}
