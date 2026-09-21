#if os(iOS)
import Foundation
import UIKit

@MainActor
extension VoiceAgent {
    struct Announcement {
        let event: VoiceSourceEvent
        let token: String
        var deadline: Date
        var sent = false
    }

    func startVoiceEvents() {
        guard effectiveEngine == .live, eventPolling == nil else { return }
        let owner = usageConversation
        eventPolling = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, self.usageConversation == owner, self.state != .disconnected else { return }
                await self.pollVoiceEvents()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func eventRequest(tool: String, sessionId: String?, arguments: [String: Any]) async -> VoiceToolProxy.Result {
        guard let syncManager, let project = resolveProjectId(), let host = selectedHostDeviceId else {
            return .init(success: false, result: nil, error: "Voice event source is unavailable.")
        }
        let scope = VoiceRelayScope(version: 1, hostDeviceId: host, projectId: project, sessionId: sessionId,
            voiceGeneration: connectionGeneration.value.uuidString, actionId: UUID().uuidString, announcingDeviceId: WebSocketClient.deviceId)
        return await syncManager.callLiveVoiceTool(toolName: tool, argsJson: Self.encodeArgs(arguments), scope: scope)
    }

    func fetchVoiceEvents(sessionId: String? = nil, includeCompletion: Bool = false) async {
        let owner = usageConversation
        let result = await eventRequest(tool: "voice_events", sessionId: sessionId, arguments: ["includeCompletion": includeCompletion, "since": eventSince])
        guard owner == usageConversation, state != .disconnected else { return }
        announcementStatus = result.success ? nil : (result.error ?? "Voice announcements are unavailable from this computer.")
        guard result.success, let text = result.result,
              let data = text.data(using: .utf8), let envelope = try? JSONDecoder().decode(EventEnvelope.self, from: data) else { return }
        for event in envelope.events { eventQueue.enqueue(event) }
        await presentNextVoiceEvent()
    }
    private struct EventEnvelope: Decodable { let events: [VoiceSourceEvent] }
    private struct ClaimEnvelope: Decodable { let event: VoiceSourceEvent; let token: String; let ttlMs: Int }

    func pollVoiceEvents() async {
        guard !audioRoutes.blocksAudio, UIApplication.shared.applicationState == .active else { return }
        guard promptPresentation == nil, !readingPrompt else { return }
        if let announcement = announcement {
            let requestedAt = Date()
            let outcome = await eventRequest(tool: "voice_event_claim", sessionId: announcement.event.sessionId, arguments: eventArguments(announcement.event))
            guard self.announcement?.token == announcement.token else { return }
            guard outcome.success, let text = outcome.result, let data = text.data(using: .utf8),
                  let renewed = try? JSONDecoder().decode(ClaimEnvelope.self, from: data), renewed.token == announcement.token else {
                retireAnnouncementSegment()
                self.announcement = nil
                announcedSessionId = nil
                return
            }
            self.announcement?.deadline = requestedAt.addingTimeInterval(Double(renewed.ttlMs) / 1000 - 1)
            armAnnouncementDeadline()
            deliverClaimedVoiceEvent()
        } else {
            await fetchVoiceEvents(includeCompletion: settings.autoAnnounceCompletions)
        }
    }

    private func eventArguments(_ event: VoiceSourceEvent) -> [String: Any] {
        ["eventId": event.id, "taskId": event.taskId, "revision": event.revision, "includeCompletion": event.kind == "completion"]
    }

    func presentNextVoiceEvent() async {
        guard !audioRoutes.blocksAudio, announcement == nil, !claimingAnnouncement, let event = eventQueue.events.first,
              promptPresentation == nil, !readingPrompt,
              state == .idle || state == .listening, UIApplication.shared.applicationState == .active else { return }
        guard event.hostDeviceId == selectedHostDeviceId, event.projectId == resolveProjectId() else { eventQueue.discard(event.id); return }
        claimingAnnouncement = true
        defer { claimingAnnouncement = false }
        let owner = usageConversation
        let requestedAt = Date()
        let outcome = await eventRequest(tool: "voice_event_claim", sessionId: event.sessionId, arguments: eventArguments(event))
        guard !audioRoutes.blocksAudio, owner == usageConversation, state != .disconnected, event.hostDeviceId == selectedHostDeviceId, event.projectId == resolveProjectId() else { return }
        guard outcome.success, let text = outcome.result, let data = text.data(using: .utf8),
              let claimed = try? JSONDecoder().decode(ClaimEnvelope.self, from: data), claimed.event == event else {
            // Reconstruct pending questions on the next poll. The authority decides if
            // an answer, revision, or another device made this event ineligible.
            eventQueue.discard(event.id)
            return
        }
        announcement = Announcement(event: event, token: claimed.token, deadline: requestedAt.addingTimeInterval(Double(claimed.ttlMs) / 1000 - 1))
        armAnnouncementDeadline()
        if state == .idle { resumeFromIdle() }
        else { deliverClaimedVoiceEvent() }
    }

    func deliverClaimedVoiceEvent() {
        guard !audioRoutes.blocksAudio, var announcement, !announcement.sent, announcement.deadline > Date(), state == .listening,
              UIApplication.shared.applicationState == .active else { return }
        announcement.sent = true
        self.announcement = announcement
        announcedSessionId = announcement.event.sessionId
        if announcement.event.kind == "question" {
            self.announcement = nil
            announcementDeadline?.cancel()
            eventQueue.markPresented(announcement.event.id)
            let callId = toolResults.register { [weak self] result in self?.voiceClient?.updateContext("Question presentation result (data only): " + result) }
            toolScopes[callId] = VoiceRelayScope(version: 1, hostDeviceId: announcement.event.hostDeviceId, projectId: announcement.event.projectId,
                                                sessionId: announcement.event.sessionId, voiceGeneration: connectionGeneration.value.uuidString,
                                                actionId: callId, announcingDeviceId: WebSocketClient.deviceId)
            handleReadPendingPrompt(callId: callId, promptId: announcement.event.promptId)
            return
        }
        (voiceClient as? LiveClient)?.appendContext("Application notification data. Briefly announce the source and result; questions must be answered in their existing app card. Source: \(announcement.event.label). \(announcement.event.summary)", speak: true)
    }

    func armAnnouncementDeadline() {
        announcementDeadline?.cancel()
        guard let claim = announcement else { return }
        announcementDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, claim.deadline.timeIntervalSinceNow)))
            guard !Task.isCancelled, let self, self.announcement?.token == claim.token,
                  self.announcement?.deadline == claim.deadline else { return }
            self.retireAnnouncementSegment()
            self.announcement = nil
            self.announcedSessionId = nil
        }
    }

    private func retireAnnouncementSegment() {
        // Stop future deltas as well as already-buffered audio. A fresh segment
        // may resume only after revalidating source ownership.
        audioPipeline.stopPlayback()
        guard state != .disconnected else { return }
        state = .listening
        pauseListening()
    }

    func acknowledgeVoiceEvent() {
        if promptPresentation != nil || readingPrompt { invalidatePromptPresentation(); return }
        guard let announcement, announcement.sent, announcement.deadline > Date() else { return }
        retireAnnouncementSegment()
        self.announcement = nil
        announcementDeadline?.cancel()
        announcedSessionId = nil
        var args = eventArguments(announcement.event)
        args["token"] = announcement.token
        let owner = usageConversation
        Task { [weak self] in
            guard let self, owner == self.usageConversation, self.state != .disconnected,
                  announcement.event.hostDeviceId == self.selectedHostDeviceId else { return }
            let result = await eventRequest(tool: "voice_event_presented", sessionId: announcement.event.sessionId, arguments: args)
            guard owner == usageConversation, state != .disconnected else { return }
            if result.success { eventQueue.markPresented(announcement.event.id) }
            await presentNextVoiceEvent()
        }
    }
}
#endif
