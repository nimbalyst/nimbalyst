import SwiftUI
import NimbalystNative

#if canImport(UIKit)
/// AppDelegate adapter to receive APNs token callbacks.
/// SwiftUI @main apps do NOT get these callbacks without an explicit adapter.
class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        NotificationManager.shared.didRegisterForRemoteNotifications(withDeviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NotificationManager.shared.didFailToRegisterForRemoteNotifications(withError: error)
    }
}
#endif

@main
struct NimbalystAppMain: App {
    #if canImport(UIKit)
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    #endif
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var appState: AppState

    /// Launch with --transcript-test to show the TranscriptWebView with fake data
    /// (bypasses pairing/auth for testing transcript rendering).
    private let isTranscriptTest = CommandLine.arguments.contains("--transcript-test")

    /// Launch with --screenshot-mode to show the app with realistic demo data
    /// for App Store screenshot capture. Combine with --screenshot-screen=<name>
    /// to target a specific screen (projects, sessions, detail, settings, pairing).
    private let isScreenshotMode: Bool = {
        #if DEBUG
        return CommandLine.arguments.contains("--screenshot-mode")
        #else
        return false
        #endif
    }()

    init() {
        #if DEBUG
        if CommandLine.arguments.contains("--screenshot-mode") {
            _appState = StateObject(wrappedValue: AppState.forScreenshots())
        } else {
            _appState = StateObject(wrappedValue: AppState())
        }
        #else
        _appState = StateObject(wrappedValue: AppState())
        #endif
    }

    var body: some Scene {
        WindowGroup {
            if isTranscriptTest {
                TranscriptTestView()
            } else if isScreenshotMode {
                #if DEBUG
                ScreenshotHostView()
                    .environmentObject(appState)
                #else
                ContentView()
                    .environmentObject(appState)
                #endif
            } else {
                ContentView()
                    .environmentObject(appState)
                    .onOpenURL { url in
                        NSLog("[onOpenURL] Received URL: \(url.absoluteString.prefix(120))")
                        handleDeepLink(url)
                    }
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            NSLog("[ScenePhase] changed to: \(String(describing: newPhase))")
            switch newPhase {
            case .active:
                appState.syncManager?.setAppInForeground(true)
                appState.documentSyncManager?.reconnectIfNeeded()
            case .inactive, .background:
                appState.syncManager?.setAppInForeground(false)
            @unknown default:
                break
            }
        }
    }

    /// Handle allowlisted `nimbalyst://` deep links.
    /// Pairing payloads are accepted only through the in-app QR scanner.
    private func handleDeepLink(_ url: URL) {
        NSLog("[DeepLink] handleDeepLink called with scheme=\(url.scheme ?? "nil"), host=\(url.host ?? "nil"), path=\(url.path)")

        switch NimbalystExternalURLRouter.route(url) {
        case .authCallback:
            NSLog("[DeepLink] Routing to authManager.handleCallback")
            appState.authManager.handleCallback(url)
        case .openPairingScanner:
            // Surface the in-app scanner only; the link's payload is never applied.
            NSLog("[DeepLink] Opening in-app pairing scanner (payload ignored)")
            appState.pairingScannerRequested = true
        case .unsupported:
            NSLog("[DeepLink] Ignored: URL is not allowlisted")
        }
    }
}

// MARK: - Transcript Test View

/// A standalone view that renders TranscriptWebView with hardcoded test data.
/// Used for automated verification that the transcript bundle loads and renders.
#if canImport(UIKit)
struct TranscriptTestView: View {
    private let testSession = Session(
        id: "test-session-1",
        projectId: "/test",
        titleDecrypted: "Test Session",
        provider: "claude-code",
        model: "claude-sonnet-4-5-20250929",
        mode: "agent",
        createdAt: Int(Date().timeIntervalSince1970 * 1000),
        updatedAt: Int(Date().timeIntervalSince1970 * 1000)
    )

    /// Wrap inner message JSON in the sync envelope format that real decrypted messages use:
    /// {"content":"<inner JSON string>","metadata":null,"hidden":false}
    private static func envelope(_ inner: String) -> String {
        let obj: [String: Any] = ["content": inner, "metadata": NSNull(), "hidden": false]
        let data = try! JSONSerialization.data(withJSONObject: obj)
        return String(data: data, encoding: .utf8)!
    }

    private var testMessages: [Message] {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        return [
            Message(
                id: "msg-1",
                sessionId: "test-session-1",
                sequence: 1,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: Self.envelope("{\"prompt\":\"Hello, can you help me write a Swift function?\"}"),
                createdAt: now - 60000
            ),
            Message(
                id: "msg-2",
                sessionId: "test-session-1",
                sequence: 2,
                source: "claude-code",
                direction: "output",
                encryptedContent: "",
                iv: "",
                contentDecrypted: Self.envelope("{\"type\":\"text\",\"content\":\"Sure! Here's a simple Swift function:\\n\\n```swift\\nfunc greet(name: String) -> String {\\n    return \\\"Hello, \\\\(name)!\\\"\\n}\\n```\\n\\nThis function takes a name parameter and returns a greeting string.\"}"),
                createdAt: now - 30000
            ),
            Message(
                id: "msg-3",
                sessionId: "test-session-1",
                sequence: 3,
                source: "user",
                direction: "input",
                encryptedContent: "",
                iv: "",
                contentDecrypted: Self.envelope("{\"prompt\":\"Can you add error handling?\"}"),
                createdAt: now
            ),
        ]
    }

    var body: some View {
        TranscriptWebView(
            session: testSession,
            messages: testMessages,
            onSendPrompt: { _ in },
            onInteractiveResponse: { _, _, _ in }
        )
        .ignoresSafeArea()
    }
}
#else
struct TranscriptTestView: View {
    var body: some View {
        Text("Transcript test requires iOS")
    }
}
#endif
