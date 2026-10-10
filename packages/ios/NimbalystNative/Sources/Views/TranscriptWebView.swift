#if canImport(UIKit)
import SwiftUI
import WebKit
import os

/// A SwiftUI wrapper around WKWebView that loads the transcript web app
/// and provides a bridge for Swift <-> JS communication.
///
/// The web view loads `transcript.html` from the app bundle and exposes
/// `window.nimbalyst` methods for receiving session data from Swift.
/// JS sends messages back to Swift via `webkit.messageHandlers.bridge`.
/// Provides external access to transcript web view actions (scroll, prompts).
@MainActor
public class TranscriptController: ObservableObject {
    weak var coordinator: TranscriptWebView.Coordinator?

    public func scrollToTop() {
        coordinator?.scrollToTop()
    }

    public func scrollToMessage(messageId: String) {
        coordinator?.scrollToMessage(messageId: messageId)
    }

    public func getPromptList(completion: @escaping ([[String: Any]]) -> Void) {
        coordinator?.getPromptList(completion: completion) ?? completion([])
    }
}

public struct TranscriptWebView: UIViewRepresentable {
    let session: Session
    let messages: [Message]
    let waitForInitialMessages: Bool
    let onSendPrompt: (String) -> Void
    let onInteractiveResponse: (String, String, [String: Any]) -> Void
    let controller: TranscriptController?
    let onReady: (() -> Void)?
    let onError: ((String) -> Void)?
    let onOpenFile: ((String) -> Void)?

    public init(
        session: Session,
        messages: [Message],
        waitForInitialMessages: Bool = false,
        onSendPrompt: @escaping (String) -> Void,
        onInteractiveResponse: @escaping (String, String, [String: Any]) -> Void,
        controller: TranscriptController? = nil,
        onReady: (() -> Void)? = nil,
        onError: ((String) -> Void)? = nil,
        onOpenFile: ((String) -> Void)? = nil
    ) {
        self.session = session
        self.messages = messages
        self.waitForInitialMessages = waitForInitialMessages
        self.onSendPrompt = onSendPrompt
        self.onInteractiveResponse = onInteractiveResponse
        self.controller = controller
        self.onReady = onReady
        self.onError = onError
        self.onOpenFile = onOpenFile
    }

    private static let logger = Logger(subsystem: "com.nimbalyst.app", category: "TranscriptWebView")

