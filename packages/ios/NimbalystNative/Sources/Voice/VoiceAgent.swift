import Foundation

/// The initial coding-session focus for a newly started voice conversation.
public enum VoiceSessionStartScope: Equatable, Sendable {
    /// Start at project scope so the voice agent can choose among synced sessions.
    case project
    /// Seed the conversation with one coding session as its initial focus.
    case session(String)
}

enum VoiceSessionFocusEvent: Equatable {
    case start(VoiceSessionStartScope)
    case switchSession(String)
}

/// Pure focus transition seam shared by startup and the voice `switch_session` tool.
enum VoiceSessionFocusReducer {
    static func reduce(current: String?, event: VoiceSessionFocusEvent) -> String? {
        switch event {
        case .start(.project):
            return nil
        case .start(.session(let sessionId)), .switchSession(let sessionId):
            return sessionId
        }
    }
}

/// Pure presentation policy for the session-list project-wide voice action.
enum VoiceSessionListActionPolicy {
    static func showsStartVoiceAgent(selectedTabIsSessions: Bool, voiceIsDisconnected: Bool) -> Bool {
        selectedTabIsSessions && voiceIsDisconnected
    }
}

#if os(iOS)
import os
import UIKit
import GRDB

/// Core voice mode orchestrator. Manages the OpenAI Realtime API connection,
/// audio pipeline, tool dispatch, and state machine for voice interactions.
///
/// One instance per project, owned by `AppState`. The voice agent is project-scoped:
/// it knows about all sessions and can route prompts to any of them.
@MainActor
public final class VoiceAgent: ObservableObject {
    let logger = Logger(subsystem: "com.nimbalyst.app", category: "VoiceAgent")

    // MARK: - State

    public enum State: Equatable {
        case disconnected       // Voice mode off
        case connecting         // Establishing OpenAI WebSocket
        case listening          // Actively listening for user speech
        case processing         // Voice agent is thinking / calling tools
        case speaking           // Voice agent is speaking response
        case idle               // Connected but timed out, waiting for reactivation
    }

    public enum ActivationIssue: Identifiable, Equatable {
        case missingOpenAIKey
        case microphonePermissionDenied
        case audioSessionFailed(String)

        public var id: String {
            switch self {
            case .missingOpenAIKey: return "missing-openai-key"
            case .microphonePermissionDenied: return "microphone-permission-denied"
            case .audioSessionFailed: return "audio-session-failed"
            }
        }
    }

    @Published public internal(set) var state: State = .disconnected
    @Published public var activeSessionId: String?
    @Published public internal(set) var pendingPrompt: PendingPrompt?
    @Published public internal(set) var activationIssue: ActivationIssue?

    /// The tool call the voice agent is currently executing, if any. Drives the
    /// floating-mic tool indicator (animated ring + corner badge). Set when a
    /// function call arrives and cleared when its result is sent back, so async
    /// tools (memory/session lookups proxied to the desktop) stay lit until done.
    @Published public internal(set) var currentToolCall: ActiveToolCall?

    public struct ActiveToolCall: Equatable {
        public let name: String
        public let callId: String
    }

    /// requestId of an in-flight voice-initiated `create_session`, awaiting the
    /// desktop's `createSessionResponseBroadcast`. Used to navigate this device
    /// (and only this device) to the new session once it is created.
    var pendingCreateSessionRequestId: String?

    public struct PendingPrompt: Identifiable {
        public let id = UUID()
        public let sessionId: String
        public let sessionTitle: String
        public let prompt: String
        public let submittedAt: Date
        public let delay: TimeInterval
        var hostDeviceId: String? = nil
    }

    // MARK: - Configuration

    @Published public var settings: VoiceModeSettings

    // MARK: - Dependencies

