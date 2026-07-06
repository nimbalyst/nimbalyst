import Foundation

/// Decision + metrics seam for voice barge-in (NIM-1314 Phase 0).
///
/// Server VAD `speech_started` cannot distinguish the user talking over the
/// agent from residual echo of the agent's own speech leaking past AEC on
/// speakerphone. This type owns the barge-in decision and classifies every
/// VAD trigger as echo-suspect (fired while agent audio was audibly playing)
/// vs genuine (fired while silent), so the self-interruption rate is
/// measurable before/after each tuning lever.
///
/// Defined outside the `#if os(iOS)` audio code (no platform dependencies) so
/// the policy is unit-testable on macOS without a device.
///
/// Min-duration heuristic (NIM-1314 lever 6): an echo-suspect trigger does not
/// interrupt immediately -- the caller schedules `onDeferredInterruptTimeout`
/// after `echoSuspectInterruptDeferMs`. Residual-echo blips end inside the
/// window (VAD sends speech_stopped -> suppressed, playback never hiccups); a
/// real barge-in keeps speaking through it and interrupts slightly late.
/// Genuine triggers (nothing playing) still interrupt immediately.
final class BargeInPolicy {
    /// How long echo-suspect speech must persist before it interrupts
    /// playback. Live 2026-07-02 metrics: every self-interruption fired while
    /// agent audio was playing, so suspects get a probation window instead of
    /// instant trust.
    static let echoSuspectInterruptDeferMs = 500

    struct Decision: Equatable {
        /// Whether the caller should stop playback and cancel the response.
        let shouldInterrupt: Bool
        /// True when agent audio was audibly playing at the VAD trigger.
        let echoSuspect: Bool
        /// Milliseconds since the current agent playback started, when playing.
        let msSincePlaybackStarted: Int?
        /// When set, the caller must schedule `onDeferredInterruptTimeout`
        /// this many ms out instead of interrupting now.
        let deferInterruptMs: Int?
    }

    struct SessionMetrics: Equatable {
        var speechStartedCount = 0
        var echoSuspectCount = 0
        var genuineCount = 0
        var interruptCount = 0
        /// Echo-suspect triggers whose speech ended inside the defer window
        /// (classified as echo; playback was never interrupted).
        var suppressedEchoCount = 0
        var lastSpeechDurationMs: Int?
    }

    private(set) var metrics = SessionMetrics()

    private let now: () -> Date
    private var playbackStartedAt: Date?
    private var speechStartedAt: Date?

    /// `now` is injectable so tests can drive time deterministically.
    init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    /// Call when the first audio chunk of an agent turn is enqueued. Idempotent
    /// across the chunks of one turn; `notePlaybackStopped()` re-arms it.
    func notePlaybackStarted() {
        if playbackStartedAt == nil { playbackStartedAt = now() }
    }

    /// Call when playback fully drains or is stopped (barge-in, manual interrupt).
    func notePlaybackStopped() {
        playbackStartedAt = nil
    }

    /// Milliseconds since the current agent playback started, or nil when not
    /// playing. Used to compute `audio_end_ms` for conversation.item.truncate.
    func msSincePlaybackStarted() -> Int? {
        playbackStartedAt.map { Int(now().timeIntervalSince($0) * 1000) }
    }

    /// Server VAD `speech_started`. `playbackActive` is the audible-playback
    /// signal (ring buffer not yet drained). The caller performs the actual
    /// stop/cancel when `shouldInterrupt` is true, or schedules
    /// `onDeferredInterruptTimeout` when `deferInterruptMs` is set.
    func onSpeechStarted(playbackActive: Bool) -> Decision {
        speechStartedAt = now()
        let msSincePlayback: Int? = playbackActive
            ? playbackStartedAt.map { Int(now().timeIntervalSince($0) * 1000) }
            : nil

        metrics.speechStartedCount += 1
        if playbackActive {
            metrics.echoSuspectCount += 1
        } else {
            metrics.genuineCount += 1
        }

        // Echo-suspect: probation window instead of an immediate interrupt.
        if playbackActive {
            return Decision(
                shouldInterrupt: false,
                echoSuspect: true,
                msSincePlaybackStarted: msSincePlayback,
                deferInterruptMs: Self.echoSuspectInterruptDeferMs
            )
        }

        metrics.interruptCount += 1
        return Decision(
            shouldInterrupt: true,
            echoSuspect: false,
            msSincePlaybackStarted: nil,
            deferInterruptMs: nil
        )
    }

    /// Called by the caller's timer `deferInterruptMs` after an echo-suspect
    /// trigger. Interrupts only if the speech is still ongoing (no
    /// speech_stopped cleared it -- a real barge-in, not an echo blip) AND
    /// agent audio is still playing (there is something left to interrupt).
    /// `msSincePlaybackStarted` is measured now, so truncation reflects what
    /// the user actually heard including the probation window.
    func onDeferredInterruptTimeout(playbackActive: Bool) -> Decision {
        let speechOngoing = speechStartedAt != nil
        if !speechOngoing {
            metrics.suppressedEchoCount += 1
        }
        let interrupt = speechOngoing && playbackActive
        if interrupt { metrics.interruptCount += 1 }
        return Decision(
            shouldInterrupt: interrupt,
            echoSuspect: true,
            msSincePlaybackStarted: playbackActive ? msSincePlaybackStarted() : nil,
            deferInterruptMs: nil
        )
    }

    /// Server VAD `speech_stopped`. Returns the speech duration in ms (the
    /// signal a later min-duration heuristic would gate on).
    @discardableResult
    func onSpeechStopped() -> Int? {
        guard let start = speechStartedAt else { return nil }
        speechStartedAt = nil
        let ms = Int(now().timeIntervalSince(start) * 1000)
        metrics.lastSpeechDurationMs = ms
        return ms
    }

    /// Clear all state at session end (after logging the summary).
    func resetSession() {
        metrics = SessionMetrics()
        playbackStartedAt = nil
        speechStartedAt = nil
    }
}
