import XCTest
import WebKit
@testable import NimbalystNative

/// Answers the mint route with a fixed session.
private final class MintStub: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _urls: [URL] = []
    nonisolated(unsafe) private static var _delay: TimeInterval = 0
    static var urls: [URL] { lock.withLock { _urls } }
    static var delay: TimeInterval {
        get { lock.withLock { _delay } }
        set { lock.withLock { _delay = newValue } }
    }
    static func reset() { lock.withLock { _urls = []; _delay = 0 } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.lock.withLock { Self._urls.append(url) }
        let body = #"{"sessionToken":"minted-token","sessionJwt":"minted.jwt","orgId":"organization-fixture"}"#
        let respond = { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        }
        if Self.delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + Self.delay, execute: respond) } else { respond() }
    }
    override func stopLoading() {}
}

@MainActor
private final class NoStores: ConsoleWebDataStoreRemoving {
    func removeDataStore(identifier: UUID) async throws {}
}

@MainActor
private final class NoBackgroundTasks: BackgroundTaskScheduling {
    func begin(name: String, expiration: @escaping @MainActor () -> Void) -> Int? { 1 }
    func end(_ id: Int) {}
}

/// A stand-in console page speaking the bridge from `web-console/src/embedded`.
/// `window.__flushStatus` sets what `flushPending` answers.
private let fixtureHTML = """
<!doctype html><html><head><title>Fixture Page · Nimbalyst</title></head><body>
<a id="personal" href="/app/doc/1">Personal</a>
<a id="console-link" href="nimbalyst://console/org/organization-fixture/project/p1/marks">Marks</a>
<script>
  const marker = window.__NIMBALYST_EMBED__;
  window.__delivered = null;
  window.__flushStatus = 'acknowledged';
  window.__flushDelayMs = 0;
  function post(message) { window.webkit.messageHandlers[marker.bridge].postMessage(message); }
  if (marker) {
    Object.defineProperty(window, '__nimbalystConsoleBridge', { value: Object.freeze({
      protocol: 1,
      deliverSession(payload) { window.__delivered = payload; return true; },
      async flushPending(timeoutMs) {
        if (window.__flushDelayMs) await new Promise((r) => setTimeout(r, window.__flushDelayMs));
        return { status: window.__flushStatus, detail: null };
      },
      discardUnsynced() { window.__discarded = (window.__discarded || 0) + 1; return 2; },
    }) });
    post({ type: 'ready', protocol: 1 });
    post({ type: 'route', path: location.pathname, title: document.title, canGoBack: false });
  }
  window.__subframePosted = false;
  const frame = document.createElement('iframe');
  frame.srcdoc = "<script>parent.__subframePosted = true; window.webkit.messageHandlers.nimbalystConsole.postMessage({type:'openPersonal', path:'/app/x'});<\\/script>";
  document.body.appendChild(frame);
</script>
</body></html>
"""

/// One controller over the fixture page, with the selection under test control.
@MainActor
private final class Harness {
    var account = ConsoleAccountContext(accountId: "acct", apiBase: URL(string: "https://sync.example")!, generation: 1)
    var loads: [URL] = []
    var opened: [URL] = []
    /// Runs inside the personal-JWT read (a refresh in flight).
    var duringJwtRead: (() async -> Void)?
    let broker: ConsoleSessionBroker
    var controller: PagesWebController!

    init() {
        MintStub.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MintStub.self]
        var current: (() -> ConsoleAccountContext?)!
        var hook: (() -> (() async -> Void)?)!
        broker = ConsoleSessionBroker(
            credentials: ConsoleCredentials(
                account: { current() },
                personalJwt: { context in
                    guard current() == context else { return nil }
                    await hook()?()
                    return current() == context ? "personal.jwt" : nil
                }
            ),
            dataStores: NoStores(),
            urlSession: URLSession(configuration: configuration),
            orgChoices: ConsoleOrgChoiceStore(defaults: UserDefaults(suiteName: UUID().uuidString)!),
            pendingRemovals: ConsoleStoreRemovalLedger(defaults: UserDefaults(suiteName: UUID().uuidString)!)
        )
        current = { [weak self] in self?.account }
        hook = { [weak self] in self?.duringJwtRead }
        controller = PagesWebController(
            account: account,
            broker: broker,
            dataStore: .nonPersistent(),
            appVersion: "1.0",
            flush: PagesFlushCoordinator(defaults: UserDefaults(suiteName: UUID().uuidString)!, backgroundTasks: NoBackgroundTasks()),
            isOnline: { true },
            hooks: .init(openExternally: { [weak self] in self?.opened.append($0) }, appRoute: { _ in }),
            loader: { [weak self] webView, url in
                self?.loads.append(url)
                webView.loadHTMLString(fixtureHTML, baseURL: url)
            }
        )
    }

    func js(_ source: String) async throws -> Any? {
        try await controller.webView.evaluateJavaScript(source)
    }
}