    var database: DatabaseManager?
    weak var syncManager: SyncManager?
    var projectId: String?
    var selectedHostDeviceId: String?
    var fileContext: String?
    var screenContext: VoiceScreenContext?
    var screenRevision = 0
    var screenObservation: (any DatabaseCancellable)?
    var screenObservationId = UUID()
    var promptSpeaker: any VoicePromptSpeaker = NativeVoicePromptSpeaker()
    var promptPresentation: VoicePromptPresentation?
    var promptAnswerReceipt: VoicePromptPresentation?
    var promptRenewal: Task<Void, Never>?
    var promptReadoutCallId: String?
    var readingPrompt = false
    var eventQueue = VoiceEventQueue()
    var eventSince = Date().timeIntervalSince1970 * 1000
    var announcementDeadline: Task<Void, Never>?
    var eventPolling: Task<Void, Never>?
    @Published public internal(set) var announcementStatus: String?
    var announcement: Announcement?
    var claimingAnnouncement = false
    @Published public internal(set) var announcedSessionId: String?
    public var onOpenSession: ((String) -> Void)?
    public var onOpenDocument: ((String, String) -> Void)?

    // MARK: - Internal Components

    var voiceClient: (any VoiceEngine)?
    var connectionGeneration = VoiceConnectionGeneration()
    let toolResults = VoiceToolResults()
    var toolScopes: [String: VoiceRelayScope] = [:]
    @Published public internal(set) var effectiveEngine: VoiceEngineKind = .realtime
    @Published public internal(set) var liveUsage = LiveUsage()
    @Published public internal(set) var liveTranscripts: [LiveTranscript] = []
    @Published public internal(set) var connectionError: String?
    @Published public internal(set) var submissionStatus: String?
    @Published public internal(set) var isRestoring = false
    @Published public internal(set) var isClosing = false
    var resumeAfterClose = false
    var retainedContext = ""
    var usageConversation = UUID()
    var usageSegments: [UUID: LiveUsage] = [:]

    let audioPipeline = AudioPipeline()
    let audioRoutes: AudioRouteController
    var resumeAudioAfterRouteChange = false
    var audioSessionReady = false

    /// Barge-in decision + echo metrics seam (NIM-1314 Phase 0). Classifies
    /// every server-VAD trigger as echo-suspect vs genuine so self-interruption
    /// is measurable; later phases gate the interrupt decision here.
    let bargeInPolicy = BargeInPolicy()

    // MARK: - Timers

    var idleTimer: Timer?
    var pendingPromptTimer: Timer?
    /// Probation timer for an echo-suspect VAD trigger (min-duration
    /// heuristic): fires `onDeferredInterruptTimeout` to decide whether the
    /// speech outlived the window (real barge-in) or was an echo blip.
    var deferredBargeInTimer: Timer?

    // MARK: - Queued Notifications

    /// When the agent is actively listening, completion notifications are queued.
    var queuedCompletions: [(sessionId: String, summary: String)] = []

    // MARK: - Init

    public convenience init() {
        self.init(audioSession: IOSVoiceAudioSession())
    }

    init(audioSession: any VoiceAudioSession) {
        self.settings = VoiceModeSettings.load()
        self.audioRoutes = AudioRouteController(session: audioSession)
        setupAudioRouting()
    }

    /// Configure the voice agent with project-level dependencies.
    public func configure(
        database: DatabaseManager,
        syncManager: SyncManager,
        projectId: String
    ) {
        if self.projectId != nil && self.projectId != projectId { deactivate() }
        self.database = database
        self.syncManager = syncManager
        self.projectId = projectId
    }

    func selectHost(_ host: String?) {
        if selectedHostDeviceId != host, state != .disconnected { deactivate() }
        selectedHostDeviceId = host
    }

    // MARK: - Activate / Deactivate

    /// Start a new voice conversation with an explicit initial coding-session scope.
    /// Resuming an idle conversation continues to use `activate()` so it preserves focus.
    public func start(scope: VoiceSessionStartScope) {
        guard state == .disconnected else { return }
        activationIssue = nil
        activeSessionId = VoiceSessionFocusReducer.reduce(
            current: activeSessionId,
            event: .start(scope)
        )
        activate()
    }

