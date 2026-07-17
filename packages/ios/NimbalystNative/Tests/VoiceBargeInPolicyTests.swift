import XCTest
@testable import NimbalystNative

/// Tests for the barge-in decision seam (NIM-1314 Phase 0).
final class VoiceBargeInPolicyTests: XCTestCase {
    /// Deterministic clock the tests advance manually.
    private final class TestClock {
        var current = Date(timeIntervalSince1970: 1_000_000)
        func advance(ms: Int) { current = current.addingTimeInterval(Double(ms) / 1000) }
    }

    func testSpeechStartedDuringPlaybackIsEchoSuspectWithElapsedMs() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        policy.notePlaybackStarted()
        clock.advance(ms: 750)
        let decision = policy.onSpeechStarted(playbackActive: true)

        XCTAssertTrue(decision.echoSuspect)
        XCTAssertEqual(decision.msSincePlaybackStarted, 750)
        // Echo-suspect triggers defer (min-duration heuristic) -- no instant interrupt.
        XCTAssertFalse(decision.shouldInterrupt)
        XCTAssertEqual(decision.deferInterruptMs, BargeInPolicy.echoSuspectInterruptDeferMs)
        XCTAssertEqual(policy.metrics.echoSuspectCount, 1)
        XCTAssertEqual(policy.metrics.genuineCount, 0)
        XCTAssertEqual(policy.metrics.interruptCount, 0)
    }

    func testEchoSuspectSpeechDefersInterruptAndFiresIfSpeechPersists() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        policy.notePlaybackStarted()
        clock.advance(ms: 700)
        let decision = policy.onSpeechStarted(playbackActive: true)

        // Echo-suspect: don't kill playback yet -- wait out the defer window
        // (min-duration heuristic, NIM-1314). Residual-echo blips end before
        // it; a real barge-in keeps speaking through it.
        XCTAssertFalse(decision.shouldInterrupt)
        XCTAssertEqual(decision.deferInterruptMs, BargeInPolicy.echoSuspectInterruptDeferMs)
        XCTAssertEqual(policy.metrics.interruptCount, 0)

        // Speech persists past the window while playback continues -> genuine
        // barge-in; interrupt now, with truncation ms measured at fire time.
        clock.advance(ms: BargeInPolicy.echoSuspectInterruptDeferMs)
        let fired = policy.onDeferredInterruptTimeout(playbackActive: true)
        XCTAssertTrue(fired.shouldInterrupt)
        XCTAssertEqual(fired.msSincePlaybackStarted, 700 + BargeInPolicy.echoSuspectInterruptDeferMs)
        XCTAssertEqual(policy.metrics.interruptCount, 1)
    }

    func testEchoBlipEndingInsideDeferWindowIsSuppressed() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        policy.notePlaybackStarted()
        let decision = policy.onSpeechStarted(playbackActive: true)
        XCTAssertFalse(decision.shouldInterrupt)

        // The "speech" (residual echo blip) ends before the window elapses.
        clock.advance(ms: 200)
        policy.onSpeechStopped()
        clock.advance(ms: 300)

        let fired = policy.onDeferredInterruptTimeout(playbackActive: true)
        XCTAssertFalse(fired.shouldInterrupt)
        XCTAssertEqual(policy.metrics.suppressedEchoCount, 1)
        XCTAssertEqual(policy.metrics.interruptCount, 0)
    }

    func testDeferredInterruptIsNoOpWhenPlaybackAlreadyDrained() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        policy.notePlaybackStarted()
        _ = policy.onSpeechStarted(playbackActive: true)
        // Playback finishes naturally inside the window -- nothing left to interrupt.
        clock.advance(ms: 400)
        policy.notePlaybackStopped()
        clock.advance(ms: 100)

        let fired = policy.onDeferredInterruptTimeout(playbackActive: false)
        XCTAssertFalse(fired.shouldInterrupt)
        XCTAssertNil(fired.msSincePlaybackStarted)
        XCTAssertEqual(policy.metrics.interruptCount, 0)
    }

    func testSpeechStartedWhileSilentIsGenuineWithNoElapsedMs() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        let decision = policy.onSpeechStarted(playbackActive: false)

        XCTAssertFalse(decision.echoSuspect)
        XCTAssertNil(decision.msSincePlaybackStarted)
        XCTAssertTrue(decision.shouldInterrupt)
        XCTAssertEqual(policy.metrics.genuineCount, 1)
        XCTAssertEqual(policy.metrics.echoSuspectCount, 0)
    }

    func testPlaybackStartIsIdempotentAcrossChunksAndReArmsAfterStop() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        // First turn: many chunks, only the first sets the start time.
        policy.notePlaybackStarted()
        clock.advance(ms: 500)
        policy.notePlaybackStarted() // later chunk must not reset the clock
        clock.advance(ms: 500)
        XCTAssertEqual(policy.onSpeechStarted(playbackActive: true).msSincePlaybackStarted, 1000)

        // Stop re-arms: the next turn measures from its own start.
        policy.notePlaybackStopped()
        policy.notePlaybackStarted()
        clock.advance(ms: 200)
        XCTAssertEqual(policy.onSpeechStarted(playbackActive: true).msSincePlaybackStarted, 200)
    }

    func testSpeechDurationMeasuredBetweenStartAndStop() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        _ = policy.onSpeechStarted(playbackActive: false)
        clock.advance(ms: 340)
        XCTAssertEqual(policy.onSpeechStopped(), 340)
        XCTAssertEqual(policy.metrics.lastSpeechDurationMs, 340)

        // A stop without a matching start reports nothing.
        XCTAssertNil(policy.onSpeechStopped())
    }

    func testMetricsAccumulateAcrossEventsAndResetClears() {
        let clock = TestClock()
        let policy = BargeInPolicy(now: { clock.current })

        policy.notePlaybackStarted()
        _ = policy.onSpeechStarted(playbackActive: true)
        _ = policy.onSpeechStarted(playbackActive: true)
        policy.notePlaybackStopped()
        _ = policy.onSpeechStarted(playbackActive: false)

        XCTAssertEqual(policy.metrics.speechStartedCount, 3)
        XCTAssertEqual(policy.metrics.echoSuspectCount, 2)
        XCTAssertEqual(policy.metrics.genuineCount, 1)
        // Only the genuine trigger interrupts immediately; the two echo-suspect
        // triggers defer (their timers were never resolved in this test).
        XCTAssertEqual(policy.metrics.interruptCount, 1)

        policy.resetSession()
        XCTAssertEqual(policy.metrics, BargeInPolicy.SessionMetrics())
    }
}