    public func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(
            session: session,
            waitForInitialMessages: waitForInitialMessages,
            onSendPrompt: onSendPrompt,
            onInteractiveResponse: onInteractiveResponse,
            onReady: onReady,
            onError: onError,
            onOpenFile: onOpenFile
        )
        // Wire up the external controller
        controller?.coordinator = coordinator
        return coordinator
    }

    public func makeUIView(context: Context) -> WKWebView {
        // Try to use a pre-warmed web view from the pool.
        if let pooled = TranscriptWebViewPool.shared.takeWebView() {
            // The pooled web view already has HTML loaded. We just need to
            // register our bridge message handler and wire up the coordinator.
            pooled.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
            pooled.configuration.userContentController.add(context.coordinator, name: "bridge")
            context.coordinator.webView = pooled
            pooled.navigationDelegate = context.coordinator
            pooled.uiDelegate = context.coordinator

            // The JS app already mounted and sent `ready` during warmup, but
            // there was no bridge handler to receive it. Probe whether the
            // bridge is live by checking for window.nimbalyst.
            context.coordinator.probePooledWebView(pooled, retryCount: 0)

            return pooled
        }

        // Fallback: create a fresh web view (cold start path).

        let config = WKWebViewConfiguration()

        // Register the bridge message handler
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "bridge")

        // Inject error handler to catch JS errors before page scripts run
        let errorScript = WKUserScript(
            source: """
            function isBenignWindowErrorMessage(message) {
                return message === 'ResizeObserver loop completed with undelivered notifications.';
            }
            window.onerror = function(msg, url, line, col, error) {
                var messageText = error && error.message ? error.message : String(msg);
                if (isBenignWindowErrorMessage(messageText)) {
                    return true;
                }
                window.webkit.messageHandlers.bridge.postMessage({
                    type: 'js_error',
                    message: msg,
                    url: url,
                    line: line,
                    col: col,
                    stack: error ? error.stack : ''
                });
            };
            window.addEventListener('unhandledrejection', function(e) {
                window.webkit.messageHandlers.bridge.postMessage({
                    type: 'js_error',
                    message: 'Unhandled promise rejection: ' + e.reason
                });
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(errorScript)

        // DEBUG-only flag so the JS bundle can opt into diagnostic helpers
        // (window.nimbalyst._debugRaw / _debugView). Release builds never set
        // it, so the helpers are unreachable from a packaged app.
        #if DEBUG
        let debugFlagScript = WKUserScript(
            source: "window.__nimbalystDebug = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(debugFlagScript)
        #endif

        config.userContentController = contentController

        // Allow inline media playback
        config.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x1a/255, green: 0x1a/255, blue: 0x1a/255, alpha: 1)
        webView.scrollView.backgroundColor = UIColor(red: 0x1a/255, green: 0x1a/255, blue: 0x1a/255, alpha: 1)

        // Allow Safari Web Inspector to attach in development builds. Without
        // this the transcript WKWebView is invisible to Develop > [device].
        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif

        // Disable bouncing for a more native feel within the scroll
        webView.scrollView.bounces = false

        // Store reference for later JS calls
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator

        // Load the transcript HTML from the app bundle
        loadTranscriptHTML(webView: webView)

        // Start readiness timeout for cold-start path
        context.coordinator.startReadyTimeout()

        return webView
    }

    public static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.prepareForPooling()
        let contentController = webView.configuration.userContentController
        contentController.removeScriptMessageHandler(forName: "bridge")
        TranscriptWebViewPool.shared.returnWebView(webView)
    }

    public func updateUIView(_ webView: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.waitForInitialMessages = waitForInitialMessages
        coordinator.latestMessages = messages

        // Check if session changed
        if coordinator.currentSessionId != session.id {
            Self.logger.info("updateUIView: session changed to \(session.id) (webViewReady=\(coordinator.webViewReady), msgs=\(messages.count))")
            coordinator.currentSessionId = session.id
            coordinator.currentSession = session
            coordinator.lastMessageCount = 0
            coordinator.isReady = false
            coordinator.isLoadingSession = false
            coordinator.pendingSession = (session, messages)
            // The web view will call loadSession when ready, or if already ready:
            if coordinator.webViewReady {
                coordinator.loadSessionIntoWebView(session: session, messages: messages)
            }
            return
        }
        coordinator.currentSession = session

        // If we haven't sent the initial loadSession yet, update the pending data
        // instead of trying to append (append requires isReady which needs loadSession first).
        // This handles the race where GRDB fires with real data before the WebView is ready.
        if !coordinator.isReady {
            coordinator.pendingSession = (session, messages)
            if coordinator.webViewReady {
                coordinator.loadSessionIntoWebView(session: session, messages: messages)
            }
            return
        }

        // Check for new messages (append only) — batched into a single IPC call
        if messages.count > coordinator.lastMessageCount {
            let newMessages = Array(messages[coordinator.lastMessageCount...])
            coordinator.appendMessagesToWebView(messages: newMessages, sessionId: session.id)
            coordinator.lastMessageCount = messages.count
        }

        // Update metadata if session properties changed
        if coordinator.lastIsExecuting != session.isExecuting
            || coordinator.lastProvider != session.provider
            || coordinator.lastModel != session.model
            || coordinator.lastTitle != session.titleDecrypted {
            coordinator.updateMetadataInWebView(session: session)
        }
    }

    private func loadTranscriptHTML(webView: WKWebView) {
        // The transcript-dist folder is a folder reference in the bundle.
        // Bundle.main.url(forResource:subdirectory:) doesn't work with folder references,
        // so we construct the URL directly from the bundle path.
        let bundleURL = Bundle.main.bundleURL
        let distURL = bundleURL.appendingPathComponent("transcript-dist")
        let htmlURL = distURL.appendingPathComponent("transcript.html")

        if FileManager.default.fileExists(atPath: htmlURL.path) {
            webView.loadFileURL(htmlURL, allowingReadAccessTo: distURL)
        } else {
            Self.logger.error("transcript.html not found at: \(htmlURL.path)")
        }
    }

    // MARK: - Coordinator

    public class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        private let logger = Logger(subsystem: "com.nimbalyst.app", category: "TranscriptWebView.Coordinator")

        weak var webView: WKWebView?
        var currentSessionId: String?

        /// The session `currentSessionId` refers to. On iPad the coordinator
        /// outlives a session swap, so recovery paths must reseed from this and
        /// not from the `session` captured at init.
        var currentSession: Session?
        var lastMessageCount: Int = 0
        var lastIsExecuting: Bool = false
        var lastProvider: String?
        var lastModel: String?
        var lastTitle: String?

        /// Whether the web view JS bridge is ready.
        var webViewReady = false

        /// Whether we've sent the initial loadSession call.
        var isReady = false

        /// Whether a loadSession call is currently in-flight (prevents duplicate calls).
        var isLoadingSession = false

        /// Session + messages waiting for the web view to be ready.
        var pendingSession: (Session, [Message])?

        /// The message list from the most recent `updateUIView`. SwiftUI does not
        /// call `updateUIView` again when the page reloads, so recovering from a
        /// killed content process must re-send the transcript from here.
        var latestMessages: [Message] = []

        /// Runs a script in the page. Replaceable so tests can answer for the
        /// bridge without loading the bundle.
        var callJavaScript: @MainActor (String, [String: Any], WKWebView, @escaping @MainActor (Any?, Error?) -> Void) -> Void = { script, arguments, webView, completion in
            webView.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { result in
                switch result {
                case .failure(let error): completion(nil, error)
                case .success(let value): completion(value, nil)
                }
            }
        }

        /// Defer the first JS load until Swift has real initial transcript data.
        var waitForInitialMessages: Bool

        private let onSendPrompt: (String) -> Void
        private let onInteractiveResponse: (String, String, [String: Any]) -> Void
        private let onReady: (() -> Void)?
        fileprivate let onError: ((String) -> Void)?
        private let onOpenFile: ((String) -> Void)?

        /// Timer for detecting web view initialization timeout.
        private var readyTimeoutItem: DispatchWorkItem?

        init(
            session: Session,
            waitForInitialMessages: Bool,
            onSendPrompt: @escaping (String) -> Void,
            onInteractiveResponse: @escaping (String, String, [String: Any]) -> Void,
            onReady: (() -> Void)? = nil,
            onError: ((String) -> Void)? = nil,
            onOpenFile: ((String) -> Void)? = nil
        ) {
            self.currentSession = session
            self.waitForInitialMessages = waitForInitialMessages
            self.onSendPrompt = onSendPrompt
            self.onInteractiveResponse = onInteractiveResponse
            self.onReady = onReady
            self.onError = onError
            self.onOpenFile = onOpenFile
        }

        // MARK: - WKScriptMessageHandler

        public func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let type = body["type"] as? String else {
                logger.warning("Invalid bridge message from JS")
                return
            }

            switch type {
            case "ready":
                logger.info("Bridge 'ready' received (webViewReady was \(self.webViewReady), pending=\(self.pendingSession != nil))")
                webViewReady = true
                readyTimeoutItem?.cancel()
                // A `ready` after a session was loaded means the page reloaded
                // (WebKit restarts a killed content process on its own) and is
                // now empty. Re-send the transcript rather than waiting for a new
                // message that may never come.
                if pendingSession == nil, currentSessionId != nil, let currentSession {
                    logger.warning("Bridge ready after load: page reloaded, re-sending session \(currentSession.id)")
                    isReady = false
                    isLoadingSession = false
                    lastMessageCount = 0
                    pendingSession = (currentSession, latestMessages)
                }
                // Load pending session if we have one
                if let (session, messages) = pendingSession {
                    logger.info("Bridge ready: loading pending session \(session.id) with \(messages.count) messages")
                    loadSessionIntoWebView(session: session, messages: messages)
                }

            case "prompt":
                if let text = body["text"] as? String {
                    onSendPrompt(text)
                }

            case "interactive_response":
                if let action = body["action"] as? String {
                    let promptId = body["promptId"] as? String
                        ?? body["requestId"] as? String
                        ?? body["questionId"] as? String
                        ?? body["proposalId"] as? String
                        ?? ""
                    onInteractiveResponse(action, promptId, body)
                }

            case "haptic":
                let style = body["style"] as? String ?? "medium"
                triggerHaptic(style: style)

            case "open_file":
                if let filePath = body["filePath"] as? String {
                    logger.info("Bridge: open_file received for '\(filePath)'")
                    onOpenFile?(filePath)
                } else {
                    logger.warning("Bridge: open_file missing filePath")
                }

            case "open_url":
                if let urlString = body["url"] as? String, let url = URL(string: urlString) {
                    // Team console pages open in Pages; a universal link does
                    // not reliably come back to the app that opened it.
                    if ConsoleLinkInbox.shared.open(url) { return }
                    UIApplication.shared.open(url)
                }

            case "js_error":
                let msg = body["message"] as? String ?? "unknown"
                if msg.contains("ResizeObserver loop completed with undelivered notifications.") {
                    return
                }
                let url = body["url"] as? String ?? ""
                let line = body["line"] as? Int ?? 0
                logger.error("JS error: \(msg) at \(url):\(line)")

            default:
                logger.debug("Unknown bridge message type: \(type)")
            }
        }

        // MARK: - WKNavigationDelegate

        /// Intercept link clicks: allow file:// (transcript HTML), open http(s) in Safari.
        public func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            // Always allow the initial file:// load of transcript.html and its assets
            if url.isFileURL {
                decisionHandler(.allow)
                return
            }

            // External links (http, https, mailto, etc.) -- open outside the web view.
            // Dispatch async to avoid SOAuthorizationCoordinator warnings from WKWebView.
            if let scheme = url.scheme, ["http", "https", "mailto"].contains(scheme.lowercased()) {
                decisionHandler(.cancel)
                if ConsoleLinkInbox.shared.open(url) { return }
                logger.info("decidePolicyFor: opening external URL in Safari: \(url.absoluteString)")
                DispatchQueue.main.async {
                    UIApplication.shared.open(url)
                }
                return
            }

            // Block any other navigation to keep the web view on transcript.html
            logger.info("decidePolicyFor: blocking navigation to \(url.absoluteString)")
            decisionHandler(.cancel)
        }

        // MARK: - WKUIDelegate

        /// Handle target="_blank" links. WKWebView asks us to create a new web view;
        /// instead we open the URL externally and return nil to cancel the new window.
        public func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                if ConsoleLinkInbox.shared.open(url) { return nil }
                logger.info("createWebViewWith: opening \(url.absoluteString) externally")
                DispatchQueue.main.async {
                    UIApplication.shared.open(url)
                }
            }
            return nil
        }

        public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // Page loaded successfully - JS bridge will send "ready" message
        }

        public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            logger.error("Navigation failed: \(error.localizedDescription)")
            onError?("WebView navigation failed: \(error.localizedDescription)")
        }

        public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            logger.error("Provisional navigation failed: \(error.localizedDescription)")
            onError?("WebView failed to load transcript: \(error.localizedDescription)")
        }

        /// Track content process terminations to avoid crash loops.
        private var contentProcessTerminationCount = 0

        /// iOS kills the content process freely while the app is backgrounded.
        /// The selector must be exactly this one or WebKit never calls it.
        public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            contentProcessTerminationCount += 1
            logger.warning("Content process terminated (count: \(self.contentProcessTerminationCount))")
            webViewReady = false
            isReady = false
            isLoadingSession = false
            lastMessageCount = 0

            if let currentSession {
                pendingSession = (currentSession, latestMessages)
            }

            // Avoid crash loops: only reload if we haven't had too many terminations
            // without a successful load in between.
            guard contentProcessTerminationCount <= 2 else {
                logger.error("Content process terminated too many times, not reloading")
                onError?("WebView content process crashed \(contentProcessTerminationCount) times — not reloading")
                return
            }

            // Delay reload slightly to let iOS recover the content process.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self, weak webView] in
                guard let self, let webView, !self.webViewReady else { return }
                self.reloadTranscriptHTML(in: webView)
            }
        }

        /// Start a 10-second timeout for the web view to become ready.
        /// If it doesn't send a "ready" bridge message in time, report an error.
        func startReadyTimeout() {
            readyTimeoutItem?.cancel()
            let item = DispatchWorkItem { [weak self] in
                guard let self, !self.webViewReady else { return }
                self.logger.error("WebView readiness timeout after 10s (webViewReady=\(self.webViewReady), isReady=\(self.isReady), hasPendingSession=\(self.pendingSession != nil))")
                self.onError?("WebView failed to initialize after 10s")
            }
            readyTimeoutItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: item)
        }

        // MARK: - Pool Probe

        /// Maximum number of retries when probing a pooled web view for readiness.
        private static let maxProbeRetries = 10

        /// Probe a pooled web view to check if window.nimbalyst is set up.
        /// If the React app hasn't mounted yet (slow device, web process was unresponsive),
        /// retry with exponential backoff. Without this, the transcript deadlocks because
        /// the JS "ready" message was sent during warmup before the bridge handler existed.
        func probePooledWebView(_ webView: WKWebView, retryCount: Int) {
            webView.evaluateJavaScript("typeof window.nimbalyst") { [weak self] result, error in
                guard let self else { return }

                if let error {
                    self.logger.warning("Pool probe FAILED: \(error.localizedDescription)")
                    self.webViewReady = false
                    self.isReady = false
                    self.reloadTranscriptHTML(in: webView)
                    return
                }

                if (result as? String ?? "nil") == "object" {
                    self.webViewReady = true
                    if let (session, messages) = self.pendingSession {
                        self.loadSessionIntoWebView(session: session, messages: messages)
                    }
                    return
                }

                // React app hasn't mounted yet. Retry with backoff.
                if retryCount < Self.maxProbeRetries {
                    let delay = min(0.1 * pow(1.5, Double(retryCount)), 2.0)
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        self?.probePooledWebView(webView, retryCount: retryCount + 1)
                    }
                } else {
                    self.logger.warning("Pool probe: exhausted \(retryCount) retries, reloading HTML")
                    self.webViewReady = false
                    self.isReady = false
                    self.reloadTranscriptHTML(in: webView)
                }
            }
        }

        /// Reload transcript HTML as a recovery mechanism.
        private func reloadTranscriptHTML(in webView: WKWebView) {
            let bundleURL = Bundle.main.bundleURL
            let distURL = bundleURL.appendingPathComponent("transcript-dist")
            let htmlURL = distURL.appendingPathComponent("transcript.html")
            if FileManager.default.fileExists(atPath: htmlURL.path) {
                webView.loadFileURL(htmlURL, allowingReadAccessTo: distURL)
                startReadyTimeout()
            } else {
                logger.error("transcript.html not found in app bundle")
                onError?("transcript.html not found in app bundle")
            }
        }

        // MARK: - Swift -> JS

        // Uses callAsyncJavaScript to pass data as arguments instead of string
        // interpolation, avoiding escaping issues with special characters in
        // message content (code, nested JSON, unicode, etc.).

        private func callJS(_ script: String, arguments: [String: Any] = [:], in webView: WKWebView, completion: (@MainActor (Error?) -> Void)? = nil) {
            callJS(script, arguments: arguments, in: webView) { (_: Any?, error: Error?) in
                completion?(error)
            }
        }

        private func callJS(
            _ script: String,
            arguments: [String: Any] = [:],
            in webView: WKWebView,
            completion: @escaping @MainActor (Any?, Error?) -> Void
        ) {
            callJavaScript(script, arguments, webView, completion)
        }

        @discardableResult
        func loadSessionIntoWebView(session: Session, messages: [Message]) -> Bool {
            guard let webView = webView, !isLoadingSession else {
                pendingSession = (session, messages)
                return false
            }

            if waitForInitialMessages {
                logger.debug("loadSession: deferred initial load for session \(session.id) with \(messages.count) messages")
                pendingSession = (session, messages)
                return false
            }

            isLoadingSession = true
            pendingSession = nil
            let bridgeMessages = messages.map { messageToBridgeJSON($0) }

            let metadata: [String: Any] = [
                "title": session.titleDecrypted as Any,
                "provider": session.provider as Any,
                "model": session.model as Any,
                "mode": session.mode as Any,
                "isExecuting": session.isExecuting,
            ]

            let sessionData: [String: Any] = [
                "sessionId": session.id,
                "messages": bridgeMessages,
                "metadata": metadata,
            ]

            logger.info("loadSession: calling JS with \(messages.count) messages for session \(session.id)")

            // The bridge returns the sessionId it activated. Without that echo a
            // missing `window.nimbalyst` would resolve successfully through the
            // optional chain and we would reveal the pooled webview still showing
            // the previous session's transcript.
            callJS(
                "return window.nimbalyst ? window.nimbalyst.loadSession(data) : null;",
                arguments: ["data": sessionData],
                in: webView
            ) { [weak self] result, error in
                guard let self else { return }
                self.isLoadingSession = false

                if let error = error {
                    self.logger.error("loadSession JS error: \(error.localizedDescription)")
                    self.onError?("loadSession JS failed: \(error.localizedDescription)")
                    return
                }

                let outcome = resolveTranscriptLoad(
                    requestedSessionId: session.id,
                    activatedSessionId: result as? String,
                    loadedMessageCount: messages.count,
                    pendingSessionId: self.pendingSession?.0.id,
                    pendingMessageCount: self.pendingSession?.1.count ?? 0
                )

                switch outcome {
                case .failed(let reason):
                    self.logger.error("loadSession: \(reason)")
                    self.onError?(reason)

                case .loadPending(let pendingId):
                    self.logger.info("loadSession: session swapped to \(pendingId) mid-flight, reloading")
                    guard let pending = self.pendingSession else { return }
                    self.pendingSession = nil
                    self.loadSessionIntoWebView(session: pending.0, messages: pending.1)

                case .activated, .activatedThenAppend:
                    self.logger.info("loadSession: activated \(session.id), lastMessageCount=\(messages.count)")
                    self.isReady = true
                    self.contentProcessTerminationCount = 0
                    self.lastMessageCount = messages.count
                    self.lastIsExecuting = session.isExecuting
                    self.lastProvider = session.provider
                    self.lastModel = session.model
                    self.lastTitle = session.titleDecrypted

                    if case .activatedThenAppend(let fromIndex) = outcome, let pending = self.pendingSession {
                        self.appendMessagesToWebView(messages: Array(pending.1[fromIndex...]), sessionId: session.id)
                        self.lastMessageCount = pending.1.count
                    }
                    self.pendingSession = nil

                    // Signal to the parent view that transcript is ready.
                    self.onReady?()
                }
            }

            return true
        }

        // Every mutation names the session it belongs to. JS drops it if that
        // session is not the one on screen, so a delta computed for one session
        // can never land in another's transcript.

        func appendMessageToWebView(message: Message, sessionId: String) {
            guard let webView = webView, isReady else { return }

            let bridgeMsg = messageToBridgeJSON(message)
            callJS(
                "return window.nimbalyst?.appendMessage(msg, sessionId);",
                arguments: ["msg": bridgeMsg, "sessionId": sessionId],
                in: webView
            ) { [weak self] result, error in
                self?.reportMutationResult("appendMessage", sessionId: sessionId, result: result, error: error)
            }
        }

        /// Batch-append multiple messages in a single IPC call to avoid WebKit throttling.
        func appendMessagesToWebView(messages: [Message], sessionId: String) {
            guard let webView = webView, isReady, !messages.isEmpty else { return }

            if messages.count == 1 {
                appendMessageToWebView(message: messages[0], sessionId: sessionId)
                return
            }

            let bridgeMsgs = messages.map { messageToBridgeJSON($0) }
            callJS(
                "return window.nimbalyst?.appendMessages(msgs, sessionId);",
                arguments: ["msgs": bridgeMsgs, "sessionId": sessionId],
                in: webView
            ) { [weak self] result, error in
                self?.reportMutationResult("appendMessages", sessionId: sessionId, result: result, error: error)
            }
        }

        /// A rejected mutation means Swift and the bridge disagree about which
        /// session is on screen. Drop `isReady` so the next `updateUIView` goes
        /// back through `loadSession` and re-establishes which session is live.
        private func reportMutationResult(_ name: String, sessionId: String, result: Any?, error: Error?) {
            if let error {
                // The page may have reloaded or lost its bridge; reload rather
                // than keep appending to a transcript that is not there.
                logger.error("\(name) JS error: \(error.localizedDescription); forcing a reload")
                isReady = false
                lastMessageCount = 0
                return
            }
            guard (result as? Bool) == false else { return }
            logger.warning("\(name): bridge rejected an update for \(sessionId); forcing a reload")
            isReady = false
            lastMessageCount = 0
        }

        func updateMetadataInWebView(session: Session) {
            guard let webView = webView, isReady else { return }

            let metadata: [String: Any] = [
                "title": session.titleDecrypted as Any,
                "provider": session.provider as Any,
                "model": session.model as Any,
                "mode": session.mode as Any,
                "isExecuting": session.isExecuting,
            ]

            callJS(
                "return window.nimbalyst?.updateMetadata(meta, sessionId);",
                arguments: ["meta": metadata, "sessionId": session.id],
                in: webView
            ) { [weak self] result, error in
                self?.reportMutationResult("updateMetadata", sessionId: session.id, result: result, error: error)
            }

            lastIsExecuting = session.isExecuting
            lastProvider = session.provider
            lastModel = session.model
            lastTitle = session.titleDecrypted
        }

        // MARK: - Scroll Control

        func scrollToTop() {
            guard let webView = webView, isReady else { return }
            webView.evaluateJavaScript("window.nimbalyst?.scrollToTop();") { _, _ in }
        }

        func scrollToMessage(messageId: String) {
            guard let webView = webView, isReady else { return }
            let escapedId = messageId.replacingOccurrences(of: "\"", with: "\\\"")
            webView.evaluateJavaScript("window.nimbalyst?.scrollToMessage(\"\(escapedId)\");") { _, _ in }
        }

        /// Get the list of user prompts from the web transcript.
        func getPromptList(completion: @escaping ([[String: Any]]) -> Void) {
            guard let webView = webView, isReady else {
                completion([])
                return
            }
            webView.evaluateJavaScript("JSON.stringify(window.nimbalyst?.getPromptList() || []);") { result, _ in
                guard let jsonString = result as? String,
                      let data = jsonString.data(using: .utf8),
                      let prompts = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                    completion([])
                    return
                }
                completion(prompts)
            }
        }

        // MARK: - Helpers

        private func messageToBridgeJSON(_ message: Message) -> [String: Any] {
            var dict: [String: Any] = [
                "id": message.id,
                "sessionId": message.sessionId,
                "sequence": message.sequence,
                "source": message.source,
                "direction": message.direction,
                "createdAt": message.createdAt,
            ]
            dict["contentDecrypted"] = message.contentDecrypted as Any
            dict["metadataJson"] = message.metadataJson as Any
            return dict
        }

        private func triggerHaptic(style: String) {
            let feedbackStyle: UIImpactFeedbackGenerator.FeedbackStyle
            switch style {
            case "light":
                feedbackStyle = .light
            case "heavy":
                feedbackStyle = .heavy
            default:
                feedbackStyle = .medium
            }
            let generator = UIImpactFeedbackGenerator(style: feedbackStyle)
            generator.impactOccurred()
        }

        func prepareForPooling() {
            readyTimeoutItem?.cancel()
            readyTimeoutItem = nil
            pendingSession = nil
            latestMessages = []
            webViewReady = false
            isReady = false
            isLoadingSession = false
            lastMessageCount = 0
            currentSession = nil
            webView = nil
        }
    }
}
#endif
