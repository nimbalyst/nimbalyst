import XCTest
@testable import NimbalystNative

final class VoiceSessionStartTests: XCTestCase {
    func testProjectStartClearsStaleSessionFocus() {
        let focusedSessionId = VoiceSessionFocusReducer.reduce(
            current: "stale-session",
            event: .start(.project)
        )

        XCTAssertNil(focusedSessionId)
    }

    func testSessionStartSeedsRequestedSessionFocus() {
        let focusedSessionId = VoiceSessionFocusReducer.reduce(
            current: nil,
            event: .start(.session("session-2"))
        )

        XCTAssertEqual(focusedSessionId, "session-2")
    }

    func testSwitchSessionReplacesFocusAfterProjectStart() {
        let projectFocus = VoiceSessionFocusReducer.reduce(
            current: "stale-session",
            event: .start(.project)
        )
        let switchedFocus = VoiceSessionFocusReducer.reduce(
            current: projectFocus,
            event: .switchSession("session-3")
        )

        XCTAssertEqual(switchedFocus, "session-3")
    }

    func testProjectStartActionOnlyAppearsOnSessionsWhileDisconnected() {
        XCTAssertTrue(
            VoiceSessionListActionPolicy.showsStartVoiceAgent(
                selectedTabIsSessions: true,
                voiceIsDisconnected: true
            )
        )
        XCTAssertFalse(
            VoiceSessionListActionPolicy.showsStartVoiceAgent(
                selectedTabIsSessions: false,
                voiceIsDisconnected: true
            )
        )
        XCTAssertFalse(
            VoiceSessionListActionPolicy.showsStartVoiceAgent(
                selectedTabIsSessions: true,
                voiceIsDisconnected: false
            )
        )
    }
}
