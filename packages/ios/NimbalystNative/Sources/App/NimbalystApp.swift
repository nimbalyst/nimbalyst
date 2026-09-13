import SwiftUI

#if canImport(UIKit)
import UIKit

/// Invisible UIView overlay that intercepts all touches to report user activity
/// for device presence tracking. Passes all touches through without consuming them.
/// This mirrors how the Electron app uses document-level event listeners.
class ActivityTrackingView: UIView {
    var onActivity: (() -> Void)?

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // Report activity on any touch, then return nil to pass through
        onActivity?()
        return nil
    }
}

/// SwiftUI wrapper for the activity tracking overlay.
struct ActivityTrackingOverlay: UIViewRepresentable {
    let onActivity: () -> Void

    func makeUIView(context: Context) -> ActivityTrackingView {
        let view = ActivityTrackingView()
        view.onActivity = onActivity
        view.isUserInteractionEnabled = true
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ uiView: ActivityTrackingView, context: Context) {
        uiView.onActivity = onActivity
    }
}
#endif

/// Root content view that handles navigation based on pairing and auth state.
public struct ContentView: View {
    @EnvironmentObject var appState: AppState

    public init() {}

    public var body: some View {
        Group {
            if appState.accountStorageNeedsRepair {
                AccountStorageRepairView()
            } else if !appState.isPaired {
                PairingView()
            } else if !appState.authManager.isAuthenticated {
                LoginView()
            } else {
                MainNavigationView()
            }
        }
        .preferredColorScheme(.dark)
        #if canImport(UIKit)
        .overlay {
            // Invisible overlay that reports user activity on any touch.
            // Throttling is handled inside WebSocketClient.reportActivity().
            ActivityTrackingOverlay {
                appState.syncManager?.reportUserActivity()
            }
            .allowsHitTesting(true)
        }
        #endif
    }
}

/// Blocks normal pairing when an existing account blob is unreadable. Resetting
/// is deliberately explicit because it permanently removes the preserved data.
private struct AccountStorageRepairView: View {
    @EnvironmentObject var appState: AppState
    @State private var confirmingReset = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 56))
                .foregroundStyle(NimbalystColors.warning)

            Text("Account Data Needs Repair")
                .font(.title2)
                .fontWeight(.bold)

            Text("Your stored account record could not be read. It has been preserved and was not treated as a signed-out account. Reset only if you are ready to pair this device again.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button("Reset and Pair Again", role: .destructive) {
                confirmingReset = true
            }
            .buttonStyle(.bordered)

            Spacer()
        }
        .confirmationDialog(
            "Reset stored account data?",
            isPresented: $confirmingReset,
            titleVisibility: .visible
        ) {
            Button("Reset Account Data", role: .destructive) {
                appState.unpair()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the preserved account record from this device. You will need to pair again from the desktop app.")
        }
    }
}

/// Login screen shown after pairing but before authentication.
/// Offers Google OAuth and email magic link sign-in.
/// The paired email (from QR code) determines which account to use.
public struct LoginView: View {
    @EnvironmentObject var appState: AppState
    @State private var accountSwitchError: String?

    private var pairedEmail: String? {
        if let email = KeychainManager.getUserId(), email.contains("@") {
            return email
        }
        return nil
    }

    public init() {}

    public var body: some View {
        let _ = NSLog("[LoginView] getUserId=\(KeychainManager.getUserId() ?? "nil"), pairedEmail=\(pairedEmail ?? "nil")")
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "person.crop.circle.badge.checkmark")
                .font(.system(size: 64))
                .foregroundStyle(NimbalystColors.primary)

            Text("Sign In")
                .font(.title)
                .fontWeight(.bold)

