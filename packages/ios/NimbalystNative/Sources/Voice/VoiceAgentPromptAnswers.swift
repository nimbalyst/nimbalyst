#if os(iOS)
import Foundation
import UIKit

@MainActor
extension VoiceAgent {
    func invalidatePromptPresentation() {
        promptPresentation = nil
        promptRenewal?.cancel()
        promptRenewal = nil
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
            self.startPromptRenewal()
            // The voice agent itself reads the question, in its own voice, and can be
            // interrupted like anything else it says. The answer is still taken only from
            // the user's own speech after this point, never from text the model supplies.
            let receipt = await self.promptRequest("voice_prompt_presented", presentation: presentation)
            guard self.toolResults.contains(callId), self.promptPresentation?.prompt.token == prompt.token else { return }
            guard receipt.success, let live = self.voiceClient as? LiveClient else {
                self.invalidatePromptPresentation()
                self.sendToolResult(callId: callId, output: Self.encodeArgs(["success": false, "error": receipt.error ?? "Presentation could not be verified."]))
                return
            }
            self.promptPresentation?.presented = true
            self.promptPresentation?.inputBoundaryMs = live.inputAudioMilliseconds
            self.announcementStatus = "Waiting for your answer."
            self.sendToolResult(callId: callId, output: Self.encodeArgs([
                "success": true, "status": "presented", "session_id": prompt.sessionId, "question_data": prompt.readout,
                "message": "Read question_data to the user now, in full and without adding options. Then wait for their spoken answer and call answer_prompt.",
            ]))
        }
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