/// Runs on macOS `swift test` with a real WKWebView; the page is loaded with
/// the console origin as its base URL, so the origin checks are the real ones.
@MainActor
final class PagesWebViewTests: XCTestCase {
    private let wiki = ConsoleRoute.wiki(orgId: "organization-fixture", teamProjectId: "p1")!
    private let trackers = ConsoleRoute.trackers(orgId: "organization-fixture", teamProjectId: "p1")!

    private func waitUntil(_ timeout: TimeInterval = 10, _ condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .milliseconds(50))
        }
        return false
    }

    private func openReady(_ harness: Harness) async {
        harness.controller.open(wiki)
        let ready = await waitUntil { harness.controller.bridgeReady && harness.controller.title == "Fixture Page" }
        XCTAssertTrue(ready, "phase=\(harness.controller.phase) title=\(harness.controller.title)")
    }

    func testFixturePageSpeaksTheBridge() async throws {
        let harness = Harness()
        let controller = harness.controller!
        defer { controller.tearDown() }

        // ready + route: native title from the console.
        await openReady(harness)
        XCTAssertEqual(controller.phase, .ready)
        XCTAssertEqual(harness.loads.map(\.absoluteString), ["https://console.nimbalyst.com/org/organization-fixture/project/p1/wiki"])

        // A subframe's message is dropped, even from the same origin.
        let subframePosted = await waitUntil { (try? await harness.js("window.__subframePosted")) as? Bool == true }
        XCTAssertTrue(subframePosted)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertNil(controller.sheet, "subframe openPersonal must not reach native")

        // sessionExpired with no org: native mints for the page's org and delivers over the bridge.
        _ = try await harness.js("window.webkit.messageHandlers.nimbalystConsole.postMessage({type:'sessionExpired', requestId:'r1', orgId:null}); 1")
        let delivered = await waitUntil {
            (try? await harness.js("window.__delivered && window.__delivered.sessionToken")) as? String == "minted-token"
        }
        XCTAssertTrue(delivered)
        let deliveredOrg = try await harness.js("window.__delivered.orgId") as? String
        XCTAssertEqual(deliveredOrg, "organization-fixture")
        XCTAssertEqual(MintStub.urls.map(\.path), ["/auth/console-session"])
        XCTAssertFalse(harness.loads.contains { $0.absoluteString.contains("minted") }, "tokens never travel in a URL")

        // flushPending and discardUnsynced through the real bridge.
        let flushed = await controller.flushPending(timeoutMs: 100)
        XCTAssertEqual(flushed, ConsoleFlushResult(status: .acknowledged))
        let discarded = await controller.discardUnsynced()
        XCTAssertEqual(discarded, 2)

        // A Personal link is cancelled by the policy and raises the native notice.
        _ = try await harness.js("document.getElementById('personal').click(); 1")
        let personal = await waitUntil { controller.sheet == .personalPages }
        XCTAssertTrue(personal)
        XCTAssertEqual(controller.webView.url?.path, "/org/organization-fixture/project/p1/wiki")
        XCTAssertTrue(harness.opened.isEmpty)

        // Content process killed with unsynced edits: reload, and say so.
        controller.handle(.editState(editing: true, unsynced: true))
        controller.webViewWebContentProcessDidTerminate(controller.webView)
        XCTAssertEqual(harness.loads.count, 2, "reloads the current URL")
        XCTAssertEqual(harness.loads.last?.path, "/org/organization-fixture/project/p1/wiki")
        XCTAssertTrue(controller.lostEditsNotice)
        XCTAssertFalse(controller.unsynced)
    }

    // R2-W1: a web view bound to a previous selection never receives a session,
    // even when the selection changes while its request is being answered.
    func testSessionForAPreviousSelectionIsNeverDelivered() async throws {
        let harness = Harness()
        defer { harness.controller.tearDown() }
        await openReady(harness)
        // Re-pairing (same account id, new generation) lands during the JWT read.
        harness.duringJwtRead = { [unowned harness] in
            harness.account = ConsoleAccountContext(accountId: "acct", apiBase: URL(string: "https://sync.example")!, generation: 2)
        }
        _ = try await harness.js("window.webkit.messageHandlers.nimbalystConsole.postMessage({type:'requestSession', requestId:'r1', orgId:'organization-fixture'}); 1")
        try await Task.sleep(for: .milliseconds(500))
        let delivered = try await harness.js("window.__delivered === null")
        XCTAssertEqual(delivered as? Bool, true, "nothing reaches the old web view")
        XCTAssertTrue(MintStub.urls.isEmpty, "nothing is minted for it either")
    }

    // R2-W3: teardown cancels bridge work in flight and lets the controller (and
    // its WKWebView, which pins the data store) go, so the store can be removed.
    func testTearDownReleasesTheWebViewWithWorkInFlight() async throws {
        var harness: Harness? = Harness()
        var entered = false
        harness!.duringJwtRead = { entered = true; try? await Task.sleep(for: .seconds(30)) }
        await openReady(harness!)
        _ = try await harness!.js("window.webkit.messageHandlers.nimbalystConsole.postMessage({type:'sessionExpired', requestId:'r1', orgId:null}); 1")
        let started = await waitUntil { entered }
        XCTAssertTrue(started)

        weak var released = harness!.controller
        harness!.controller.tearDown()
        XCTAssertNil(harness!.controller.webView.superview)
        harness!.controller = nil
        harness = nil
        let gone = await waitUntil(3) { released == nil }
        XCTAssertTrue(gone, "a pending session request must not keep the web view alive")
    }

    // R2-W4: replacing the page with unacknowledged edits flushes first, then asks;
    // "Keep Editing" hands back the page still shown, "Leave" discards and loads.
    func testReplacingThePageGoesThroughTheLeaveGuard() async throws {
        let harness = Harness()
        let controller = harness.controller!
        defer { controller.tearDown() }
        await openReady(harness)

        // Edits the server acknowledges on flush: the replacement just happens.
        controller.handle(.editState(editing: true, unsynced: true))
        XCTAssertFalse(controller.webView.allowsBackForwardNavigationGestures, "edge-swipe would skip the guard")
        await controller.requestOpen(trackers)
        XCTAssertNil(controller.pendingLeave)
        XCTAssertEqual(harness.loads.last?.path, "/org/organization-fixture/project/p1/trackers")
        let reloaded = await waitUntil { controller.bridgeReady }
        XCTAssertTrue(reloaded)

        // Edits that do not reach the server: ask, and load nothing yet.
        _ = try await harness.js("window.__flushStatus = 'timed-out'; 1")
        controller.handle(.editState(editing: true, unsynced: true))
        let loadsBefore = harness.loads.count
        await controller.requestOpen(wiki)
        XCTAssertEqual(controller.pendingLeave, .replaceRoute(wiki))
        XCTAssertEqual(harness.loads.count, loadsBefore)
        XCTAssertEqual(controller.cancelPendingLeave(), trackers, "the sidebar re-selects the page still shown")
        XCTAssertNil(controller.pendingLeave)

        // Back with no web history asks too.
        let leftAtOnce = await controller.requestBack()
        XCTAssertFalse(leftAtOnce)
        XCTAssertEqual(controller.pendingLeave, .leaveScreen)
        _ = controller.cancelPendingLeave()

        await controller.requestOpen(wiki)
        let leave = try XCTUnwrap(controller.confirmPendingLeave())
        let leavesScreen = await leave.value
        XCTAssertFalse(leavesScreen)
        let discardCalls = try await harness.js("window.__discarded") as? Int
        XCTAssertEqual(discardCalls, 1, "Leave discards the console's unacknowledged edits")
        XCTAssertEqual(harness.loads.count, loadsBefore + 1)
        XCTAssertEqual(harness.loads.last?.path, "/org/organization-fixture/project/p1/wiki")
    }

    // R2-W4: document-replacing loads that do not come from a sidebar row
    // (a page-started full navigation, a nimbalyst://console link) go through
    // the same guard, and load nothing until the reader answers.
    func testEveryDocumentReplacingLoadGoesThroughTheGuard() async throws {
        let harness = Harness()
        let controller = harness.controller!
        defer { controller.tearDown() }
        await openReady(harness)
        _ = try await harness.js("window.__flushStatus = 'timed-out'; 1")
        controller.handle(.editState(editing: true, unsynced: true))
        let loadsBefore = harness.loads.count

        // The page itself navigates the whole document away.
        _ = try await harness.js("window.location.href = '/org/organization-fixture/project/p1/trackers'; 1")
        let heldPageNavigation = await waitUntil { controller.pendingLeave != nil }
        XCTAssertTrue(heldPageNavigation)
        XCTAssertEqual(controller.pendingLeave, .loadURL(URL(string: "https://console.nimbalyst.com/org/organization-fixture/project/p1/trackers")!))
        XCTAssertEqual(controller.webView.url?.path, "/org/organization-fixture/project/p1/wiki", "still on the edited page")
        _ = controller.cancelPendingLeave()

        // A nimbalyst://console link rewrites to a console load: also held.
        _ = try await harness.js("document.getElementById('console-link').click(); 1")
        let heldLink = await waitUntil { controller.pendingLeave != nil }
        XCTAssertTrue(heldLink)
        XCTAssertEqual(controller.pendingLeave, .loadURL(URL(string: "https://console.nimbalyst.com/org/organization-fixture/project/p1/marks")!))
        XCTAssertEqual(harness.loads.count, loadsBefore)

        // "Leave" discards, then loads exactly that document.
        let leave = try XCTUnwrap(controller.confirmPendingLeave())
        _ = await leave.value
        XCTAssertEqual(harness.loads.count, loadsBefore + 1)
        XCTAssertEqual(harness.loads.last?.path, "/org/organization-fixture/project/p1/marks")
    }

    // R2-W7: select B with unsynced edits, then C before B's flush returns.
    // B's late answer must neither load nor ask over C.
    func testAStaleLeaveRequestNeverActsAfterANewerOne() async throws {
        let harness = Harness()
        let controller = harness.controller!
        defer { controller.tearDown() }
        await openReady(harness)
        _ = try await harness.js("window.__flushDelayMs = 300; 1")
        controller.handle(.editState(editing: true, unsynced: true))
        let loadsBefore = harness.loads.count
        let marks = try XCTUnwrap(ConsoleRoute(path: "/org/organization-fixture/project/p1/marks"))

        let toTrackers = Task { await controller.requestOpen(trackers) }
        try await Task.sleep(for: .milliseconds(100))
        _ = try await harness.js("window.__flushDelayMs = 0; 1")
        await controller.requestOpen(marks)
        await toTrackers.value
        try await Task.sleep(for: .milliseconds(100))

        XCTAssertEqual(harness.loads.count, loadsBefore + 1, "only the newest request loads")
        XCTAssertEqual(harness.loads.last?.path, "/org/organization-fixture/project/p1/marks")
        XCTAssertEqual(controller.currentRoute, marks)
        XCTAssertNil(controller.pendingLeave)
    }

    // R2-W8: the delivery script runs in whatever document is current when it
    // executes. If the asking document was replaced while minting, the new
    // document (same origin, different nonce) gets nothing.
    func testSessionIsDeliveredOnlyIntoTheDocumentThatAsked() async throws {
        let harness = Harness()
        let controller = harness.controller!
        defer { controller.tearDown() }
        await openReady(harness)
        let firstNonce = try XCTUnwrap(controller.documentNonce)
        MintStub.delay = 0.5
        _ = try await harness.js("window.webkit.messageHandlers.nimbalystConsole.postMessage({type:'requestSession', requestId:'r1', orgId:'organization-fixture'}); 1")
        let minting = await waitUntil { !MintStub.urls.isEmpty }
        XCTAssertTrue(minting)

        // Replace the document while the mint is in flight.
        controller.retry()
        let reloaded = await waitUntil { controller.bridgeReady && controller.documentNonce != nil && controller.documentNonce != firstNonce }
        XCTAssertTrue(reloaded)
        try await Task.sleep(for: .milliseconds(800))
        let delivered = try await harness.js("window.__delivered === null")
        XCTAssertEqual(delivered as? Bool, true, "a newer document never receives the session another document asked for")
        let pageNonce = try await harness.js("window.__nimbalystDocumentNonce") as? String
        XCTAssertEqual(pageNonce, controller.documentNonce, "the page cannot overwrite the nonce, and native tracks the current one")
    }
}
