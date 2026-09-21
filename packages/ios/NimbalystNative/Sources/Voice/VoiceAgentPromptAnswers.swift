#if os(iOS)
import Foundation
import UIKit

@MainActor
extension VoiceAgent {
    func invalidatePromptPresentation() {
        if readingPrompt && state == .speaking { state = .listening }
        if let callId = promptReadoutCallId {
            promptReadoutCallId = nil
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "The readout was interrupted. Read the pending prompt again."]))
        }
        promptSpeaker.stop()
        promptPresentation = nil
        promptRenewal?.cancel()
        promptRenewal = nil
        readingPrompt = false
        announcedSessionId = nil
    }

    private func promptRequest(_ tool: String, presentation: VoicePromptPresentation, answer: String? = nil) async -> VoiceToolProxy.Result {
        guard let syncManager, connectionGeneration.accepts(presentation.generation), selectedHostDeviceId == presentation.hostId,
              resolveProjectId() == presentation.projectId else { return .init(success: false, result: nil, error: "The source conversation changed.") }
        var arguments: [String: Any] = ["promptId": presentation.prompt.promptId, "version": presentation.prompt.version,
                                       "token": presentation.prompt.token, "claimToken": presentation.prompt.claimToken]
        if let answer { arguments["answer"] = answer }
        let scope = VoiceRelayScope(version: 1, hostDeviceId: presentation.hostId, projectId: presentation.projectId,
                                    sessionId: presentation.prompt.sessionId, voiceGeneration: presentation.generation.uuidString,
                                    actionId: UUID().uuidString, announcingDeviceId: WebSocketClient.deviceId)
        return await syncManager.callLiveVoiceTool(toolName: tool, argsJson: Self.encodeArgs(arguments), scope: scope)
    }

    func handleReadPendingPrompt(callId: String, promptId: String? = nil) {
        guard let scope = toolScopes[callId], scope.sessionId != nil, let syncManager else {
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "Open the source session first."]))
            return
        }
        invalidatePromptPresentation()
        promptReadoutCallId = callId
        readingPrompt = true
        let epoch = connectionGeneration.value
        Task { [weak self] in
            guard let self else { return }
            let capability = await self.callDesktopTool(callId: callId, toolName: "capabilities", argsJson: "{}", projectId: scope.projectId)
            guard self.toolResults.contains(callId) else { return }
            guard capability.success, let text = capability.result, self.parseArguments(text)["promptAnswersVersion"] as? Int == 1 else {
                self.sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "This desktop does not support spoken Live answers. Use the prompt card or update the desktop."]))
                return
            }
            let result = await syncManager.callLiveVoiceTool(toolName: "voice_prompt_prepare", argsJson: Self.encodeArgs(promptId.map { ["promptId": $0] } ?? [:]), scope: scope)
            guard self.toolResults.contains(callId), self.connectionGeneration.accepts(epoch) else { return }
            guard result.success, let text = result.result, let prompt = try? JSONDecoder().decode(PreparedVoicePrompt.self, from: Data(text.utf8)),
                  prompt.sessionId == scope.sessionId, prompt.ttlMs > 1000, prompt.ttlMs <= 120000,
                  !prompt.readout.isEmpty, prompt.readout.count <= 3000 else {
                self.sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": result.error ?? "Could not read this prompt. Use its app card."]))
                return
            }
            let presentation = VoicePromptPresentation(prompt: prompt, generation: epoch, projectId: scope.projectId, hostId: scope.hostDeviceId,
                                                      deadline: Date().addingTimeInterval(Double(prompt.ttlMs) / 1000 - 1))
            self.promptPresentation = presentation
            self.announcedSessionId = prompt.sessionId
            self.readingPrompt = true
            self.audioPipeline.stopPlayback()
            self.voiceClient?.interruptPlayback(audioEndMs: nil)
            self.cancelIdleTimer()
            self.state = .speaking
            self.startPromptRenewal()
            self.promptSpeaker.speak(prompt.readout, language: self.settings.language) { [weak self] played in
                Task { @MainActor in await self?.promptReadoutFinished(played, presentation: presentation, callId: callId) }
            }
            self.announcementStatus = "Reading the question. Tap the microphone to interrupt."
        }
    }

    private func promptReadoutFinished(_ played: Bool, presentation: VoicePromptPresentation, callId: String) async {
        guard promptPresentation?.prompt.token == presentation.prompt.token, connectionGeneration.accepts(presentation.generation) else { return }
        guard played, !audioRoutes.blocksAudio, UIApplication.shared.applicationState == .active else {
            invalidatePromptPresentation()
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "The question was interrupted. Read it again before answering."]))
            return
        }
        let receipt = await promptRequest("voice_prompt_presented", presentation: presentation)
        // Keep capture gated briefly after native playback, including while awaiting
        // the receipt, so its last words cannot become the user's answer.
        try? await Task.sleep(for: .milliseconds(300))
        guard promptPresentation?.prompt.token == presentation.prompt.token, connectionGeneration.accepts(presentation.generation) else { return }
        readingPrompt = false
        state = .listening
        resetIdleTimer()
        guard receipt.success, let live = voiceClient as? LiveClient else {
            invalidatePromptPresentation()
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": receipt.error ?? "Presentation could not be verified."]))
            return
        }
        promptPresentation?.presented = true
        promptPresentation?.inputBoundaryMs = live.inputAudioMilliseconds
        announcementStatus = "Waiting for your answer."
        sendToolResult(callId: callId, output: Self.encodeArgs(["success": true, "status": "presented", "session_id": presentation.prompt.sessionId, "question_data": presentation.prompt.readout, "message": "The app has read the exact question aloud. Wait for the user's fresh spoken answer before calling answer_prompt."]))
    }

    func handleLiveAnswerPrompt(callId: String) {
        Task { [weak self] in
            guard let self, let initial = self.promptPresentation, initial.canAnswer(generation: self.connectionGeneration.value, now: Date()) else {
                self?.sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "Read the pending question first, then answer aloud." ]))
                return
            }
            // Use actual new input transcript data, never model-supplied answer text.
            // Wait for late qualification fragments before interpreting an approval.
            var revision = initial.inputRevision
            var stable = false
            for _ in 0..<4 {
                try? await Task.sleep(for: .seconds(1))
                guard self.toolResults.contains(callId), let current = self.promptPresentation,
                      current.prompt.token == initial.prompt.token, current.canAnswer(generation: self.connectionGeneration.value, now: Date()) else {
                    self.sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "The presentation changed or expired. Read the question again."]))
                    return
                }
                if current.inputRevision == revision { stable = true; break }
                revision = current.inputRevision
            }
            guard stable else {
                self.sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "Still receiving your answer. Please finish speaking."]))
                return
            }
            guard var current = self.promptPresentation, current.canAnswer(generation: self.connectionGeneration.value, now: Date()) else { return }
            current.submitting = true
            self.promptPresentation = current
            self.promptAnswerReceipt = current
            var result = await self.promptRequest("voice_prompt_answer", presentation: current, answer: current.answer.trimmingCharacters(in: .whitespacesAndNewlines))
            // Reconcile a lost reply without ever resending the mutation. Status is
            // bound to the original retained prompt token, including after expiry.
            if !result.success {
                let receipt = await self.promptRequest("voice_prompt_status", presentation: current)
                let status = self.parseArguments(receipt.result ?? "")["status"] as? String
                if receipt.success || (receipt.result != nil && status != "not_dispatched") { result = receipt }
            }
            guard self.toolResults.contains(callId) else { return }
            self.invalidatePromptPresentation()
            self.sendToolResult(callId: callId, output: Self.encodeArgs(["success": result.success, "result": result.result ?? "", "error": result.error ?? ""]))
        }
    }

    private func startPromptRenewal() {
        promptRenewal?.cancel()
        promptRenewal = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, let self, let current = self.promptPresentation, !current.submitting else { return }
                let result = await self.promptRequest("voice_prompt_prepare", presentation: current)
                guard self.promptPresentation?.prompt.token == current.prompt.token else { return }
                guard result.success, let text = result.result, let renewed = try? JSONDecoder().decode(PreparedVoicePrompt.self, from: Data(text.utf8)),
                      renewed.token == current.prompt.token, renewed.version == current.prompt.version, renewed.claimToken == current.prompt.claimToken else {
                    self.invalidatePromptPresentation()
                    self.announcementStatus = "The question changed or expired. Read it again."
                    return
                }
                self.promptPresentation?.deadline = Date().addingTimeInterval(Double(renewed.ttlMs) / 1000 - 1)
            }
        }
    }

    func handlePromptAnswerStatus(callId: String) {
        guard let receipt = promptAnswerReceipt else {
            sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": "No spoken answer was submitted in this conversation."]))
            return
        }
        Task { [weak self] in
            guard let self else { return }
            let result = await self.promptRequest("voice_prompt_status", presentation: receipt)
            self.sendToolResult(callId: callId, output: Self.encodeArgs(["success": result.success, "result": result.result ?? "", "error": result.error ?? ""]))
        }
    }
}
#endif
