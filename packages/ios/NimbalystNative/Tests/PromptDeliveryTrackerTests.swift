import XCTest
@testable import NimbalystNative

final class PromptDeliveryTrackerTests: XCTestCase {
    private func message(_ id: String, session: String = "s", source: String = "assistant", at: Int = 101) -> Message {
        Message(id: id, sessionId: session, sequence: 1, source: source,
                direction: source == "user" ? "input" : "output",
                encryptedContent: "", iv: "", createdAt: at)
    }

    @MainActor
    func testExecutionBeforeSendCompletionStaysConfirmedAfterTurnEnds() {
        let tracker = PromptDeliveryTracker()
        let id = tracker.begin(sessionId: "s", isExecuting: false, messages: [], now: 100)
        tracker.observeExecution(sessionId: "s", isExecuting: true)
        tracker.observeExecution(sessionId: "s", isExecuting: false)
        tracker.sent(id)
        tracker.expire(id)
        XCTAssertNil(tracker.warning)

        let queued = tracker.begin(sessionId: "s", isExecuting: true, messages: [], now: 100)
        tracker.observeExecution(sessionId: "s", isExecuting: false)
        tracker.expire(queued)
        XCTAssertNil(tracker.warning)
    }

    @MainActor
    func testFreshDesktopOutputClearsWarningButLocalEchoHistoryAndOtherSessionsDoNot() {
        let tracker = PromptDeliveryTracker()
        let old = message("already-seen")
        let id = tracker.begin(sessionId: "s", isExecuting: false, messages: [old], now: 100)
        tracker.observeMessages([old, message("local", source: "user"), message("history", at: 90),
                                 message("other", session: "other"), message("system", source: "system")])
        tracker.observeExecution(sessionId: "other", isExecuting: true)
        tracker.expire(id)
        XCTAssertNotNil(tracker.warning)
        tracker.observeMessages([message("response")])
        XCTAssertNil(tracker.warning)
        tracker.expire(id)
        XCTAssertNil(tracker.warning, "Completion remains evidence even without a running flag")
    }

    @MainActor
    func testLeavingOrSwitchingSessionsFencesLateSendAndTimerCallbacks() {
        let tracker = PromptDeliveryTracker()
        let first = tracker.begin(sessionId: "s", isExecuting: false, messages: [], now: 100)
        tracker.cancel()
        tracker.sent(first)
        tracker.expire(first)
        XCTAssertFalse(tracker.failed(first))
        XCTAssertNil(tracker.warning)

        let next = tracker.begin(sessionId: "next", isExecuting: false, messages: [], now: 100)
        tracker.sent(first)
        tracker.expire(first)
        tracker.observeExecution(sessionId: "s", isExecuting: true)
        XCTAssertNil(tracker.warning)
        tracker.expire(next)
        XCTAssertNotNil(tracker.warning)
        XCTAssertTrue(tracker.failed(next))
        XCTAssertNil(tracker.warning)
    }
}
