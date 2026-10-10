import XCTest
@testable import NimbalystNative

/// Every row of the Pages navigation table (plan section 5), plus the inbound
/// link parsers that feed it.
final class ConsoleNavigationPolicyTests: XCTestCase {
    private let team = "https://console.nimbalyst.com/org/organization-abc/project/p1"

    private func decide(_ raw: String, main: Bool = true, newWindow: Bool = false) -> ConsoleNavigationAction {
        ConsoleNavigationPolicy.decide(url: URL(string: raw)!, isMainFrame: main, opensNewWindow: newWindow)
    }

    func testPolicyTable() {
        let cases: [(String, Bool, Bool, ConsoleNavigationAction)] = [
            // Team paths stay in the web view.
            ("\(team)/wiki", true, false, .allow),
            ("\(team)/pages", true, false, .allow),
            ("\(team)/document/d1", true, false, .allow),
            ("\(team)/page/item/NIM-1", true, false, .allow),
            ("\(team)/page/type/t1", true, false, .allow),
            ("\(team)/view/v1", true, false, .allow),
            ("\(team)/marks", true, false, .allow),
            ("\(team)/trackers/item/i1?tab=body#top", true, false, .allow),
            ("https://console.nimbalyst.com/", true, false, .allow),
            ("https://console.nimbalyst.com/authenticate/native?orgId=organization-abc", true, false, .allow),
            // A `_blank` team link loads in the same web view.
            ("\(team)/wiki", true, true, .load(URL(string: "\(team)/wiki")!)),
            // Personal pages are desktop-only.
            ("https://console.nimbalyst.com/app/doc/1", true, false, .personalPages),
            ("nimbalyst://console/app/doc/1", true, false, .personalPages),
            // Console login never renders in the embed.
            ("https://console.nimbalyst.com/login", true, false, .reauthenticate),
            ("https://console.nimbalyst.com/authenticate?token=x", true, false, .reauthenticate),
            ("https://console.nimbalyst.com/authenticate/other", true, false, .reauthenticate),
            // nimbalyst://console rewrites to the https console path.
            ("nimbalyst://console/org/organization-abc/project/p1/wiki", true, false, .load(URL(string: "\(team)/wiki")!)),
            ("nimbalyst://console/org/../etc", true, false, .cancel),
            // Known app routes go to the existing router; auth callbacks never do.
            ("nimbalyst://session/s1", true, false, .appRoute(.session(id: "s1"))),
            ("nimbalyst://pair?data=x", true, false, .appRoute(.openPairingScanner)),
            ("nimbalyst://auth/callback?token=x", true, false, .cancel),
            // Other app links are desktop-only in v1.
            ("nimbalyst://tracker/NIM-1", true, false, .desktopOnly),
            ("nimbalyst://invite/abc", true, false, .desktopOnly),
            // Other http(s), and console paths the embed does not host, open in Safari.
            ("https://example.com/a", true, false, .openExternally(URL(string: "https://example.com/a")!)),
            ("https://example.com/a", true, true, .openExternally(URL(string: "https://example.com/a")!)),
            ("http://console.nimbalyst.com/org/organization-abc", true, false, .openExternally(URL(string: "http://console.nimbalyst.com/org/organization-abc")!)),
            ("https://console.nimbalyst.com/public/wiki/x", true, false, .openExternally(URL(string: "https://console.nimbalyst.com/public/wiki/x")!)),
            ("https://console.nimbalyst.com/connect", true, false, .openExternally(URL(string: "https://console.nimbalyst.com/connect")!)),
            ("mailto:a@b.c", true, false, .openExternally(URL(string: "mailto:a@b.c")!)),
            // Anything else is cancelled.
            ("about:blank", true, false, .allow),
            ("about:srcdoc", true, false, .cancel),
            ("javascript:alert(1)", true, false, .cancel),
            ("file:///etc/passwd", true, false, .cancel),
            ("data:text/html,hi", true, false, .cancel),
            // Subframes load what the CSP allows and never leave the app.
            ("https://js.stytch.com/frame", false, false, .allow),
            ("about:srcdoc", false, false, .allow),
            ("nimbalyst://session/s1", false, false, .cancel),
            ("javascript:alert(1)", false, false, .cancel),
        ]
        for (raw, main, newWindow, expected) in cases {
            XCTAssertEqual(decide(raw, main: main, newWindow: newWindow), expected, raw)
        }
    }

