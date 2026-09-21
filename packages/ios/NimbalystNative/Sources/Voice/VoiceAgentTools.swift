#if os(iOS)
import Foundation
import os

@MainActor
extension VoiceAgent {
    func sendToolResult(callId: String, output: String) {
        if promptReadoutCallId == callId {
            promptReadoutCallId = nil
            readingPrompt = false
            if let error = parseArguments(output)["error"] as? String { announcementStatus = error }
        }
        toolScopes.removeValue(forKey: callId)
        toolResults.finish(callId, output: output)
    }

    // MARK: - Tool Handling

    func handleToolCall(name: String, arguments: String, callId: String) {
        let args = parseArguments(arguments)
        if effectiveEngine == .live, let sessionId = args["session_id"] as? String,
           let session = try? database?.session(byId: sessionId),
           session.projectId != resolveProjectId() || session.hostDeviceId != toolScopes[callId]?.hostDeviceId {
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "Session belongs to another computer or project."]))
            return
        }

        switch name {
        case "get_current_context":
            sendToolResult(callId: callId, output: screenContextJSON())
        case "read_pending_prompt":
            handleReadPendingPrompt(callId: callId)
        case "get_prompt_answer_status":
            handlePromptAnswerStatus(callId: callId)
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
        case "open_file":
            handleOpenFile(args: args, callId: callId)
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
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Unknown tool: \(name)\"}"
            )
        }
    }

    // Intentional divergence from desktop: on gpt-realtime-2 the desktop keeps
    // submit_agent_prompt open as an async (deferred) call and resolves it with
    // the coding agent's real summary. iOS cannot -- the prompt is relayed to
    // the desktop over the sync channel and the completion arrives later as a
    // separate broadcast (onSessionCompleted), so the tool call is answered
    // immediately with a queued acknowledgment on both models.
    func handleSubmitPrompt(args: [String: Any], callId: String) {
        guard pendingPrompt == nil else {
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "status": "pending_confirmation", "error": "Review or cancel the existing pending task first."]))
            return
        }
        let requestedPrompt = args["prompt"] as? String ?? ""
        let prompt = requestedPrompt.isEmpty ? "" : requestedPrompt + (fileContext.map { "\nReferenced project file: \($0)" } ?? "")
        let sessionId = args["session_id"] as? String ?? activeSessionId

        guard let sessionId, !prompt.isEmpty else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Missing prompt or session_id\"}"
            )
            return
        }

        let title = sessionTitle(for: sessionId) ?? "Session"

        // Set pending prompt (shows confirmation card)
        cancelPendingPromptTimer()
        pendingPrompt = PendingPrompt(
            sessionId: sessionId,
            sessionTitle: title,
            prompt: prompt,
            submittedAt: Date(),
            delay: settings.promptConfirmationDelay,
            hostDeviceId: toolScopes[callId]?.hostDeviceId
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

        sendToolResult(
            callId: callId,
            output: Self.encodeArgs(["success": true, "status": "pending_confirmation", "submission_id": pendingPrompt!.id.uuidString, "session_id": sessionId])
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
    func handleCreateSession(args: [String: Any], callId: String) {
        guard let syncManager else {
            logger.error("create_session: syncManager unavailable")
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Sync is unavailable\"}"
            )
            return
        }

        guard let resolvedProjectId = resolveProjectId() else {
            logger.error("create_session: no projectId (configured=\(self.projectId ?? "nil"), activeSessionId=\(self.activeSessionId ?? "nil"))")
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No project configured\"}"
            )
            return
        }

        let targetHost = effectiveEngine == .live ? toolScopes[callId]?.hostDeviceId : selectedHostDeviceId
        if effectiveEngine == .live && targetHost == nil {
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "Select a computer before creating a voice session."]))
            return
        }
        do {
            // Remember the requestId so we navigate this device to the new session
            // when the desktop's create-session response arrives (see AppState).
            pendingCreateSessionRequestId = try syncManager.createSession(projectId: resolvedProjectId, targetDeviceId: targetHost)
            logger.info("create_session: sent request for project \(resolvedProjectId)")
            sendToolResult(
                callId: callId,
                output: "{\"success\":true,\"message\":\"Creating a new session on the desktop. It will appear in the session list shortly.\"}"
            )
        } catch {
            logger.error("create_session: failed to send request: \(error.localizedDescription)")
            sendToolResult(
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
    func resolveProjectId() -> String? {
        if let projectId { return projectId }
        if let activeSessionId, let session = try? database?.session(byId: activeSessionId) {
            return session.projectId
        }
        return nil
    }

    /// JSON-encode a tool-args dictionary for proxying over the sync channel.
    static func encodeArgs(_ dict: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return "{}" }
        return json
    }

    func handleListSessions(args: [String: Any], callId: String) {
        let query = (args["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        // With a topic query, proxy to the desktop's semantic (memory-backed)
        // session search -- the SAME lookup the desktop voice agent uses -- so a
        // topic matches a session even when its title doesn't contain the words.
        // Falls back to the local recency list when there's no query, no desktop
        // connection, or the desktop doesn't respond (so it still works offline).
        if let query, !query.isEmpty,
           syncManager != nil, let projectId = resolveProjectId() {
            let argsJson = Self.encodeArgs(["query": query])
            Task { @MainActor in
                let outcome = await self.callDesktopTool(
                    callId: callId,
                    toolName: "list_sessions",
                    argsJson: argsJson,
                    projectId: projectId
                )
                guard self.toolResults.contains(callId) else { return }
                if outcome.success, let result = outcome.result, !result.isEmpty {
                    self.sendToolResult(callId: callId, output: result)
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
    func sendLocalSessionList(callId: String) {
        guard let database, let projectId = resolveProjectId() else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No project configured\"}"
            )
            return
        }

        do {
            let sessions = try database.sessions(forProject: projectId).filter {
                effectiveEngine != .live || $0.hostDeviceId == toolScopes[callId]?.hostDeviceId
            }
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
            sendToolResult(callId: callId, output: resultString)
        } catch {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Failed to list sessions\"}"
            )
        }
    }

    func handleSwitchSession(args: [String: Any], callId: String) {
        guard let sessionId = args["session_id"] as? String else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Missing session_id\"}"
            )
            return
        }

        if effectiveEngine == .live {
            guard let session = try? database?.session(byId: sessionId), session.projectId == resolveProjectId(),
                  session.hostDeviceId == selectedHostDeviceId else {
                sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "Session is not available on the selected computer in this project."]))
                return
            }
        }
        activeSessionId = VoiceSessionFocusReducer.reduce(
            current: activeSessionId,
            event: .switchSession(sessionId)
        )
        onOpenSession?(sessionId)
        let title = sessionTitle(for: sessionId) ?? "Unknown"

        sendToolResult(
            callId: callId,
            output: "{\"success\":true,\"message\":\"Switched to session \\\"\(title)\\\"\"}"
        )
    }

    func handleGetSessionSummary(args: [String: Any], callId: String) {
        let sessionId = (args["session_id"] as? String) ?? activeSessionId

        guard let sessionId else {
            logger.error("get_session_summary: no session (active=\(self.activeSessionId ?? "nil"))")
            sendToolResult(
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
        if syncManager != nil, let projectId = resolveProjectId() {
            let argsJson = Self.encodeArgs(["session_id": sessionId])
            Task { @MainActor in
                let outcome = await self.callDesktopTool(
                    callId: callId,
                    toolName: "get_session_summary",
                    argsJson: argsJson,
                    projectId: projectId
                )
                guard self.toolResults.contains(callId) else { return }
                if outcome.success, let result = outcome.result, !result.isEmpty {
                    let payload: [String: Any] = ["success": true, "source": "desktop", "session_id": sessionId, "summary": result, "pending_prompt_available": true]
                    self.sendToolResult(callId: callId, output: Self.encodeArgs(payload))
                    return
                }
                // Desktop unreachable or workspace not open -- fall back to local.
                self.logger.info("get_session_summary: desktop summary unavailable for \(sessionId) (\(outcome.error ?? "no result")), trying local DB")
                if let database, let session = try? database.session(byId: sessionId) {
                    self.sendLocalSessionSummary(session: session, sessionId: sessionId, callId: callId)
                } else {
                    self.sendToolResult(
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
        sendToolResult(
            callId: callId,
            output: "{\"success\":false,\"error\":\"Session not found\"}"
        )
    }

    /// Build a summary from this device's local DB for a synced session.
    func sendLocalSessionSummary(session: Session, sessionId: String, callId: String) {
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
                "source": "local_cache",
                "session_id": sessionId,
                "updated_at": session.updatedAt,
                "pending_prompt_available": false,
                "limitation": "Offline cached summary; pending questions and approvals are unknown. Do not infer that no question is waiting.",
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
            sendToolResult(callId: callId, output: String(data: resultData, encoding: .utf8) ?? "{}")
        } catch {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Failed to get session summary\"}"
            )
        }
    }

    /// Answer a session's pending interactive prompt (question / permission /
    /// commit). Always proxied to the desktop: the prompt's awaiting promise
    /// lives in the desktop process, and only the desktop's canonical transcript
    /// knows which prompt is pending and how to map the spoken answer onto it.
    func handleAnswerPrompt(args: [String: Any], callId: String) {
        if effectiveEngine == .live {
            handleLiveAnswerPrompt(callId: callId)
            return
        }
        let sessionId = (args["session_id"] as? String) ?? activeSessionId
        let answer = (args["answer"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard let sessionId else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No session specified\"}"
            )
            return
        }
        guard !answer.isEmpty else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"No answer provided\"}"
            )
            return
        }
        guard syncManager != nil, let projectId = resolveProjectId() else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"The desktop must be connected to answer a question\"}"
            )
            return
        }

        let argsJson = Self.encodeArgs(["session_id": sessionId, "answer": answer])
        Task { @MainActor in
            let outcome = await self.callDesktopTool(
                callId: callId,
                toolName: "answer_prompt",
                argsJson: argsJson,
                projectId: projectId
            )
            if outcome.success, let result = outcome.result, !result.isEmpty {
                let payload: [String: Any] = ["success": true, "message": result]
                self.sendToolResult(callId: callId, output: Self.encodeArgs(payload))
            } else {
                self.logger.error("answer_prompt: desktop failed for \(sessionId): \(outcome.error ?? "no result")")
                let payload: [String: Any] = ["success": false, "error": outcome.error ?? "Could not answer the question"]
                self.sendToolResult(callId: callId, output: Self.encodeArgs(payload))
            }
        }
    }

    func handleAskCodingAgent(args: [String: Any], callId: String) {
        guard pendingPrompt == nil else {
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "status": "pending_confirmation", "error": "Review or cancel the existing pending task first."]))
            return
        }
        let question = args["question"] as? String ?? ""
        let sessionId = args["session_id"] as? String ?? activeSessionId

        guard let sessionId, !question.isEmpty else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Missing question or session_id\"}"
            )
            return
        }

        // Route the question as a prompt to the coding session
        let title = sessionTitle(for: sessionId) ?? "Session"
        cancelPendingPromptTimer()
        pendingPrompt = PendingPrompt(
            sessionId: sessionId,
            sessionTitle: title,
            prompt: question,
            submittedAt: Date(),
            delay: settings.promptConfirmationDelay,
            hostDeviceId: toolScopes[callId]?.hostDeviceId
        )

        pendingPromptTimer = Timer.scheduledTimer(
            withTimeInterval: settings.promptConfirmationDelay,
            repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.autoSubmitPendingPrompt()
            }
        }

        sendToolResult(
            callId: callId,
            output: Self.encodeArgs(["success": true, "status": "pending_confirmation", "submission_id": pendingPrompt!.id.uuidString, "session_id": sessionId])
        )
    }

    /// Proxy a project-memory tool to the desktop memory engine over the sync
    /// channel and return its result to the realtime agent. The raw arguments
    /// JSON is forwarded verbatim so the desktop tool sees the exact schema.
    func handleMemoryTool(name: String, argumentsJson: String, callId: String) {
        guard syncManager != nil, let projectId else {
            sendToolResult(
                callId: callId,
                output: "{\"success\":false,\"error\":\"Project memory is unavailable right now.\"}"
            )
            return
        }

        Task { @MainActor in
            let outcome = await self.callDesktopTool(
                callId: callId,
                toolName: name,
                argsJson: argumentsJson.isEmpty ? "{}" : argumentsJson,
                projectId: projectId
            )
            let payload: [String: Any] = outcome.success
                ? ["success": true, "result": outcome.result ?? ""]
                : ["success": false, "error": outcome.error ?? "Memory tool failed"]
            let json = (try? JSONSerialization.data(withJSONObject: payload))
                .flatMap { String(data: $0, encoding: .utf8) } ?? "{\"success\":false}"
            self.sendToolResult(callId: callId, output: json)
        }
    }

    func handleStopVoiceSession(callId: String) {
        sendToolResult(
            callId: callId,
            output: "{\"success\":true,\"message\":\"Voice session ending\"}"
        )

        // Give the agent time to say goodbye, then deactivate
        let epoch = connectionGeneration.value
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch) else { return }
            self.deactivate()
        }
    }

}
#endif
