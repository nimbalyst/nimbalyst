#if canImport(WebKit)
import Foundation
import Network
import WebKit
import os

/// A native sheet the Pages screen can raise.
public enum PagesSheet: Identifiable, Equatable, Sendable {
    case personalPages
    case orgAuthRequired(orgId: String, reason: String?)
    case desktopOnly

    public var id: String {
        switch self {
        case .personalPages: return "personal"
        case .orgAuthRequired(let orgId, _): return "org-auth-\(orgId)"
        case .desktopOnly: return "desktop-only"
        }
    }
}

public enum PagesFailure: Equatable, Sendable {
    case offline
    case load(String)
    case server(Int)
    case session(String)
}

public enum PagesPhase: Equatable, Sendable {
    case idle
    case loading
    case ready
    case failed(PagesFailure)
}

/// Whether the device has a network route right now. Pages are online-only,
/// so an offline open shows a native empty state instead of a WebKit error page.
@MainActor
public final class ConsoleReachability: ObservableObject {
    @Published public private(set) var isOnline = true
    private let monitor = NWPathMonitor()

    public init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in
                guard let self, self.isOnline != online else { return }
                self.isOnline = online
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.nimbalyst.console-reachability"))
        isOnline = monitor.currentPath.status != .unsatisfied
    }

    deinit { monitor.cancel() }
}

/// Production remover for the per-account console data store.
@MainActor
public final class WebKitConsoleDataStores: ConsoleWebDataStoreRemoving {
    public init() {}
    public func removeDataStore(identifier: UUID) async throws {
        try await WKWebsiteDataStore.remove(forIdentifier: identifier)
    }
}

/// Owns the one long-lived Pages WKWebView for the selected account, its bridge,
/// and its navigation policy. Lives in `AppState` so leaving the screen does not
/// throw away the page (or the in-memory edits it holds).
@MainActor
public final class PagesWebController: NSObject, ObservableObject, PagesUnsyncedEdits {
    public struct Hooks {
        public var openExternally: @MainActor (URL) -> Void
        public var appRoute: @MainActor (NimbalystExternalURLRoute) -> Void

        public init(openExternally: @escaping @MainActor (URL) -> Void, appRoute: @escaping @MainActor (NimbalystExternalURLRoute) -> Void) {
            self.openExternally = openExternally
            self.appRoute = appRoute
        }
    }

    @Published public private(set) var phase: PagesPhase = .idle
    @Published public private(set) var title = ""
    @Published public private(set) var canGoBack = false
    @Published public private(set) var editing = false
    @Published public private(set) var unsynced = false
    @Published public var sheet: PagesSheet?
    @Published public var lostEditsNotice = false
    /// A leave waiting on "Leave without saving?" (see `PagesLeaveGuard`).
    @Published public private(set) var pendingLeave: PagesLeaveIntent?