    // R4-5: encoded dot segments are judged by the path the server will see.
    func testEncodedDotSegmentsAreJudgedByTheCanonicalPath() {
        let escape = ".%2e/.%2e/.%2e/.%2e"
        // `nimbalyst://console/org/o/project/p/.%2e/.%2e/.%2e/.%2e/app/private` normalizes to /app/private.
        XCTAssertEqual(decide("nimbalyst://console/org/organization-abc/project/p1/\(escape)/app/private"), .personalPages)
        XCTAssertEqual(decide("\(team)/\(escape)/app/private"), .personalPages)
        XCTAssertEqual(decide("\(team)/%2e./%2E%2E/%2e%2e/%2e./login"), .reauthenticate)
        XCTAssertEqual(ConsoleRoute.canonicalPath("/org/o/project/p/\(escape)/app/private"), "/app/private")
        XCTAssertEqual(
            NimbalystExternalURLRouter.route(URL(string: "nimbalyst://console/org/organization-abc/project/p1/\(escape)/app/x")!),
            .unsupported,
            "never a team route"
        )

        for segment in [".%2e", "%2e.", "%2E%2E", "%2e", "a%2fb", "a%2Fb", "a%5cb", "%zz", "%c3%28", "%00"] {
            XCTAssertNil(ConsoleRoute(path: "/org/organization-abc/project/p1/\(segment)/wiki"), segment)
        }
        XCTAssertNil(ConsoleRoute(path: "/org/organization-abc/project/%2e%2e/wiki"))
        XCTAssertEqual(ConsoleRoute(path: "/org/organization-abc/project/caf%C3%A9/wiki")?.teamProjectId, "caf\u{e9}")

        // Native loads pass the same policy, on the canonical path.
        XCTAssertFalse(ConsoleNavigationPolicy.allowsNativeLoad(URL(string: "\(team)/\(escape)/app/private")!))
        XCTAssertFalse(ConsoleNavigationPolicy.allowsNativeLoad(URL(string: "https://example.com/org/organization-abc/project/p1/wiki")!))
        XCTAssertTrue(ConsoleNavigationPolicy.allowsNativeLoad(URL(string: "\(team)/wiki")!))
        XCTAssertTrue(ConsoleNavigationPolicy.allowsNativeLoad(URL(string: "https://console.nimbalyst.com/authenticate/native?orgId=organization-abc&returnTo=%2Forg")!))
    }

    func testExternalRouterConsoleCase() {
        XCTAssertEqual(
            NimbalystExternalURLRouter.route(URL(string: "nimbalyst://console/org/organization-abc/project/p1/page/item/NIM-1?x=1")!),
            .console(ConsoleRoute(path: "/org/organization-abc/project/p1/page/item/NIM-1?x=1")!)
        )
        XCTAssertEqual(NimbalystExternalURLRouter.route(URL(string: "nimbalyst://console/app/x")!), .consolePersonal)
        // Org-level pages and malformed paths are not Pages destinations.
        XCTAssertEqual(NimbalystExternalURLRouter.route(URL(string: "nimbalyst://console/org/organization-abc/admin")!), .unsupported)
        XCTAssertEqual(NimbalystExternalURLRouter.route(URL(string: "nimbalyst://console/org/organization-abc/project/%2e%2e/x")!), .unsupported)
        XCTAssertEqual(NimbalystExternalURLRouter.route(URL(string: "nimbalyst://session/s1")!), .session(id: "s1"))
    }

    func testConsoleRouteParsing() {
        let route = ConsoleRoute(path: "/org/organization-abc/project/p%201/wiki")
        XCTAssertEqual(route?.orgId, "organization-abc")
        XCTAssertEqual(route?.teamProjectId, "p 1")
        XCTAssertNil(ConsoleRoute(path: "/org/my-slug/project/p1")?.orgId, "a slug is a route key, not an org id")
        XCTAssertNil(ConsoleRoute(path: "/org//project/p1"))
        XCTAssertNil(ConsoleRoute(path: "/org/a/project/p1/../../app"))
        XCTAssertNil(ConsoleRoute(path: "/app/x"))
        XCTAssertNil(ConsoleRoute(url: URL(string: "https://evil.example/org/organization-abc/project/p1")!))
        XCTAssertEqual(ConsoleRoute.wiki(orgId: "organization-abc", teamProjectId: "p1")?.path, "/org/organization-abc/project/p1/wiki")
    }