    /// Start or resume voice mode. Establishes the OpenAI Realtime connection
    /// and begins listening for user speech.
    public func activate() {
        guard let apiKey = KeychainManager.getOpenAIApiKey(), !apiKey.isEmpty else {
            logger.error("Cannot activate voice mode: no OpenAI API key")
            activationIssue = .missingOpenAIKey
            return
        }

        switch state {
        case .idle:
            let epoch = connectionGeneration.value
            Task { [weak self] in
                guard let self, self.connectionGeneration.accepts(epoch), await self.resumeSelectedAudioRoute() else { return }
                self.resumeFromIdle()
            }
            return

        case .disconnected:
            break // Continue with full connection setup

        default:
            // Already active
            return
        }

        if !isRestoring {
            usageConversation = UUID()
            eventSince = Date().timeIntervalSince1970 * 1000
            usageSegments.removeAll()
            liveUsage = LiveUsage()
        }
        audioSessionReady = false
        state = .connecting
        connectionError = nil
        let epoch = connectionGeneration.replace()
        let usageOwner = usageConversation

        Task { [self] in
            // Request microphone permission
            let granted = await audioPipeline.requestMicrophonePermission()
            guard connectionGeneration.accepts(epoch), state == .connecting else { return }
            guard granted else {
                logger.error("Microphone permission denied")
                state = .disconnected
                activationIssue = .microphonePermissionDenied
                return
            }

            do {
                try await audioRoutes.activate()
            } catch {
                guard connectionGeneration.accepts(epoch), state == .connecting else { return }
                logger.error("Failed to configure audio session: \(error.localizedDescription)")
                state = .disconnected
                activationIssue = .audioSessionFailed(error.localizedDescription)
                return
            }

            guard connectionGeneration.accepts(epoch), state == .connecting else { return }

            let client: any VoiceEngine
            effectiveEngine = settings.effectiveEngine
            if effectiveEngine == .live {
                let live = LiveClient(apiKey: apiKey, settings: settings,
                    instructions: buildCompactInstructions(), tools: buildCoreToolDefinitions(), context: retainedContext)
                live.onUsage = { [weak self] usage in
                    guard let self, self.usageConversation == usageOwner else { return }
                    self.usageSegments[epoch] = usage
                    var total = usage
                    let measured = self.usageSegments.values.compactMap(\.seconds)
                    total.seconds = measured.isEmpty ? nil : measured.reduce(0, +)
                    total.finalized = self.usageSegments.values.allSatisfy(\.finalized)
                    total.finalizationMissing = self.usageSegments.values.contains(where: \.finalizationMissing)
                    total.backendInputTokens = self.usageSegments.values.reduce(0) { $0 + $1.backendInputTokens }
                    total.backendOutputTokens = self.usageSegments.values.reduce(0) { $0 + $1.backendOutputTokens }
                    self.liveUsage = total
                }
                live.onTranscripts = { [weak self] fragments in
                    guard let self, self.connectionGeneration.accepts(epoch) else { return }
                    self.liveTranscripts = fragments
                    self.retainedContext = String(fragments.map { "\($0.speaker): \($0.text)" }.joined(separator: "\n").suffix(12000))
                    self.resetIdleTimer()
                }
                live.onUserTranscript = { [weak self] text, startMs in
                    guard let self, self.connectionGeneration.accepts(epoch) else { return }
                    self.promptPresentation?.recordInput(text, startMs: startMs)
                }
                live.onClosed = { [weak self] in
                    guard let self, self.connectionGeneration.accepts(epoch) else { return }
                    let requestedClose = self.isClosing
                    self.isClosing = false
                    if !requestedClose && self.state != .disconnected {
                        self.invalidatePromptPresentation()
                        self.audioPipeline.stopCapture()
                        self.audioPipeline.stopPlayback()
                        self.toolResults.invalidate()
                        self.toolScopes.removeAll()
                        self.state = .idle
                        self.connectionError = self.connectionError ?? "Live session ended. Tap Resume to reconnect."
                    }
                    if self.resumeAfterClose {
                        self.resumeAfterClose = false
                        self.resumeFromIdle()
                    }
                }
                client = live
            } else {
                let realtime = RealtimeClient(apiKey: apiKey)
                realtime.voice = settings.voice
                realtime.instructions = buildCompactInstructions()
                realtime.tools = buildCoreToolDefinitions()
                realtime.vadThreshold = settings.vadThreshold
                realtime.silenceDurationMs = settings.silenceDurationMs
                realtime.vadDetection = settings.effectiveVadDetection
                client = realtime
            }
            self.voiceClient = client
            setupClientCallbacks(client, epoch: epoch)
            client.connect()
        }
    }

