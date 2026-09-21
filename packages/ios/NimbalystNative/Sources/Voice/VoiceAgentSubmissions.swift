#if os(iOS)
import Foundation

@MainActor
extension VoiceAgent {
    // MARK: - Pending Prompt Submission

    func autoSubmitPendingPrompt() {
        guard let prompt = pendingPrompt else { return }
        submitPromptToSession(prompt)
        pendingPrompt = nil
    }

    func submitPromptToSession(_ prompt: PendingPrompt) {
        guard let syncManager else {
            logger.error("Cannot submit prompt: no SyncManager")
            return
        }

        let epoch = connectionGeneration.value
        let submittingEngine = effectiveEngine
        let submittingProject = resolveProjectId()
        let client = voiceClient
        Task {
            guard connectionGeneration.accepts(epoch) else { return }
            do {
                if submittingEngine == .live {
                    guard let session = try database?.session(byId: prompt.sessionId), session.projectId == submittingProject,
                          let host = prompt.hostDeviceId, session.hostDeviceId == host else {
                        submissionStatus = "Submission unavailable: session ownership changed."
                        return
                    }
                }
                let submissionId = try await syncManager.sendPrompt(sessionId: prompt.sessionId, text: prompt.prompt, promptId: prompt.id.uuidString)
                guard connectionGeneration.accepts(epoch) else { return }
                submissionStatus = "Task submitted"
                let receipt = Self.encodeArgs(["status": "accepted_submission", "submission_id": submissionId, "session_id": prompt.sessionId, "message": "Submitted to sync. This is not task completion."])
                if let live = client as? LiveClient { live.appendContext(receipt, speak: true) }
                else { client?.sendUserMessage(text: receipt) }
            } catch {
                guard connectionGeneration.accepts(epoch) else { return }
                submissionStatus = "Task submission failed. Open the session to retry."
                logger.error("Failed to submit prompt: \(error.localizedDescription)")
            }
        }
    }

    func cancelPendingPromptTimer() {
        pendingPromptTimer?.invalidate()
        pendingPromptTimer = nil
    }

}
#endif