    @MainActor
    func testLinkInboxTakesOnlyTeamPages() async {
        let inbox = ConsoleLinkInbox()
        XCTAssertFalse(inbox.open(URL(string: "https://example.com/org/organization-abc/project/p1/wiki")!))
        XCTAssertFalse(inbox.open(URL(string: "https://console.nimbalyst.com/app/x")!))
        XCTAssertFalse(inbox.open(path: "/org/organization-abc/admin"))
        XCTAssertNil(inbox.pending)
        XCTAssertTrue(inbox.open(URL(string: "\(team)/document/d1")!))
        XCTAssertEqual(inbox.pending?.path, "/org/organization-abc/project/p1/document/d1", "held for a cold-start subscriber")
        XCTAssertTrue(inbox.open(path: "/org/organization-abc/project/p1/marks"), "push consolePath")
    }

    // R2-W6: a mounted (warm) view handling links the way WorkspaceNavigationView
    // does gets each emitted route, in order, and the inbox ends empty, so a later
    // remount does not replay a stale link.
    @MainActor
    func testWarmSubscriberGetsEveryLinkAndClearsIt() async throws {
        let inbox = ConsoleLinkInbox()
        let cold = try XCTUnwrap(ConsoleRoute(path: "/org/organization-abc/project/p1/wiki"))
        inbox.open(cold)
        var selected: [String] = []
        let subscription = inbox.routes.sink { route in
            // Same handler shape as the view: act on the value, then acknowledge.
            selected.append(route.path)
            inbox.acknowledge(route)
        }
        defer { subscription.cancel() }
        XCTAssertEqual(selected, [cold.path], "a link pending before mount is delivered once")
        for _ in 0..<5 { await Task.yield() }
        XCTAssertNil(inbox.pending)

        XCTAssertTrue(inbox.open(URL(string: "\(team)/document/a")!))
        XCTAssertTrue(inbox.open(URL(string: "\(team)/document/b")!))
        XCTAssertEqual(selected.suffix(2), ["/org/organization-abc/project/p1/document/a", "/org/organization-abc/project/p1/document/b"],
                       "the handler sees the new value, not the one still in `pending` during willSet")
        for _ in 0..<5 { await Task.yield() }
        XCTAssertNil(inbox.pending, "acknowledged after the set landed, so nothing replays")

        var replayed: [String] = []
        let remount = inbox.routes.sink { replayed.append($0.path) }
        remount.cancel()
        XCTAssertTrue(replayed.isEmpty)
    }

    func testBridgeMessageParsing() {
        XCTAssertEqual(ConsoleBridgeMessage.parse(["type": "ready", "protocol": 1]), .ready(protocolVersion: 1))
        XCTAssertEqual(ConsoleBridgeMessage.parse(["type": "route", "path": "/org/a", "title": "Home", "canGoBack": true]), .route(path: "/org/a", title: "Home", canGoBack: true))
        XCTAssertEqual(ConsoleBridgeMessage.parse(["type": "sessionExpired", "requestId": "r1", "orgId": NSNull()]), .sessionExpired(requestId: "r1", orgId: nil))
        XCTAssertEqual(ConsoleBridgeMessage.parse(["type": "flushResult", "requestId": "r", "status": "timed-out", "detail": NSNull()]), .flushResult(requestId: "r", result: .init(status: .timedOut)))
        XCTAssertNil(ConsoleBridgeMessage.parse(["type": "requestSession", "requestId": "r1"]), "requestSession needs an org")
        XCTAssertNil(ConsoleBridgeMessage.parse(["type": "deliverSession"]))
        XCTAssertNil(ConsoleBridgeMessage.parse("ready"))
        XCTAssertEqual(ConsoleBridgeMessage.parse(["type": "documentStart", "nonce": String(repeating: "a1", count: 16)]),
                       .documentStart(nonce: String(repeating: "a1", count: 16)))
        XCTAssertNil(ConsoleBridgeMessage.parse(["type": "documentStart", "nonce": "short"]))
    }
}