    /// Stop voice mode entirely. Disconnects from OpenAI and releases audio resources.
    public func deactivate() {
        invalidatePromptPresentation()
        promptAnswerReceipt = nil
        _ = connectionGeneration.replace()
        announcementDeadline?.cancel()
        eventPolling?.cancel()
        eventPolling = nil
        announcement = nil
        announcementStatus = nil
        announcedSessionId = nil
        eventQueue = VoiceEventQueue()
        toolResults.invalidate()
        toolScopes.removeAll()
        resumeAfterClose = false
        isClosing = false
        isRestoring = false
        retainedContext = ""
        liveTranscripts = []
        fileContext = nil
        let m = bargeInPolicy.metrics
        if m.speechStartedCount > 0 {
            logger.info("[barge-in] session summary: speechStarted=\(m.speechStartedCount) echoSuspect=\(m.echoSuspectCount) genuine=\(m.genuineCount) interrupts=\(m.interruptCount) suppressedEcho=\(m.suppressedEchoCount)")
        }
        bargeInPolicy.resetSession()
        cancelIdleTimer()
        cancelPendingPromptTimer()
        cancelDeferredBargeInTimer()
        voiceClient?.disconnect()
        voiceClient = nil
        audioPipeline.shutdown()
        audioRoutes.stop()
        resumeAudioAfterRouteChange = false
        audioSessionReady = false
        pendingPrompt = nil
        currentToolCall = nil
        queuedCompletions.removeAll()
        state = .disconnected
    }

    public func dismissActivationIssue() {
        activationIssue = nil
    }

    /// User tapped to interrupt the agent mid-turn (while speaking or processing).
    /// Stops playback, cancels any in-flight response, and returns to listening.
    /// Mirrors the barge-in path used when the user speaks over the agent.
    public func interrupt() {
        guard state == .speaking || state == .processing else { return }
        invalidatePromptPresentation()
        // A manual tap supersedes any pending echo-suspect probation window.
        cancelDeferredBargeInTimer()
        audioPipeline.stopPlayback(fadeOut: true)
        // Tell the server how much audio was actually heard before cancelling,
        // so the model's context matches reality (NIM-1314 lever 5).
        voiceClient?.interruptPlayback(audioEndMs: bargeInPolicy.msSincePlaybackStarted())
        bargeInPolicy.notePlaybackStopped()
        state = .listening
        resetIdleTimer()
    }

    /// User tapped while listening to pause the mic and go idle.
    /// Tapping again (or a wake event) resumes via `activate()` -> `resumeFromIdle()`.
    public func pauseListening() {
        guard state == .listening else { return }
        invalidatePromptPresentation()
        cancelIdleTimer()
        audioPipeline.stopCapture()
        state = .idle
        if effectiveEngine == .live {
            toolResults.invalidate()
            toolScopes.removeAll()
            isClosing = true
            voiceClient?.disconnect()
        }
    }

    func suspendLiveForBackground() {
        guard effectiveEngine == .live, state != .disconnected else { return }
        invalidatePromptPresentation()
        resumeAfterClose = false
        audioPipeline.stopPlayback()
        if voiceClient == nil {
            // Permission may still be pending. There is no transport that could
            // acknowledge a close, so retire that activation without waiting.
            _ = connectionGeneration.replace()
            audioPipeline.stopCapture()
            state = .idle
            isClosing = false
            isRestoring = false
            return
        }
        state = .listening
        pauseListening()
    }

