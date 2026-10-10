#if os(iOS)
import Foundation
import Combine

/// Sends each Live conversation to the desktop as a voice session, so what the
/// user said, what the agent said, and every tool call and result can be read
/// afterwards. Nothing here affects the conversation itself.
@MainActor
extension VoiceAgent {
    func beginConversationLog() {
        guard voiceLogConversation != usageConversation else { return }
        guard effectiveEngine == .live, let host = selectedHostDeviceId, let project = resolveProjectId() else { return }
        voiceLogConversation = usageConversation
        var log = VoiceConversationLog(hostDeviceId: host, projectId: project, linkedSessionId: activeSessionId)
        log.system("Phone voice started. Visible session: \(activeSessionId ?? "none").")
        voiceLogs.append(log)
        // A dropped sync socket clears the device roster, so tools report the computer
        // unavailable; record each drop and its reason in the conversation.
        voiceLogSyncWatch = syncManager?.$isConnected.removeDuplicates().dropFirst().sink { [weak self] connected in
            guard let self else { return }
            self.logVoiceSystem(connected ? "Phone sync reconnected." : "Phone sync disconnected: \(self.syncManager?.lastSyncDisconnectReason ?? "no reason recorded")")
        }
        // Old records keep their place until acknowledged, but never grow without bound.
        if voiceLogs.count > 5 { voiceLogs.removeFirst(voiceLogs.count - 5) }
        flushConversationLog()
    }

    /// Record into the current conversation only; nothing is logged between conversations.
    func withConversationLog(_ change: (inout VoiceConversationLog) -> Void) {
        guard state != .disconnected, voiceLogConversation == usageConversation, !voiceLogs.isEmpty else { return }
        change(&voiceLogs[voiceLogs.count - 1])
        flushConversationLog()
    }

    func logVoiceSystem(_ message: String) {
        withConversationLog { $0.system(message) }
    }

    func endConversationLog() {
        guard voiceLogConversation == usageConversation, !voiceLogs.isEmpty else { return }
        voiceLogConversation = nil
        voiceLogSyncWatch = nil
        voiceLogs[voiceLogs.count - 1].recordTranscripts(liveTranscripts, final: true)
        voiceLogs[voiceLogs.count - 1].system("Phone voice stopped.")
        flushConversationLog()
    }

    func flushConversationLog() {
        guard !voiceLogFlushing, let syncManager, let index = voiceLogs.firstIndex(where: { !$0.pending.isEmpty }) else { return }
        voiceLogFlushing = true
        let batch = voiceLogs[index].nextBatch()
        let log = voiceLogs[index]
        Task { [weak self] in
            guard let self else { return }
            guard await self.desktopAcceptsVoiceLog(host: log.hostDeviceId, projectId: log.projectId) else {
                // A desktop without the capability would reject every batch; keep nothing for it.
                self.voiceLogs.removeAll { $0.hostDeviceId == log.hostDeviceId }
                self.voiceLogFlushing = false
                return
            }
            var args: [String: Any] = ["conversation_id": log.conversationId,
                                       "entries": batch.map { ["entryId": $0.entryId, "direction": $0.direction, "content": $0.content, "timestamp": $0.timestamp] }]
            if let linked = log.linkedSessionId { args["linked_session_id"] = linked }
            let outcome = await syncManager.callLiveVoiceTool(toolName: "voice_log", argsJson: Self.encodeArgs(args), scope: self.voiceLogScope(log))
            self.voiceLogFlushing = false
            guard let current = self.voiceLogs.firstIndex(where: { $0.conversationId == log.conversationId }) else { return }
            if outcome.success {
                self.voiceLogs[current].acknowledge(Set(batch.map(\.entryId)))
                if self.voiceLogs[current].pending.isEmpty, current < self.voiceLogs.count - 1 { self.voiceLogs.remove(at: current) }
                self.flushConversationLog()
            } else {
                self.logger.info("voice_log: batch not stored (\(outcome.error ?? "no error")); retrying")
                self.scheduleConversationLogRetry()
            }
        }
    }

    private func scheduleConversationLogRetry() {
        voiceLogRetry?.cancel()
        voiceLogRetry = Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }
            self?.flushConversationLog()
        }
    }

    private func voiceLogScope(_ log: VoiceConversationLog) -> VoiceRelayScope {
        VoiceRelayScope(version: 1, hostDeviceId: log.hostDeviceId, projectId: log.projectId, sessionId: nil,
                        voiceGeneration: connectionGeneration.value.uuidString, actionId: UUID().uuidString,
                        announcingDeviceId: WebSocketClient.deviceId)
    }

    private func desktopAcceptsVoiceLog(host: String, projectId: String) async -> Bool {
        if let known = voiceLogSupportedHosts[host] { return known }
        guard let syncManager else { return false }
        let scope = VoiceRelayScope(version: 1, hostDeviceId: host, projectId: projectId, sessionId: nil,
                                    voiceGeneration: connectionGeneration.value.uuidString, actionId: UUID().uuidString,
                                    announcingDeviceId: WebSocketClient.deviceId)
        let capability = await syncManager.callLiveVoiceTool(toolName: "capabilities", argsJson: "{}", scope: scope)
        // Unreachable is not "unsupported": retry the probe with the batch.
        guard capability.success, let text = capability.result else { return true }
        let supported = parseArguments(text)["voiceLog"] as? Int == 1
        voiceLogSupportedHosts[host] = supported
        return supported
    }
}
#endif
