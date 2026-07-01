#if os(iOS)
import Foundation
import os
import UIKit

/// Core voice mode orchestrator. Manages the OpenAI Realtime API connection,
/// audio pipeline, tool dispatch, and state machine for voice interactions.
///
/// One instance per project, owned by `AppState`. The voice agent is project-scoped:
/// it knows about all sessions and can route prompts to any of them.
@MainActor
public final class VoiceAgent: ObservableObject {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "VoiceAgent")

    // MARK: - State

    public enum State: Equatable {
        case disconnected       // Voice mode off
        case connecting         // Establishing OpenAI WebSocket
        case listening          // Actively listening for user speech
        case processing         // Voice agent is thinking / calling tools
        case speaking           // Voice agent is speaking response
        case idle               // Connected but timed out, waiting for reactivation
    }

    @Published public private(set) var state: State = .disconnected
    @Published public var activeSessionId: String?
    @Published public private(set) var pendingPrompt: PendingPrompt?

    /// The tool call the voice agent is currently executing, if any. Drives the
    /// floating-mic tool indicator (animated ring + corner badge). Set when a
    /// function call arrives and cleared when its result is sent back, so async
    /// tools (memory/session lookups proxied to the desktop) stay lit until done.
    @Published public private(set) var currentToolCall: ActiveToolCall?

    public struct ActiveToolCall: Equatable {
        public let name: String
        public let callId: String
    }

    /// requestId of an in-flight voice-initiated `create_session`, awaiting the
    /// desktop's `createSessionResponseBroadcast`. Used to navigate this device
    /// (and only this device) to the new session once it is created.
    private var pendingCreateSessionRequestId: String?

    public struct PendingPrompt: Identifiable {
        public let id = UUID()
        public let sessionId: String
        public let sessionTitle: String
        public let prompt: String
        public let submittedAt: Date
        public let delay: TimeInterval
    }

    // MARK: - Configuration

    @Published public var settings: VoiceModeSettings

    // MARK: - Dependencies

    private var database: DatabaseManager?
    private weak var syncManager: SyncManager?
    private var projectId: String?

    // MARK: - Internal Components

    private var realtimeClient: RealtimeClient?
    private let audioPipeline = AudioPipeline()

    // MARK: - Timers

    private var idleTimer: Timer?
    private var pendingPromptTimer: Timer?

    // MARK: - Queued Notifications

    /// When the agent is actively listening, completion notifications are queued.
    private var queuedCompletions: [(sessionId: String, summary: String)] = []

    // MARK: - Init

    public init() {
        self.settings = VoiceModeSettings.load()
    }

    /// Configure the voice agent with project-level dependencies.
    public func configure(
        database: DatabaseManager,
        syncManager: SyncManager,
        projectId: String
    ) {
        self.database = database
        self.syncManager = syncManager
        self.projectId = projectId
    }

    // MARK: - Activate / Deactivate

    /// Start or resume voice mode. Establishes the OpenAI Realtime connection
    /// and begins listening for user speech.
    public func activate() {
        guard let apiKey = KeychainManager.getOpenAIApiKey(), !apiKey.isEmpty else {
            logger.error("Cannot activate voice mode: no OpenAI API key")
            return
        }

        switch state {
        case .idle:
            // Resume from idle - start listening again
            resumeFromIdle()
            return

        case .disconnected:
            break // Continue with full connection setup

        default:
            // Already active
            return
        }

        state = .connecting

        Task {
            // Request microphone permission
            let granted = await audioPipeline.requestMicrophonePermission()
            guard granted else {
                logger.error("Microphone permission denied")
                state = .disconnected
                return
            }

            do {
                try audioPipeline.configureAudioSession()
            } catch {
                logger.error("Failed to configure audio session: \(error.localizedDescription)")
                state = .disconnected
                return
            }

            // Set up the Realtime client
            let client = RealtimeClient(apiKey: apiKey)
            client.voice = "alloy"
            client.instructions = buildCompactInstructions()
            client.tools = buildCoreToolDefinitions()
            client.vadThreshold = settings.vadThreshold
            client.silenceDurationMs = settings.silenceDurationMs

            // Wire callbacks
            setupClientCallbacks(client)

            self.realtimeClient = client
            client.connect()
        }
    }

    /// Stop voice mode entirely. Disconnects from OpenAI and releases audio resources.
    public func deactivate() {
        cancelIdleTimer()
        cancelPendingPromptTimer()
        realtimeClient?.disconnect()
        realtimeClient = nil
        audioPipeline.shutdown()
        pendingPrompt = nil
        currentToolCall = nil
        queuedCompletions.removeAll()
        state = .disconnected
    }

    /// User tapped to interrupt the agent mid-turn (while speaking or processing).
    /// Stops playback, cancels any in-flight response, and returns to listening.
    /// Mirrors the barge-in path used when the user speaks over the agent.
    public func interrupt() {
        guard state == .speaking || state == .processing else { return }
        audioPipeline.stopPlayback(fadeOut: true)
        realtimeClient?.cancelResponse()
        state = .listening
        resetIdleTimer()
    }

    /// User tapped while listening to pause the mic and go idle.
    /// Tapping again (or a wake event) resumes via `activate()` -> `resumeFromIdle()`.
    public func pauseListening() {
        guard state == .listening else { return }
        cancelIdleTimer()
        audioPipeline.stopCapture()
        state = .idle
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
            realtimeClient?.sendUserMessage(
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
            realtimeClient?.sendUserMessage(
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

    // MARK: - Realtime Client Callbacks

    private func setupClientCallbacks(_ client: RealtimeClient) {
        client.onConnected = { [weak self] in
            guard let self else { return }
            self.logger.info("Realtime connected, waiting for session config...")
        }

        client.onSessionReady = { [weak self] in
            guard let self else { return }
            self.logger.info("Session configured, starting capture")
            do {
                try self.audioPipeline.startCapture()
                self.state = .listening
                self.resetIdleTimer()
                // Cue the user that the session is connected and it's their turn
                // to talk: a soft chime plus a gentle haptic. Fires only here, on
                // a fresh session connect -- not on idle-resume or barge-in.
                self.audioPipeline.playReadyChime()
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            } catch {
                self.logger.error("Failed to start capture: \(error.localizedDescription)")
                self.deactivate()
            }
        }

        client.onDisconnected = { [weak self] in
            guard let self else { return }
            if self.state != .disconnected {
                self.logger.warning("Realtime connection lost unexpectedly")
                self.deactivate()
            }
        }

        client.onAudioDelta = { [weak self] base64Audio in
            guard let self else { return }
            if self.state != .speaking {
                self.state = .speaking
                self.cancelIdleTimer()
            }
            self.audioPipeline.enqueuePlayback(base64Audio: base64Audio)
        }

        client.onAudioDone = { [weak self] in
            self?.audioPipeline.markEndOfPlayback()
        }

        audioPipeline.onAudioCaptured = { [weak self] base64Audio in
            Task { @MainActor in
                self?.realtimeClient?.sendAudio(base64Audio)
            }
        }

        audioPipeline.onPlaybackFinished = { [weak self] in
            guard let self else { return }
            self.state = .listening
            self.resetIdleTimer()
            self.processQueuedCompletions()
        }

        client.onResponseCreated = { [weak self] in
            guard let self else { return }
            if self.state == .listening {
                self.state = .processing
                self.cancelIdleTimer()
            }
        }

        client.onResponseDone = { [weak self] in
            guard let self else { return }
            // If no audio was produced (text-only or tool-only response), go back to listening
            if self.state == .processing {
                self.state = .listening
                self.resetIdleTimer()
            }
        }

        client.onSpeechStarted = { [weak self] in
            guard let self else { return }
            // User started speaking - interrupt agent playback if active.
            // Fade rather than hard-cut, and always cancel: the local
            // hasActiveResponse flag races the server (audio streams faster than
            // realtime, so it's often still playing after response.done), and
            // cancelResponse() now suppresses the benign "no active response".
            self.audioPipeline.stopPlayback(fadeOut: true)
            self.realtimeClient?.cancelResponse()
            self.state = .listening
            self.cancelIdleTimer()
        }

        client.onSpeechStopped = { [weak self] in
            guard let self else { return }
            self.state = .processing
        }

        client.onFunctionCall = { [weak self] name, arguments, callId in
            guard let self else { return }
            // Light up the floating-mic tool indicator for the duration of the call.
            self.currentToolCall = ActiveToolCall(name: name, callId: callId)
            self.handleToolCall(name: name, arguments: arguments, callId: callId)
        }

        client.onFunctionResultSent = { [weak self] callId in
            guard let self else { return }
            // Clear the indicator only for the call that just finished, so a
            // newer in-flight tool call isn't dismissed by an older one's result.
            if self.currentToolCall?.callId == callId {
                self.currentToolCall = nil
            }
        }

        client.onError = { [weak self] type, message in
            self?.logger.error("Realtime error [\(type)]: \(message)")
        }

        client.onTokenUsage = { [weak self] usage in
            self?.logger.info(
                "Token usage: in=\(usage.inputTokens) out=\(usage.outputTokens) audio_in=\(usage.inputAudioTokens) audio_out=\(usage.outputAudioTokens)"
            )
        }
    }

    // MARK: - Tool Handling

    private func handleToolCall(name: String, arguments: String, callId: String) {
        let args = parseArguments(arguments)

        switch name {
        // The advertised tool name is "submit_agent_prompt" (see
        // buildCoreToolDefinitions); the bare "submit_prompt" alias is kept
        // defensively. Matching only "submit_prompt" silently dropped every
        // task submission to the "Unknown tool" default.
        case "submit_agent_prompt", "submit_prompt":
            handleSubmitPrompt(args: args, callId: callId)
        case "create_session":
            handleCreateSession(args: args, callId: callId)
        case "list_sessions":
            handleListSessions(args: args, callId: callId)
        case "switch_session":
            handleSwitchSession(args: args, callId: callId)
        case "get_session_summary":
            handleGetSessionSummary(args: args, callId: callId)
        case "answer_prompt":
            handleAnswerPrompt(args: args, callId: callId)
        case "stop_voice_session":
            handleStopVoiceSession(callId: callId)
        case "ask_coding_agent":
            handleAskCodingAgent(args: args, callId: callId)
        case "search_project_knowledge", "recall", "remember":
            handleMemoryTool(name: name, argumentsJson: arguments, callId: callId)
        default:
            logger.info("Unknown tool call: \(name)")
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Unknown tool: \(name)\"}"
            )
        }
    }

    private func handleSubmitPrompt(args: [String: Any], callId: String) {
        let prompt = args["prompt"] as? String ?? ""
        let sessionId = args["session_id"] as? String ?? activeSessionId

        guard let sessionId, !prompt.isEmpty else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Missing prompt or session_id\"}"
            )
            return
        }

        let title = sessionTitle(for: sessionId) ?? "Session"

        // Set pending prompt (shows confirmation card)
        pendingPrompt = PendingPrompt(
            sessionId: sessionId,
            sessionTitle: title,
            prompt: prompt,
            submittedAt: Date(),
            delay: settings.promptConfirmationDelay
        )

        // Start auto-submit countdown
        pendingPromptTimer = Timer.scheduledTimer(
            withTimeInterval: settings.promptConfirmationDelay,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.autoSubmitPendingPrompt()
            }
        }

        realtimeClient?.sendFunctionCallResult(
            callId: callId,
            output: "{\"success\":true,\"message\":\"Prompt queued for session \\\"\(title)\\\". Waiting for user confirmation (\(Int(settings.promptConfirmationDelay))s countdown).\"}"
        )
    }

    /// Create a new coding session on the desktop. The request is fire-and-forget
    /// over the sync channel (the desktop's onCreateSessionRequest handler creates
    /// the session and it syncs back into the session list). We optimistically
    /// report success, mirroring submit_agent_prompt/ask_coding_agent.
    ///
    /// Limitations (follow-ups): the mobile create-session protocol has no title
    /// field, so a requested title is not applied (the desktop default-names it);
    /// and because the response arrives asynchronously, the voice agent does not
    /// auto-switch its active session to the new one yet.
    private func handleCreateSession(args: [String: Any], callId: String) {
        guard let syncManager else {
            logger.error("create_session: syncManager unavailable")
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Sync is unavailable\"}"
            )
            return
        }

        guard let resolvedProjectId = resolveProjectId() else {
            logger.error("create_session: no projectId (configured=\(self.projectId ?? "nil"), activeSessionId=\(self.activeSessionId ?? "nil"))")
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No project configured\"}"
            )
            return
        }

        do {
            // Remember the requestId so we navigate this device to the new session
            // when the desktop's create-session response arrives (see AppState).
            pendingCreateSessionRequestId = try syncManager.createSession(projectId: resolvedProjectId)
            logger.info("create_session: sent request for project \(resolvedProjectId)")
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":true,\"message\":\"Creating a new session on the desktop. It will appear in the session list shortly.\"}"
            )
        } catch {
            logger.error("create_session: failed to send request: \(error.localizedDescription)")
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Failed to request a new session\"}"
            )
        }
    }

    /// Returns true if `requestId` matches a `create_session` this agent issued
    /// (clearing it), meaning this device should navigate to the new session.
    /// Other paired devices receive the same broadcast but return false here.
    public func consumePendingCreateSession(requestId: String) -> Bool {
        guard pendingCreateSessionRequestId == requestId else { return false }
        pendingCreateSessionRequestId = nil
        return true
    }

    /// Resolve the target project: the configured projectId, or fall back to the
    /// active session's project. configure(projectId:) is only called when
    /// navigating through the project list, so a voice session opened straight
    /// from a session detail (or after relaunch) can have a nil projectId.
    private func resolveProjectId() -> String? {
        if let projectId { return projectId }
        if let activeSessionId, let session = try? database?.session(byId: activeSessionId) {
            return session.projectId
        }
        return nil
    }

    /// JSON-encode a tool-args dictionary for proxying over the sync channel.
    private static func encodeArgs(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }

    private func handleListSessions(args: [String: Any], callId: String) {
        let query = (args["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        // With a topic query, proxy to the desktop's semantic (memory-backed)
        // session search -- the SAME lookup the desktop voice agent uses -- so a
        // topic matches a session even when its title doesn't contain the words.
        // Falls back to the local recency list when there's no query, no desktop
        // connection, or the desktop doesn't respond (so it still works offline).
        if let query, !query.isEmpty,
           let syncManager, let projectId = resolveProjectId() {
            let argsJson = Self.encodeArgs(["query": query])
            Task { @MainActor in
                let outcome = await syncManager.callVoiceTool(
                    toolName: "list_sessions",
                    argsJson: argsJson,
                    projectId: projectId
                )
                if outcome.success, let result = outcome.result, !result.isEmpty {
                    self.realtimeClient?.sendFunctionCallResult(callId: callId, output: result)
                } else {
                    self.logger.info("list_sessions: semantic search unavailable, using local list")
                    self.sendLocalSessionList(callId: callId)
                }
            }
            return
        }

        sendLocalSessionList(callId: callId)
    }

    /// Local fallback: this device's sessions ordered by recency (no semantic
    /// matching). Used when no query is given or the desktop is unreachable.
    private func sendLocalSessionList(callId: String) {
        guard let database, let projectId = resolveProjectId() else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No project configured\"}"
            )
            return
        }

        do {
            let sessions = try database.sessions(forProject: projectId)
            let sessionList = sessions.map { session -> [String: Any] in
                var info: [String: Any] = [
                    "id": session.id,
                    "title": session.titleDecrypted ?? "Untitled",
                    "provider": session.provider ?? "unknown",
                    "model": session.model ?? "unknown",
                    "isExecuting": session.isExecuting,
                    "lastActivity": RelativeTimestamp.format(epochMs: session.updatedAt),
                ]
                if session.id == activeSessionId {
                    info["isFocused"] = true
                }
                return info
            }

            let resultData = try JSONSerialization.data(withJSONObject: [
                "success": true,
                "sessions": sessionList,
            ])
            let resultString = String(data: resultData, encoding: .utf8) ?? "{}"
            realtimeClient?.sendFunctionCallResult(callId: callId, output: resultString)
        } catch {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Failed to list sessions\"}"
            )
        }
    }

    private func handleSwitchSession(args: [String: Any], callId: String) {
        guard let sessionId = args["session_id"] as? String else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Missing session_id\"}"
            )
            return
        }

        activeSessionId = sessionId
        let title = sessionTitle(for: sessionId) ?? "Unknown"

        realtimeClient?.sendFunctionCallResult(
            callId: callId,
            output: "{\"success\":true,\"message\":\"Switched to session \\\"\(title)\\\"\"}"
        )
    }

    private func handleGetSessionSummary(args: [String: Any], callId: String) {
        let sessionId = (args["session_id"] as? String) ?? activeSessionId

        guard let sessionId else {
            logger.error("get_session_summary: no session (active=\(self.activeSessionId ?? "nil"))")
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No session specified\"}"
            )
            return
        }

        // Prefer the desktop summary when connected: only the desktop's canonical
        // transcript carries pending interactive prompts (questions/permissions
        // the session is blocked on) and the full final agent message. The local
        // GRDB rows can't represent those, so a local-only summary would hide the
        // very thing the user started the voice agent to handle. Fall back to the
        // local DB summary when the desktop is unreachable (offline-capable).
        if let syncManager, let projectId = resolveProjectId() {
            let argsJson = Self.encodeArgs(["session_id": sessionId])
            Task { @MainActor in
                let outcome = await syncManager.callVoiceTool(
                    toolName: "get_session_summary",
                    argsJson: argsJson,
                    projectId: projectId
                )
                if outcome.success, let result = outcome.result, !result.isEmpty {
                    let payload: [String: Any] = ["success": true, "summary": result]
                    self.realtimeClient?.sendFunctionCallResult(callId: callId, output: Self.encodeArgs(payload))
                    return
                }
                // Desktop unreachable or workspace not open -- fall back to local.
                self.logger.info("get_session_summary: desktop summary unavailable for \(sessionId) (\(outcome.error ?? "no result")), trying local DB")
                if let database, let session = try? database.session(byId: sessionId) {
                    self.sendLocalSessionSummary(session: session, sessionId: sessionId, callId: callId)
                } else {
                    self.realtimeClient?.sendFunctionCallResult(
                        callId: callId,
                        output: "{\"success\":false,\"error\":\"Could not get the session summary\"}"
                    )
                }
            }
            return
        }

        // No desktop connection: best-effort local summary (no pending prompts).
        if let database, let session = try? database.session(byId: sessionId) {
            sendLocalSessionSummary(session: session, sessionId: sessionId, callId: callId)
            return
        }

        logger.error("get_session_summary: \(sessionId) not local and no desktop connection")
        realtimeClient?.sendFunctionCallResult(
            callId: callId,
            output: "{\"success\":false,\"error\":\"Session not found\"}"
        )
    }

    /// Build a summary from this device's local DB for a synced session.
    private func sendLocalSessionSummary(session: Session, sessionId: String, callId: String) {
        do {
            let messages = (try? database?.messages(forSession: sessionId)) ?? []
            // The last agent message holds the final notes/instructions, so it
            // must always be surfaced. Skip trailing assistant turns that ended
            // on tool calls (empty content) and pick the last one with text.
            let lastAgentMessage = messages.last {
                $0.source == "assistant"
                    && !($0.contentDecrypted?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
            }

            var summary: [String: Any] = [
                "success": true,
                "title": session.titleDecrypted ?? "Untitled",
                "provider": session.provider ?? "unknown",
                "model": session.model ?? "unknown",
                "isExecuting": session.isExecuting,
                "messageCount": messages.count,
                "lastActivity": RelativeTimestamp.format(epochMs: session.updatedAt),
            ]
            if let lastMsg = lastAgentMessage?.contentDecrypted {
                summary["lastAssistantMessage"] = String(lastMsg.prefix(1500))
            }

            let resultData = try JSONSerialization.data(withJSONObject: summary)
            realtimeClient?.sendFunctionCallResult(callId: callId, output: String(data: resultData, encoding: .utf8) ?? "{}")
        } catch {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Failed to get session summary\"}"
            )
        }
    }

    /// Answer a session's pending interactive prompt (question / permission /
    /// commit). Always proxied to the desktop: the prompt's awaiting promise
    /// lives in the desktop process, and only the desktop's canonical transcript
    /// knows which prompt is pending and how to map the spoken answer onto it.
    private func handleAnswerPrompt(args: [String: Any], callId: String) {
        let sessionId = (args["session_id"] as? String) ?? activeSessionId
        let answer = (args["answer"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard let sessionId else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No session specified\"}"
            )
            return
        }
        guard !answer.isEmpty else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No answer provided\"}"
            )
            return
        }
        guard let syncManager, let projectId = resolveProjectId() else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"The desktop must be connected to answer a question\"}"
            )
            return
        }

        let argsJson = Self.encodeArgs(["session_id": sessionId, "answer": answer])
        Task { @MainActor in
            let outcome = await syncManager.callVoiceTool(
                toolName: "answer_prompt",
                argsJson: argsJson,
                projectId: projectId
            )
            if outcome.success, let result = outcome.result, !result.isEmpty {
                let payload: [String: Any] = ["success": true, "message": result]
                self.realtimeClient?.sendFunctionCallResult(callId: callId, output: Self.encodeArgs(payload))
            } else {
                self.logger.error("answer_prompt: desktop failed for \(sessionId): \(outcome.error ?? "no result")")
                let payload: [String: Any] = ["success": false, "error": outcome.error ?? "Could not answer the question"]
                self.realtimeClient?.sendFunctionCallResult(callId: callId, output: Self.encodeArgs(payload))
            }
        }
    }

    private func handleAskCodingAgent(args: [String: Any], callId: String) {
        let question = args["question"] as? String ?? ""
        let sessionId = args["session_id"] as? String ?? activeSessionId

        guard let sessionId, !question.isEmpty else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Missing question or session_id\"}"
            )
            return
        }

        // Route the question as a prompt to the coding session
        let title = sessionTitle(for: sessionId) ?? "Session"
        pendingPrompt = PendingPrompt(
            sessionId: sessionId,
            sessionTitle: title,
            prompt: question,
            submittedAt: Date(),
            delay: settings.promptConfirmationDelay
        )

        pendingPromptTimer = Timer.scheduledTimer(
            withTimeInterval: settings.promptConfirmationDelay,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.autoSubmitPendingPrompt()
            }
        }

        realtimeClient?.sendFunctionCallResult(
            callId: callId,
            output: "{\"success\":true,\"message\":\"Question queued for session \\\"\(title)\\\". Waiting for user confirmation.\"}"
        )
    }

    /// Proxy a project-memory tool to the desktop memory engine over the sync
    /// channel and return its result to the realtime agent. The raw arguments
    /// JSON is forwarded verbatim so the desktop tool sees the exact schema.
    private func handleMemoryTool(name: String, argumentsJson: String, callId: String) {
        guard let syncManager, let projectId else {
            realtimeClient?.sendFunctionCallResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Project memory is unavailable right now.\"}"
            )
            return
        }

        Task { @MainActor in
            let outcome = await syncManager.callVoiceTool(
                toolName: name,
                argsJson: argumentsJson.isEmpty ? "{}" : argumentsJson,
                projectId: projectId
            )
            let payload: [String: Any] = outcome.success
                ? ["success": true, "result": outcome.result ?? ""]
                : ["success": false, "error": outcome.error ?? "Memory tool failed"]
            let json = (try? JSONSerialization.data(withJSONObject: payload))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{\"success\":false}"
            self.realtimeClient?.sendFunctionCallResult(callId: callId, output: json)
        }
    }

    private func handleStopVoiceSession(callId: String) {
        realtimeClient?.sendFunctionCallResult(
            callId: callId,
            output: "{\"success\":true,\"message\":\"Voice session ending\"}"
        )

        // Give the agent time to say goodbye, then deactivate
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.deactivate()
        }
    }

    // MARK: - Idle Management

    private func resetIdleTimer() {
        cancelIdleTimer()
        idleTimer = Timer.scheduledTimer(
            withTimeInterval: settings.idleTimeout,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.transitionToIdle()
            }
        }
    }

    private func cancelIdleTimer() {
        idleTimer?.invalidate()
        idleTimer = nil
    }

    private func transitionToIdle() {
        guard state == .listening else { return }
        logger.info("Voice mode going idle after \(self.settings.idleTimeout)s timeout")
        audioPipeline.stopCapture()
        state = .idle
    }

    private func resumeFromIdle() {
        logger.info("Resuming voice mode from idle")
        guard wakeAudioPipeline() else { return }
        state = .listening
        resetIdleTimer()
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
    private func wakeAudioPipeline() -> Bool {
        do {
            try audioPipeline.startCapture()
            return true
        } catch {
            logger.error("Failed to restart audio pipeline on wake: \(error.localizedDescription)")
            deactivate()
            return false
        }
    }

    // MARK: - Pending Prompt Submission

    private func autoSubmitPendingPrompt() {
        guard let prompt = pendingPrompt else { return }
        submitPromptToSession(prompt)
        pendingPrompt = nil
    }

    private func submitPromptToSession(_ prompt: PendingPrompt) {
        guard let syncManager else {
            logger.error("Cannot submit prompt: no SyncManager")
            return
        }

        Task {
            do {
                try await syncManager.sendPrompt(sessionId: prompt.sessionId, text: prompt.prompt)
                logger.info("Submitted voice prompt to session \(prompt.sessionId)")
            } catch {
                logger.error("Failed to submit prompt: \(error.localizedDescription)")
            }
        }
    }

    private func cancelPendingPromptTimer() {
        pendingPromptTimer?.invalidate()
        pendingPromptTimer = nil
    }

    // MARK: - Queued Completions

    private func processQueuedCompletions() {
        guard !queuedCompletions.isEmpty else { return }
        let completions = queuedCompletions
        queuedCompletions.removeAll()

        for completion in completions {
            let title = sessionTitle(for: completion.sessionId) ?? "Unknown"
            realtimeClient?.sendUserMessage(
                text: "[INTERNAL: Session \"\(title)\" completed: \(completion.summary)]"
            )
        }
    }

    // MARK: - Instructions & Tools

    /// Compact instructions matching the Capacitor pattern - no dynamic session data.
    private func buildCompactInstructions() -> String {
        var context = """
        You are a voice assistant on a mobile device for the Nimbalyst coding workspace. You relay requests between the user and coding agents on their desktop.

        Tools:
        - submit_agent_prompt: Queue a coding task for the desktop agent
        - create_session: Start a brand new coding session on the desktop
        - list_sessions: List this project's sessions (read from this device)
        - switch_session: Focus a specific session for subsequent prompts
        - get_session_summary: Summarize a session (read from this device); also reports any question the session is waiting on
        - answer_prompt: Answer a question / approval the session is waiting on
        - ask_coding_agent: Ask the coding agent a question
        - search_project_knowledge: Look up project docs/plans/decisions in the desktop's project memory (fast)
        - recall: Recall saved project facts relevant to a query
        - remember: Save a fact to project memory
        - stop_voice_session: End the conversation

        For anything about sessions themselves (what sessions exist, whether a session was just created, a session's status or summary), use list_sessions / get_session_summary -- they read directly from this device. NEVER ask the coding agent to check whether a session exists or was created.

        If get_session_summary reports the session is waiting for the user's input, read the question aloud. When the user answers, call answer_prompt with their answer (do NOT route it through ask_coding_agent).

        For questions about this project (how it works, what was decided, what's in flight), prefer search_project_knowledge or recall first -- they answer quickly from the desktop's memory. Fall back to ask_coding_agent only when memory returns nothing. Memory tools require the desktop to be connected; if one reports it's unavailable, say so briefly.

        Keep responses brief and conversational. Never read code verbatim.
        """

        if let projectId {
            let projectName = (projectId as NSString).lastPathComponent
            context += "\nProject: \(projectName)"
        }

        if let activeSessionId {
            let title = sessionTitle(for: activeSessionId) ?? "Untitled"
            context += "\nThe user is viewing session: \"\(title)\""
        }

        // Pin the spoken language to the desktop's configured default so the
        // voice agent never auto-detects/drifts into a different language at
        // startup. Empty/nil preference -> English.
        let trimmedLanguage = settings.language?.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveLanguage = (trimmedLanguage?.isEmpty == false ? trimmedLanguage! : "English")
        context += "\n\nLANGUAGE: Always speak to the user in \(effectiveLanguage), regardless of the language the user speaks in. Begin and conduct the entire conversation in \(effectiveLanguage)."

        return context
    }

    /// Core tools matching the Capacitor implementation exactly (3 tools).
    private func buildCoreToolDefinitions() -> [[String: Any]] {
        [
            [
                "type": "function",
                "name": "submit_agent_prompt",
                "description": "Queue a coding task for the desktop coding agent. The user will see the task and can review/cancel it before it runs.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "prompt": [
                            "type": "string",
                            "description": "The coding task to send to the desktop agent.",
                        ],
                    ],
                    "required": ["prompt"],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "create_session",
                "description": "Create a new coding session on the desktop and start fresh. Use when the user asks to start a new session, open a fresh chat, or begin a new task. The new session appears in the session list shortly after.",
                "parameters": [
                    "type": "object",
                    "properties": [:] as [String: Any],
                    "required": [] as [String],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "list_sessions",
                "description": "List or find coding sessions in this project (id, title, running status, last activity). With no query it returns the most recent sessions from this device. With a query it finds sessions by TOPIC -- semantically matching what each session was actually working on (its prompts and work done), not just the title -- by searching the desktop's project memory, so \"the session working on the collaborative document system\" resolves even when those words aren't in the title. Use this to answer what sessions exist or confirm a session was created -- do NOT ask the coding agent for that.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "query": [
                            "type": "string",
                            "description": "Optional topic to find sessions by. Describe what the session was about (e.g. \"voice mode bugs\"); matched semantically against session content, not just titles.",
                        ],
                    ],
                    "required": [] as [String],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "switch_session",
                "description": "Switch the voice agent's focus to a specific existing session so subsequent prompts target it. Call list_sessions first to get the session_id.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "session_id": [
                            "type": "string",
                            "description": "The opaque `id` field of the session from list_sessions. NOT the session title.",
                        ],
                    ],
                    "required": ["session_id"],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "get_session_summary",
                "description": "Get a summary of a session (title, message count, last activity, recent assistant message), read from this device. To summarize the session the user is viewing, OMIT session_id. To summarize a different session, first call list_sessions and pass that session's `id`.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "session_id": [
                            "type": "string",
                            "description": "Optional opaque session id (the `id` field from list_sessions). NOT the session title. Omit to summarize the session the user is viewing.",
                        ],
                    ],
                    "required": [] as [String],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "answer_prompt",
                "description": "Answer a question or approval the session is waiting on (an interactive prompt surfaced by get_session_summary as 'waiting for your input'). Use this when the user gives an answer to that pending question, or approves/denies a permission or commit request. Requires the desktop to be connected.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "session_id": [
                            "type": "string",
                            "description": "Optional opaque session id (the `id` field from list_sessions). Omit to answer the session the user is viewing.",
                        ],
                        "answer": [
                            "type": "string",
                            "description": "The user's answer in their own words (e.g. the chosen option, or yes/no for a permission or commit request).",
                        ],
                    ],
                    "required": ["answer"],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "ask_coding_agent",
                "description": "Ask the coding agent a question. Use when you need information about the project, files, or implementation.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "question": [
                            "type": "string",
                            "description": "The question to ask the coding agent.",
                        ],
                    ],
                    "required": ["question"],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "stop_voice_session",
                "description": "End the voice conversation when the user says goodbye or wants to stop.",
                "parameters": [
                    "type": "object",
                    "properties": [:] as [String: Any],
                    "required": [] as [String],
                ] as [String: Any],
            ],
            // Project-memory tools, proxied to the desktop memory engine over sync.
            [
                "type": "function",
                "name": "search_project_knowledge",
                "description": "Search this project's knowledge (design docs, plans, CLAUDE.md, notes) on the desktop. Use for questions about how the project works, decisions, or what's in flight. Requires the desktop to be connected.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "query": [
                            "type": "string",
                            "description": "Natural-language or keyword query.",
                        ],
                    ],
                    "required": ["query"],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "recall",
                "description": "Recall saved project facts/memories relevant to a query (newest wins when facts conflict). Requires the desktop to be connected.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "query": [
                            "type": "string",
                            "description": "What to recall.",
                        ],
                    ],
                    "required": ["query"],
                ] as [String: Any],
            ],
            [
                "type": "function",
                "name": "remember",
                "description": "Save a fact to project memory for later recall. Use when the user says to remember something. Requires the desktop to be connected.",
                "parameters": [
                    "type": "object",
                    "properties": [
                        "text": [
                            "type": "string",
                            "description": "The fact to remember.",
                        ],
                    ],
                    "required": ["text"],
                ] as [String: Any],
            ],
        ]
    }

    // MARK: - Helpers

    private func sessionTitle(for sessionId: String) -> String? {
        try? database?.session(byId: sessionId)?.titleDecrypted
    }

    private func parseArguments(_ json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return dict
    }
}