    // MARK: - Pending Prompt Actions

    /// Cancel the pending prompt before it auto-submits.
    public func cancelPendingPrompt() {
        guard pendingPrompt != nil else { return }
        cancelPendingPromptTimer()
        let cancelled = pendingPrompt
        pendingPrompt = nil

        // Inform the voice agent that the prompt was cancelled
        if let cancelled {
            voiceClient?.sendUserMessage(
                text: "[SYSTEM: User cancelled the pending prompt to session \"\(cancelled.sessionTitle)\": \"\(cancelled.prompt)\"]"
            )
        }
    }

    /// Confirm and send the pending prompt immediately (skip countdown).
    public func confirmPendingPrompt() {
        guard let prompt = pendingPrompt else { return }
        cancelPendingPromptTimer()
        submitPromptToSession(prompt)
        pendingPrompt = nil
    }

    // MARK: - Completion Notifications

    /// Called when a coding agent finishes a turn. If voice mode is idle,
    /// announces the result and transitions to listening.
    public func onSessionCompleted(sessionId: String, summary: String) {
        guard settings.autoAnnounceCompletions else { return }
        if audioRoutes.blocksAudio && effectiveEngine == .realtime {
            queuedCompletions.append((sessionId: sessionId, summary: summary))
            return
        }
        if effectiveEngine == .live {
            guard state != .disconnected else { return }
            Task { [weak self] in await self?.fetchVoiceEvents(sessionId: sessionId, includeCompletion: true) }
            return
        }

        switch state {
        case .idle:
            // Wake up and announce. Going idle tore down the shared VPIO audio
            // unit and the playback converter (stopCapture), so the audio
            // pipeline MUST be restarted before the agent speaks -- otherwise
            // its audio deltas are silently dropped (enqueuePlayback no-ops on a
            // nil converter / there is no render callback) and the user hears
            // nothing. This is the auto-wake counterpart to resumeFromIdle().
            guard wakeAudioPipeline() else { return }
            let sessionTitle = sessionTitle(for: sessionId) ?? "Unknown session"
            voiceClient?.sendUserMessage(
                text: "[INTERNAL: Session \"\(sessionTitle)\" completed: \(summary)]"
            )
            state = .processing
            resetIdleTimer()

        case .listening, .processing:
            // Queue for later
            queuedCompletions.append((sessionId: sessionId, summary: summary))

        default:
            break
        }
    }

    // MARK: - Barge-In

    /// Stop playback and cancel the in-flight response after a barge-in
    /// decision (immediate genuine trigger, or a deferred echo-suspect one
    /// whose speech outlived the probation window).
    func performBargeInInterrupt(msSincePlaybackStarted: Int?) {
        invalidatePromptPresentation()
        audioPipeline.stopPlayback(fadeOut: true)
        // Truncate before cancel so the model's context reflects how much of
        // the reply the user actually heard (NIM-1314 lever 5).
        voiceClient?.interruptPlayback(audioEndMs: msSincePlaybackStarted)
        bargeInPolicy.notePlaybackStopped()
        state = .listening
    }