            if let pairedEmail {
                Text("Sign in as **\(pairedEmail)** to sync with the desktop app.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            } else {
                Text("Sign in with the same account you use on the desktop app to sync your sessions.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            #if os(iOS)
            if appState.authManager.magicLinkSent {
                // Waiting for user to tap the link in their email
                magicLinkSentView
            } else {
                // Sign-in buttons
                VStack(spacing: 12) {
                    Button {
                        guard let serverUrl = KeychainManager.getServerUrl() else { return }
                        appState.authManager.login(serverUrl: serverUrl)
                    } label: {
                        HStack(spacing: 8) {
                            if appState.authManager.isAuthenticating {
                                ProgressView()
                                    .tint(.white)
                            }
                            Text(appState.authManager.isAuthenticating ? "Signing in..." : "Sign in with Google")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(NimbalystColors.primary)
                        .foregroundStyle(.white)
                        .cornerRadius(12)
                    }
                    .disabled(appState.authManager.isAuthenticating)

                    if let email = pairedEmail {
                        Button {
                            guard let serverUrl = KeychainManager.getServerUrl() else { return }
                            appState.authManager.sendMagicLink(email: email, serverUrl: serverUrl)
                        } label: {
                            HStack(spacing: 8) {
                                if appState.authManager.isAuthenticating {
                                    ProgressView()
                                        .tint(NimbalystColors.primary)
                                }
                                Text(appState.authManager.isAuthenticating ? "Sending..." : "Sign in with email link")
                                    .fontWeight(.semibold)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                            .background(Color.clear)
                            .foregroundStyle(NimbalystColors.primary)
                            .overlay(
                                RoundedRectangle(cornerRadius: 12)
                                    .stroke(NimbalystColors.primary, lineWidth: 1.5)
                            )
                        }
                        .disabled(appState.authManager.isAuthenticating)
                    }
                }
                .padding(.horizontal, 32)
            }
            #endif

            if let error = appState.authManager.authError {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(NimbalystColors.warning)
                    Text(error)
                        .foregroundStyle(.secondary)
                }
                .font(.callout)
                .padding(12)
                .frame(maxWidth: .infinity)
                .background(NimbalystColors.warning.opacity(0.1))
                .cornerRadius(8)
                .padding(.horizontal, 32)
            }

            if appState.accounts.count > 1 {
                Menu {
                    ForEach(appState.accounts) { account in
                        Button {
                            do {
                                try appState.switchAccount(to: account.id)
                            } catch {
                                accountSwitchError = error.localizedDescription
                            }
                        } label: {
                            if account.id == appState.activeAccountId {
                                Label(account.email, systemImage: "checkmark")
                            } else {
                                Text(account.email)
                            }
                        }
                    }
                } label: {
                    Label("Switch Account", systemImage: "person.2")
                }
                .buttonStyle(.bordered)
            }

            if let accountSwitchError {
                Text(accountSwitchError)
                    .font(.caption)
                    .foregroundStyle(NimbalystColors.error)
                    .padding(.horizontal, 32)
            }

            Spacer()

            Button("Unpair Device") {
                appState.unpair()
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.bottom, 24)
        }
    }

    #if os(iOS)
    private var magicLinkSentView: some View {
        VStack(spacing: 16) {
            Image(systemName: "envelope.badge")
                .font(.system(size: 36))
                .foregroundStyle(NimbalystColors.success)

            Text("Check your email")
                .font(.headline)

            if let email = pairedEmail {
                Text("We sent a sign-in link to **\(email)**. Tap the link in your email to continue.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Button("Resend link") {
                guard let email = pairedEmail,
                      let serverUrl = KeychainManager.getServerUrl() else { return }
                appState.authManager.magicLinkSent = false
                appState.authManager.sendMagicLink(email: email, serverUrl: serverUrl)
            }
            .font(.callout)
            .foregroundStyle(NimbalystColors.primary)
            .padding(.top, 4)

            Button("Use a different sign-in method") {
                appState.authManager.magicLinkSent = false
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.top, 4)
        }
        .padding(.horizontal, 32)
    }
    #endif
}

/// One navigation history on iPhone and iPad, independent of size class and rotation.
/// The session sidebar expands beside the detail when space permits.
public struct MainNavigationView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.openURL) private var openURL
    @StateObject private var navigation: WorkspaceNavigationState
    @State private var showNotificationPrompt = false
    @State private var showVoiceSettings = false
    @ObservedObject private var notificationManager = NotificationManager.shared

    public init(project: Project? = nil) {
        _navigation = StateObject(wrappedValue: WorkspaceNavigationState(project: project))
    }

    public var body: some View {
        VStack(spacing: 0) {
            if appState.syncAuthDegraded {
                SyncAuthDegradedBanner {
                    appState.signOutForAuthRecovery()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            WorkspaceNavigationView(navigation: navigation)
        }
        .animation(.easeInOut(duration: 0.25), value: appState.syncAuthDegraded)
        #if os(iOS)
        .overlay(alignment: .bottom) {
            if let voice = appState.voiceAgent, voice.state != .disconnected {
                VoiceOverlay(voiceAgent: voice)
                    .padding(.bottom, 8)
            }
        }
        #endif
        .onChange(of: notificationManager.pendingSessionId) { _, newValue in
            guard let sessionId = newValue else { return }
            navigateToSession(sessionId)
            notificationManager.pendingSessionId = nil
        }
        #if os(iOS)
        // Voice-created sessions use the same route as notification taps.
        .onChange(of: appState.voiceNavigationRequest) { _, newValue in
            guard let sessionId = newValue else { return }
            navigateToSession(sessionId)
            appState.voiceNavigationRequest = nil
        }
        #endif
        .onAppear {
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
            AnalyticsManager.shared.capture("mobile_app_opened", properties: [
                "platform": "ios",
                "$set": ["nimbalyst_mobile_version": version],
            ])

            // Handle notification tap that launched the app
            if let sessionId = notificationManager.pendingSessionId {
                navigateToSession(sessionId)
                notificationManager.pendingSessionId = nil
            }

            // Show one-time push notification prompt after pairing + auth
            if notificationManager.shouldPromptForNotifications {
                // Small delay so the main view finishes rendering first
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    showNotificationPrompt = true
                }
            }
        }
        .alert("Enable Notifications?", isPresented: $showNotificationPrompt) {
            Button("Enable") {
                notificationManager.markPromptShown()
                Task {
                    _ = await notificationManager.requestPermission()
                }
            }
            Button("Not Now", role: .cancel) {
                notificationManager.markPromptShown()
            }
        } message: {
            Text("Get notified when your AI sessions complete or need your attention, even when Nimbalyst is in the background.")
        }
        .alert("Unable to Decrypt Sessions", isPresented: $appState.needsRepair) {
            Button("Re-pair Now") {
                appState.unpair()
            }
            Button("Dismiss", role: .cancel) {}
        } message: {
            Text("None of the sessions in a full sync could be decrypted with this device's key. If this continues, you may need to re-pair by scanning the QR code from the desktop app's settings.")
        }
        #if os(iOS)
        .alert(item: voiceActivationIssueBinding) { issue in
            switch issue {
            case .missingOpenAIKey:
                return Alert(
                    title: Text("Voice Agent Unavailable"),
                    message: Text("Sync an OpenAI API key from Nimbalyst on your computer before starting the voice agent."),
                    primaryButton: .default(Text("Open Voice Settings")) {
                        showVoiceSettings = true
                    },
                    secondaryButton: .cancel()
                )
            case .microphonePermissionDenied:
                return Alert(
                    title: Text("Microphone Access Required"),
                    message: Text("Allow microphone access in iOS Settings to use the voice agent."),
                    primaryButton: .default(Text("Open Settings")) {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            openURL(url)
                        }
                    },
                    secondaryButton: .cancel()
                )
            case .audioSessionFailed(let message):
                return Alert(
                    title: Text("Voice Agent Could Not Start"),
                    message: Text(message),
                    dismissButton: .default(Text("OK"))
                )
            }
        }
        .sheet(isPresented: $showVoiceSettings) {
            NavigationStack {
                SettingsView()
                    .environmentObject(appState)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showVoiceSettings = false }
                        }
                    }
            }
        }
        #endif
    }

    #if os(iOS)
    private var voiceActivationIssueBinding: Binding<VoiceAgent.ActivationIssue?> {
        Binding(
            get: { appState.voiceAgent?.activationIssue },
            set: { newValue in
                if newValue == nil {
                    appState.voiceAgent?.dismissActivationIssue()
                }
            }
        )
    }
    #endif

    /// Preserve notification/voice intent even when the session has not synced yet.
    private func navigateToSession(_ sessionId: String) {
        navigation.openSession(sessionId, database: appState.databaseManager)
    }
}

// MARK: - Sync Auth-Degraded Banner

/// Surfaced above MainNavigationView when sync has been failing with
/// auth-class errors long enough that the user almost certainly needs to
/// sign in again. Visibility is driven by `AppState.syncAuthDegraded`.
struct SyncAuthDegradedBanner: View {
    let onSignIn: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.subheadline)
                .foregroundStyle(NimbalystColors.warning)

            VStack(alignment: .leading, spacing: 1) {
                Text("Sync paused")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .foregroundStyle(.primary)
                Text("Your session may need a refresh.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Button(action: onSignIn) {
                Text("Sign in again")
                    .font(.caption)
                    .fontWeight(.semibold)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(NimbalystColors.primary)
            .accessibilityIdentifier("sync-auth-degraded-sign-in")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NimbalystColors.warning.opacity(0.18))
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(NimbalystColors.warning.opacity(0.45))
                .frame(height: 0.5)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Sync paused. Your session may need a refresh.")
        .accessibilityIdentifier("sync-auth-degraded-banner")
    }
}
