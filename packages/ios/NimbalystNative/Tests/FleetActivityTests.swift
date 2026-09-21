import XCTest
@testable import NimbalystNative

/// The card's model layer.
///
/// Worth testing where the views are not: the decode path is fed by an APNs
/// payload built in a different repo, and a decode failure on a Live Activity is
/// invisible — the card simply stops updating, with nothing on screen and
/// nothing in a log to say why.
final class FleetActivityTests: XCTestCase {
    private func decodeState(_ json: String) throws -> FleetActivityAttributes.ContentState {
        try JSONDecoder().decode(
            FleetActivityAttributes.ContentState.self,
            from: Data(json.utf8)
        )
    }

    func testDecodesTheServerContentStateVerbatim() throws {
        let state = try decodeState("""
        {
          "running": 3, "needsApproval": 1, "needsDecision": 1, "failed": 1,
          "stalled": 0, "unread": 2, "overflow": 1, "revision": 42,
          "updatedAt": 1700000000000, "staleAfterMs": 720000,
          "rows": [
            {"sessionId":"s1","title":"Collab retry","project":"stravu-editor","state":"approval","since":1699999000000}
          ]
        }
        """)

        XCTAssertEqual(state.running, 3)
        XCTAssertEqual(state.needsYou, 2)
        XCTAssertEqual(state.revision, 42)
        XCTAssertEqual(state.rows.first?.state, .approval)
        XCTAssertEqual(state.rows.first?.url?.absoluteString, "nimbalyst://session/s1")
        XCTAssertEqual(state.staleDate, Date(timeIntervalSince1970: 1700000720))
    }

    /// A desktop newer than this build can name a state it has never heard of.
    /// A card that throws on decode shows nothing at all, which is strictly
    /// worse than a row with a neutral dot.
    func testSurvivesAnUnknownRowStateAndMissingFields() throws {
        let state = try decodeState("""
        {
          "running": 1,
          "rows": [{"sessionId":"s1","title":"T","project":"p","state":"telepathy","since":1}]
        }
        """)

        XCTAssertEqual(state.rows.first?.state, .unknown)
        XCTAssertEqual(state.unread, 0)
        XCTAssertEqual(state.staleAfterMs, 12 * 60_000)
    }

    func testIsActiveMatchesTheDesktopsIdleRule() {
        XCTAssertFalse(FleetActivityAttributes.ContentState().isActive)
        // The phone is where you catch up on a session that finished while you
        // were away, which is the one thing the menu bar cannot do.
        XCTAssertTrue(FleetActivityAttributes.ContentState(unread: 1).isActive)
        XCTAssertTrue(FleetActivityAttributes.ContentState(running: 1).isActive)
    }

    func testFooterCollapsesEverythingAmbient() {
        let state = FleetActivityAttributes.ContentState(
            running: 3, failed: 1, stalled: 1, unread: 2, overflow: 1
        )
        XCTAssertEqual(
            state.footerSummary,
            "3 running · 1 gone quiet · 1 failed · 2 unread · 1 more waiting"
        )
    }

    func testHeadlineAnswersWhatNeedsMeFirst() {
        XCTAssertEqual(
            FleetActivityFormatting.headline(needsYou: 2, failed: 1, stalled: 0, running: 3, unread: 0),
            "2 need you"
        )
        XCTAssertEqual(
            FleetActivityFormatting.headline(needsYou: 1, failed: 0, stalled: 0, running: 0, unread: 0),
            "1 needs you"
        )
        // A blank header on a visible card reads as a card that failed to load.
        XCTAssertEqual(
            FleetActivityFormatting.headline(needsYou: 0, failed: 0, stalled: 0, running: 0, unread: 0),
            "All clear"
        )
    }

    func testFrozenElapsedLabelRollsOverIntoHours() {
        XCTAssertEqual(FleetActivityFormatting.elapsedLabel(seconds: 872), "14:32")
        XCTAssertEqual(FleetActivityFormatting.elapsedLabel(seconds: 3847), "1:04:07")
        XCTAssertEqual(FleetActivityFormatting.elapsedLabel(seconds: -5), "0:00")
    }
}

@MainActor
private final class TestFleetObserver: FleetActivityObserving {
    var areActivitiesEnabled = false
    var startCount = 0
    var stopped = false
    var pushToken: ((String) -> Void)?
    var updateToken: ((String, String) -> Void)?
    var ended: ((String) -> Void)?
    var reconcileAction: (() -> Void)?
    func start(pushToken: @escaping (String) -> Void, updateToken: @escaping (String, String) -> Void, ended: @escaping (String) -> Void) {
        startCount += 1
        stopped = false
        self.pushToken = pushToken
        self.updateToken = updateToken
        self.ended = ended
    }
    func reconcile() { reconcileAction?() }
    func stop() { stopped = true }
    func endAll() async {}
}

extension FleetActivityTests {
    @MainActor
    func testPermissionRecoveryRestartsObservationBeforeReassertingTokens() {
        let observer = TestFleetObserver()
        let suite = "FleetActivityTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = FleetActivityController(observer: observer, defaults: defaults)
        var registered: [(String, LiveActivityTokenKind)] = []
        var invalidatedAll = 0
        controller.onTokenReceived = { registered.append(($0, $1)) }
        controller.onTokenInvalidated = { kind, _ in if kind == nil { invalidatedAll += 1 } }
        controller.start()
        XCTAssertEqual(observer.startCount, 0)
        observer.areActivitiesEnabled = true
        observer.reconcileAction = { observer.pushToken?("start-token") }
        controller.resendTokens()
        XCTAssertEqual(observer.startCount, 1)
        XCTAssertTrue(registered.contains { $0.0 == "start-token" && $0.1 == .pushToStart })
        controller.resendTokens()
        XCTAssertEqual(observer.startCount, 1, "Reconnecting must not duplicate observers")
        observer.areActivitiesEnabled = false
        controller.resendTokens()
        XCTAssertTrue(observer.stopped)
        XCTAssertNil(controller.pushToStartToken)
        XCTAssertEqual(invalidatedAll, 2)
        observer.pushToken?("late-token")
        XCTAssertNil(controller.pushToStartToken, "Cancelled observers cannot republish registration")
    }

    @MainActor
    func testOlderActivityEndingCannotInvalidateTheCurrentTokenAndReconnectDropsEndedState() throws {
        let observer = TestFleetObserver()
        observer.areActivitiesEnabled = true
        let suite = "FleetActivityTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let controller = FleetActivityController(observer: observer, defaults: defaults)
        var retired: [String] = []
        controller.onTokenInvalidated = { _, token in if let token { retired.append(token) } }
        controller.start()
        observer.updateToken?("older", "old-token")
        observer.updateToken?("newer", "new-token")
        observer.ended?("older")
        XCTAssertEqual(controller.updateToken, "new-token")
        XCTAssertTrue(retired.isEmpty)
        observer.reconcileAction = { observer.ended?("newer") }
        controller.resendTokens()
        XCTAssertNil(controller.updateToken)
        XCTAssertEqual(retired, ["new-token"])
        let message = UnregisterLiveActivityTokenMessage(deviceId: "phone", kind: "update", token: retired[0])
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(message)) as! [String: String]
        XCTAssertEqual(encoded["token"], "new-token")
        let legacy = UnregisterLiveActivityTokenMessage(deviceId: "phone", kind: nil)
        let legacyEncoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacy)) as! [String: String]
        XCTAssertNil(legacyEncoded["token"])
    }
}