    /// Echo-suspect trigger: playback keeps going; after the probation window
    /// the policy decides whether the speech persisted (interrupt late) or was
    /// an echo blip that already ended (suppress -- playback never hiccuped).
    func scheduleDeferredBargeIn(afterMs deferMs: Int) {
        deferredBargeInTimer?.invalidate()
        deferredBargeInTimer = Timer.scheduledTimer(
            withTimeInterval: Double(deferMs) / 1000.0,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.resolveDeferredBargeIn()
            }
        }
    }

    func resolveDeferredBargeIn() {
        deferredBargeInTimer = nil
        let playbackActive = audioPipeline.isAudiblyPlaying
        let decision = bargeInPolicy.onDeferredInterruptTimeout(playbackActive: playbackActive)
        let m = bargeInPolicy.metrics
        logger.info("[barge-in] deferred \(decision.shouldInterrupt ? "fired" : "suppressed") playbackActive=\(playbackActive) msSincePlayback=\(decision.msSincePlaybackStarted.map(String.init) ?? "n/a") suppressed=\(m.suppressedEchoCount)")
        if decision.shouldInterrupt {
            performBargeInInterrupt(msSincePlaybackStarted: decision.msSincePlaybackStarted)
        }
    }

    func cancelDeferredBargeInTimer() {
        deferredBargeInTimer?.invalidate()
        deferredBargeInTimer = nil
    }

    // MARK: - Idle Management

    func resetIdleTimer() {
        cancelIdleTimer()
        guard !audioRoutes.blocksAudio, state != .idle, state != .disconnected else { return }
        idleTimer = Timer.scheduledTimer(
            withTimeInterval: settings.idleTimeout,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.transitionToIdle()
            }
        }
    }

    func cancelIdleTimer() {
        idleTimer?.invalidate()
        idleTimer = nil
    }

    func transitionToIdle() {
        guard state == .listening else { return }
        logger.info("Voice mode going idle after \(self.settings.idleTimeout)s timeout")
        audioPipeline.stopCapture()
        state = .idle
        if effectiveEngine == .live {
            toolResults.invalidate()
            toolScopes.removeAll()
            isClosing = true
            voiceClient?.disconnect()
        }
    }

    func resumeFromIdle() {
        guard !audioRoutes.blocksAudio else { return }
        if effectiveEngine == .live {
            guard !isClosing else { resumeAfterClose = true; return }
            guard UIApplication.shared.applicationState == .active else { return }
            voiceClient = nil
            state = .disconnected
            isRestoring = true
            activate()
            return
        }
        // Activation can be interrupted before a transport has been created.
        // Resume must restart that connection instead of waiting for a ready
        // callback from a client that does not exist.
        guard voiceClient != nil else {
            state = .disconnected
            isRestoring = true
            activate()
            return
        }
        guard audioSessionReady else { state = .connecting; return }
        logger.info("Resuming voice mode from idle")
        guard wakeAudioPipeline() else { return }
        state = .listening
        resetIdleTimer()
        processQueuedCompletions()
    }

    /// Restart the audio pipeline after it was torn down while idle. Going idle
    /// calls `stopCapture()`, which disposes the shared VoiceProcessingIO audio
    /// unit (its render callback is what produces playback) and nils the
    /// playback converter. Both wake paths -- user tap (`resumeFromIdle`) and
    /// auto-wake on a coding-agent completion (`onSessionCompleted`) -- must
    /// restart it before the agent speaks, or playback is silently dropped.
    /// `startCapture()` no-ops if capture is already running. On failure it
    /// deactivates voice mode and returns false.
    @discardableResult
    func wakeAudioPipeline() -> Bool {
        guard !audioRoutes.blocksAudio else { return false }
        do {
            try audioPipeline.startCapture()
            return true
        } catch {
            logger.error("Failed to restart audio pipeline on wake: \(error.localizedDescription)")
            deactivate()
            return false
        }
    }

    // MARK: - Queued Completions

    func processQueuedCompletions() {
        guard !audioRoutes.blocksAudio, !queuedCompletions.isEmpty else { return }
        let completions = queuedCompletions
        queuedCompletions.removeAll()

        for completion in completions {
            let title = sessionTitle(for: completion.sessionId) ?? "Unknown"
            voiceClient?.sendUserMessage(
                text: "[INTERNAL: Session \"\(title)\" completed: \(completion.summary)]"
            )
        }
    }

    // MARK: - Helpers

    func sessionTitle(for sessionId: String) -> String? {
        try? database?.session(byId: sessionId)?.titleDecrypted
    }

    func parseArguments(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }
}

#endif