    public let webView: WKWebView
    public let flush: PagesFlushCoordinator
    public let environment: ConsoleEnvironment
    /// The account selection this web view and its data store belong to.
    /// Session answers for any other selection are dropped.
    public let account: ConsoleAccountContext
    /// The page native opened (sidebar row, link, push).
    public private(set) var currentRoute: ConsoleRoute?
    /// The page the console last reported.
    public private(set) var currentPath: String?
    public private(set) var bridgeReady = false

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "ConsolePages")
    private let broker: ConsoleSessionBroker
    private let isOnline: @MainActor () -> Bool
    private let hooks: Hooks
    /// Tests replace the network load with a fixture; production loads the URL.
    private let loader: @MainActor (WKWebView, URL) -> Void
    private var terminationsWithoutReady = 0
    private var reauthAttemptsWithoutReady = 0
    private var canGoBackObservation: NSKeyValueObservation?
    private let scriptHandler = WeakScriptHandler()
    private let leaveGuard = PagesLeaveGuard()
    /// Bumped by every leave request; a request acts only if still the latest.
    private var navigationGeneration: UInt64 = 0
    /// The nonce the current main-frame console document announced at document
    /// start. A session is delivered only into the document that asked for it.
    private(set) var documentNonce: String?
    /// Bridge work in flight. Cancelled on teardown so nothing keeps the web
    /// view (and so its data store) alive after sign-out.
    private var work: [UUID: Task<Void, Never>] = [:]
    public private(set) var isTornDown = false

    public init(
        environment: ConsoleEnvironment = .production,
        account: ConsoleAccountContext,
        broker: ConsoleSessionBroker,
        dataStore: WKWebsiteDataStore,
        appVersion: String,
        flush: PagesFlushCoordinator,
        isOnline: @escaping @MainActor () -> Bool,
        hooks: Hooks,
        loader: (@MainActor (WKWebView, URL) -> Void)? = nil
    ) {
        self.environment = environment
        self.account = account
        self.broker = broker
        self.flush = flush
        self.isOnline = isOnline
        self.hooks = hooks
        self.loader = loader ?? { webView, url in webView.load(URLRequest(url: url)) }

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: consoleEmbedMarkerScript(environment: environment, appVersion: appVersion),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.add(scriptHandler, contentWorld: .page, name: consoleBridgeHandlerName)
        configuration.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        super.init()
        scriptHandler.target = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        flush.bridge = self
        canGoBackObservation = webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] webView, _ in
            MainActor.assumeIsolated { self?.canGoBack = webView.canGoBack }
        }
    }

    /// Show `route` from a sidebar row, link or push. Replacing the page on
    /// screen goes through the leave guard first.
    public func requestOpen(_ route: ConsoleRoute) async {
        guard route != currentRoute || !(phase == .ready || phase == .loading) else { return }
        guard currentRoute != nil, phase != .idle else { return open(route) }
        _ = await requestLeave(.replaceRoute(route))
    }

    /// Native Back. Walks web history first. Returns true when the caller
    /// should leave the screen.
    public func requestBack() async -> Bool {
        await requestLeave(webView.canGoBack ? .webBack : .leaveScreen)
    }

    /// The one path for everything that takes the reader off this document:
    /// flush; if edits are still not on the server, ask. Each request takes a
    /// new generation, and only the latest one may act after an `await`, so a
    /// stale request whose flush returns late never loads or asks over a newer one.
    /// Returns true when the caller should leave the screen.
    @discardableResult
    func requestLeave(_ intent: PagesLeaveIntent) async -> Bool {
        navigationGeneration &+= 1
        let generation = navigationGeneration
        if pendingLeave != nil {
            pendingLeave = nil
            _ = leaveGuard.cancel()
        }
        let proceed = await leaveGuard.mayProceed(edits: self)
        guard generation == navigationGeneration, !isTornDown, !Task.isCancelled else { return false }
        if proceed { return performApproved(intent) }
        leaveGuard.hold(intent)
        pendingLeave = intent
        return false
    }

    /// "Leave": take the intent now, then discard unsynced edits and do what
    /// was asked. The task returns true when the caller should leave the screen.
    public func confirmPendingLeave() -> Task<Bool, Never>? {
        pendingLeave = nil
        guard let intent = leaveGuard.take() else { return nil }
        navigationGeneration &+= 1
        let generation = navigationGeneration
        return Task { [weak self] in
            guard let self, !self.isTornDown else { return false }
            await self.discardUnsynced()
            guard generation == self.navigationGeneration, !self.isTornDown else { return false }
            return self.performApproved(intent)
        }
    }

    /// "Keep Editing". Returns the route still on screen when a replacement was
    /// refused, so the caller can re-select it.
    public func cancelPendingLeave() -> ConsoleRoute? {
        pendingLeave = nil
        navigationGeneration &+= 1
        guard case .replaceRoute = leaveGuard.cancel() else { return nil }
        return currentRoute
    }

    /// The edits are acknowledged or discarded, so nothing unsynced stays counted
    /// for the document being replaced.
    private func performApproved(_ intent: PagesLeaveIntent) -> Bool {
        unsynced = false
        webView.allowsBackForwardNavigationGestures = true
        flush.editStateChanged(editing: editing, unsynced: false)
        switch intent {
        case .webBack: webView.goBack(); return false
        case .leaveScreen: return true
        case .replaceRoute(let route): open(route); return false
        case .loadURL(let url): load(url); return false
        }
    }

    /// Show `route`. Re-opening the page already shown keeps where the reader is.
    public func open(_ route: ConsoleRoute) {
        if route == currentRoute, phase == .ready || phase == .loading { return }
        currentRoute = route
        currentPath = nil
        title = ""
        guard let url = environment.url(for: route.path) else {
            phase = .failed(.load("This page address is not valid."))
            return
        }
        load(url)
    }

    /// Retry after a failure, keeping the last URL the console reached.
    public func retry() {
        if let url = webView.url, environment.isConsoleOrigin(url) {
            load(url)
        } else if let route = currentRoute, let url = environment.url(for: route.path) {
            load(url)
        }
    }

    public func goBack() {
        if webView.canGoBack { webView.goBack() }
    }

    /// The scene left the foreground: flush unsent edits under a background task.
    public func sceneDidEnterBackground() {
        track { await $0.flush.sceneDidEnterBackground() }
    }

    /// Run bridge work that teardown can cancel. Holds the controller weakly.
    private func track(_ body: @escaping @MainActor (PagesWebController) async -> Void) {
        let id = UUID()
        work[id] = Task { [weak self] in
            guard let self, !self.isTornDown else { return }
            await body(self)
            self.work[id] = nil
        }
    }

    /// Stop everything before the account's data store is removed or replaced.
    public func tearDown() {
        isTornDown = true
        work.values.forEach { $0.cancel() }
        work.removeAll()
        webView.stopLoading()
        webView.removeFromSuperview()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView.configuration.userContentController.removeAllUserScripts()
        canGoBackObservation?.invalidate()
        canGoBackObservation = nil
        scriptHandler.target = nil
        flush.bridge = nil
        bridgeReady = false
        phase = .idle
    }

    private func load(_ url: URL) {
        // Every native load passes the same policy as a navigation the page starts,
        // judged on the canonical path, so a rewritten link cannot reach `/app` or login.
        guard ConsoleNavigationPolicy.allowsNativeLoad(url, environment: environment) else {
            logger.warning("Refused a native load the navigation policy does not allow")
            phase = .failed(.load("This page address is not valid."))
            return
        }
        guard isOnline() else {
            phase = .failed(.offline)
            return
        }
        bridgeReady = false
        documentNonce = nil
        phase = .loading
        if flush.consumeLostEditsNotice() { lostEditsNotice = true }
        loader(webView, url)
    }

    // MARK: - Bridge

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else {
            logger.warning("Dropped console bridge message from a subframe")
            return
        }
        let origin = message.frameInfo.securityOrigin
        guard environment.isConsoleOrigin(protocol: origin.protocol, host: origin.host, port: origin.port) else {
            logger.warning("Dropped console bridge message from another origin")
            return
        }
        guard let parsed = ConsoleBridgeMessage.parse(message.body) else {
            logger.warning("Dropped malformed console bridge message")
            return
        }
        handle(parsed)
    }

    func handle(_ message: ConsoleBridgeMessage) {
        switch message {
        case .ready:
            bridgeReady = true
            terminationsWithoutReady = 0
            reauthAttemptsWithoutReady = 0
            if phase == .loading { phase = .ready }
        case .route(let path, let title, _):
            currentPath = path
            self.title = Self.displayTitle(title)
        case .editState(let editing, let unsynced):
            self.editing = editing
            self.unsynced = unsynced
            // Edge-swipe back would skip the leave guard; Back still asks.
            webView.allowsBackForwardNavigationGestures = !unsynced
            flush.editStateChanged(editing: editing, unsynced: unsynced)
        case .documentStart(let nonce):
            documentNonce = nonce
        case .requestSession(let requestId, let orgId):
            // Bridge messages arrive in order, so the nonce now is the asking document's.
            let nonce = documentNonce
            track { await $0.answerSession(requestId: requestId, orgId: orgId, documentNonce: nonce) }
        case .sessionExpired(let requestId, let orgId):
            let nonce = documentNonce
            track { await $0.answerSession(requestId: requestId, orgId: orgId, documentNonce: nonce) }
        case .orgAuthRequired(let orgId, let reason):
            sheet = .orgAuthRequired(orgId: orgId, reason: reason)
        case .openExternal(let url):
            if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { hooks.openExternally(url) }
        case .openPersonal:
            sheet = .personalPages
        case .flushResult(_, let result):
            logger.info("Console flushResult: \(result.status.rawValue)")
        }
    }

    /// The org of the page on screen, for a `sessionExpired` that names none.
    var currentOrgId: String? {
        currentPath.flatMap { ConsoleRoute(path: $0)?.orgId } ?? currentRoute?.orgId
    }

    private func answerSession(requestId: String, orgId: String?, documentNonce: String?) async {
        guard let delivery = await broker.answer(requestId: requestId, orgId: orgId, fallbackOrgId: currentOrgId, for: account),
              !isTornDown, !Task.isCancelled else { return }
        if case .refused(let code, let refusedOrg, let reason) = delivery.outcome {
            if code == .orgAuthRequired {
                sheet = .orgAuthRequired(orgId: refusedOrg ?? orgId ?? "", reason: reason)
            } else {
                phase = .failed(.session(Self.sessionFailureMessage(code, reason: reason)))
            }
        }
        await deliver(delivery, documentNonce: documentNonce)
    }

    private func deliver(_ delivery: ConsoleSessionDelivery, documentNonce: String?) async {
        // Tokens only ever go to this selection's web view...
        guard !isTornDown, delivery.account == account, broker.isCurrent(account) else {
            logger.warning("Not delivering a console session minted for another account selection")
            return
        }
        // ...and only to the console origin's main frame.
        guard let url = webView.url, environment.isConsoleOrigin(url) else {
            logger.warning("Not delivering a console session: the page left the console origin")
            return
        }
        do {
            guard let documentNonce else {
                logger.warning("Not delivering a console session: the asking document never announced itself")
                return
            }
            // `in: nil` runs in whatever main-frame document is current when the
            // script executes, so the script itself checks it is still the
            // console origin and the very document that asked.
            let accepted = try await webView.callAsyncJavaScript(
                """
                if (window.location.origin !== origin || window.__nimbalystDocumentNonce !== nonce) return 'wrong-document';
                const b = window.__nimbalystConsoleBridge;
                return b ? b.deliverSession(payload) : false;
                """,
                arguments: ["payload": delivery.payload, "origin": environment.originString, "nonce": documentNonce],
                in: nil,
                contentWorld: .page
            )
            if (accepted as? String) == "wrong-document" {
                logger.warning("Not delivering a console session: the document changed before delivery")
            } else if (accepted as? Bool) != true {
                logger.warning("Console ignored a session delivery (stale request or no bridge)")
            }
        } catch {
            logger.error("Console session delivery failed: \(error.localizedDescription)")
            phase = .failed(.session("The page could not be signed in."))
        }
    }

    public func flushPending(timeoutMs: Int) async -> ConsoleFlushResult? {
        guard bridgeReady, let url = webView.url, environment.isConsoleOrigin(url) else { return nil }
        do {
            let value = try await webView.callAsyncJavaScript(
                "const b = window.__nimbalystConsoleBridge; if (!b) return null; return await b.flushPending(timeoutMs);",
                arguments: ["timeoutMs": timeoutMs],
                in: nil,
                contentWorld: .page
            )
            if value == nil || value is NSNull { return nil }
            return ConsoleFlushResult.parse(value)
        } catch {
            return ConsoleFlushResult(status: .failed, detail: error.localizedDescription)
        }
    }

    /// The reader confirmed "Leave without saving": drop the console's
    /// unacknowledged edits (including pages already navigated away from) so
    /// `editState.unsynced` and `flushPending` stop counting them. Returns the
    /// number discarded, or nil when the console has no bridge.
    @discardableResult
    public func discardUnsynced() async -> Int? {
        guard bridgeReady, let url = webView.url, environment.isConsoleOrigin(url) else { return nil }
        do {
            let value = try await webView.callAsyncJavaScript(
                "const b = window.__nimbalystConsoleBridge; return b && b.discardUnsynced ? b.discardUnsynced() : null;",
                arguments: [:],
                in: nil,
                contentWorld: .page
            )
            let count = (value as? NSNumber)?.intValue
            logger.info("Discarded unsynced console edits: \(count.map(String.init) ?? "no bridge")")
            return count
        } catch {
            logger.error("discardUnsynced failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Policy

    func perform(_ action: ConsoleNavigationAction) {
        switch action {
        case .allow, .cancel:
            break
        case .load(let url):
            track { await $0.requestLeave(.loadURL(url)) }
        case .personalPages:
            sheet = .personalPages
        case .desktopOnly:
            sheet = .desktopOnly
        case .reauthenticate:
            reauthenticate()
        case .appRoute(let route):
            hooks.appRoute(route)
        case .openExternally(let url):
            hooks.openExternally(url)
        }
    }

    /// The console tried to show its login page. The embed signs in through
    /// `/authenticate/native`, which asks native for a minted session.
    private func reauthenticate() {
        reauthAttemptsWithoutReady += 1
        guard reauthAttemptsWithoutReady <= 2, let orgId = currentOrgId else {
            phase = .failed(.session("This page could not be signed in."))
            return
        }
        var components = URLComponents()
        components.path = "/authenticate/native"
        components.queryItems = [
            URLQueryItem(name: "orgId", value: orgId),
            URLQueryItem(name: "returnTo", value: currentPath ?? currentRoute?.path ?? "/"),
        ]
        guard let relative = components.string, let url = environment.url(for: relative) else { return }
        track { await $0.requestLeave(.loadURL(url)) }
    }

    /// A fragment-only change of the current document.
    private func isSameDocument(_ url: URL) -> Bool {
        guard let current = webView.url,
              var a = URLComponents(url: current, resolvingAgainstBaseURL: false),
              var b = URLComponents(url: url, resolvingAgainstBaseURL: false),
              b.fragment != nil else { return false }
        a.fragment = nil
        b.fragment = nil
        return a == b
    }

    static func displayTitle(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for suffix in [" · Nimbalyst", " - Nimbalyst", " | Nimbalyst"] where trimmed.hasSuffix(suffix) {
            return String(trimmed.dropLast(suffix.count))
        }
        return trimmed
    }

    static func sessionFailureMessage(_ code: ConsoleSessionDeliveryError, reason: String?) -> String {
        switch code {
        case .notAMember: return "You are not a member of this team."
        case .unavailable: return "Team sign-in is not available right now."
        case .orgAuthRequired: return "This team requires additional sign-in."
        case .failed:
            switch reason {
            case "network", "timeout": return "Could not reach Nimbalyst to sign this page in."
            case "personal_session_unavailable", "unauthorized", "signed_out": return "Your Nimbalyst sign-in needs to be refreshed."
            default: return "This page could not be signed in."
            }
        }
    }
}

// MARK: - WKNavigationDelegate / WKUIDelegate

extension PagesWebController: WKNavigationDelegate, WKUIDelegate {
    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        let action = ConsoleNavigationPolicy.decide(
            url: url,
            isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
            opensNewWindow: navigationAction.targetFrame == nil,
            environment: environment
        )
        // A full-document navigation the page started while edits are unsynced
        // would drop the console's retained edit handles: hold it for the leave
        // guard instead. Same-document (fragment) changes and subframes are fine.
        if action == .allow, unsynced, navigationAction.targetFrame?.isMainFrame == true, !isSameDocument(url) {
            decisionHandler(.cancel)
            track { await $0.requestLeave(.loadURL(url)) }
            return
        }
        decisionHandler(action == .allow ? .allow : .cancel)
        if action != .allow && action != .cancel {
            // After the decision, so a replacement load never races the cancelled one.
            DispatchQueue.main.async { [weak self] in self?.perform(action) }
        }
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode >= 500 {
            decisionHandler(.cancel)
            phase = .failed(.server(response.statusCode))
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // An older console that never posts `ready` must not leave a spinner over the page.
        if phase == .loading { phase = .ready }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadError(error)
    }

    private func handleLoadError(_ error: Error) {
        let nsError = error as NSError
        // A policy-cancelled navigation or one replaced by a newer load is not a failure.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == WKError.errorDomain && nsError.code == 102 { return }
        logger.error("Console load failed: \(nsError.domain) \(nsError.code)")
        if nsError.domain == NSURLErrorDomain,
           [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorDataNotAllowed].contains(nsError.code) {
            phase = .failed(.offline)
        } else {
            phase = .failed(.load(nsError.localizedDescription))
        }
    }

    /// iOS kills background web content freely. Reload the page, and say so if
    /// unsynced edits went with it.
    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        terminationsWithoutReady += 1
        bridgeReady = false
        editing = false
        unsynced = false
        flush.contentProcessTerminated()
        logger.warning("Console web content process terminated (\(self.terminationsWithoutReady))")
        guard terminationsWithoutReady <= 2 else {
            phase = .failed(.load("The page stopped responding."))
            return
        }
        retry()
    }

    public func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            perform(ConsoleNavigationPolicy.decide(url: url, isMainFrame: true, opensNewWindow: true, environment: environment))
        }
        return nil
    }
}

/// Breaks the WKUserContentController -> handler retain cycle.
@MainActor
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: PagesWebController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.receive(message)
    }
}
#endif