// MARK: - Voice Mode Settings

public struct VoiceModeSettings: Codable {
    public var voice: String
    public var idleTimeout: TimeInterval
    public var autoAnnounceCompletions: Bool
    public var vadThreshold: Double
    public var silenceDurationMs: Int
    public var promptConfirmationDelay: TimeInterval
    /// Preferred spoken language synced from the desktop (BCP-47 or common
    /// language name). The voice agent pins its language to this. Nil/empty
    /// means no preference -> English. Optional so older persisted settings
    /// that lack the field still decode.
    public var language: String?

    public init(
        voice: String = "sage",
        idleTimeout: TimeInterval = 30,
        autoAnnounceCompletions: Bool = true,
        vadThreshold: Double = 0.5,
        silenceDurationMs: Int = 500,
        promptConfirmationDelay: TimeInterval = 5,
        language: String? = nil
    ) {
        self.voice = voice
        self.idleTimeout = idleTimeout
        self.autoAnnounceCompletions = autoAnnounceCompletions
        self.vadThreshold = vadThreshold
        self.silenceDurationMs = silenceDurationMs
        self.promptConfirmationDelay = promptConfirmationDelay
        self.language = language
    }

    private static let userDefaultsKey = "voiceModeSettings"

    public static func load() -> VoiceModeSettings {
        guard let data = UserDefaults.standard.data(forKey: userDefaultsKey),
              let settings = try? JSONDecoder().decode(VoiceModeSettings.self, from: data) else {
            return VoiceModeSettings()
        }
        return settings
    }

    public func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: VoiceModeSettings.userDefaultsKey)
        }
    }
}
#endif
