#if os(iOS)
import Foundation
import UIKit

@MainActor
extension VoiceAgent {
    // MARK: - Realtime Client Callbacks

    func setupClientCallbacks(_ client: any VoiceEngine, epoch: UUID) {
        client.onConnected = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch) else { return }
            self.logger.info("Realtime connected, waiting for session config...")
        }

        client.onSessionReady = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch) else { return }
            self.audioSessionReady = true
            self.voiceClient?.updateContext(self.screenContextJSON())
            guard !self.audioRoutes.blocksAudio, self.state != .idle else { return }
            self.logger.info("Session configured, starting capture")
            do {
                try self.audioPipeline.startCapture()
                self.state = .listening
                self.isRestoring = false
                self.resetIdleTimer()
                self.processQueuedCompletions()
                self.startVoiceEvents()
                self.deliverClaimedVoiceEvent()
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
            guard let self, self.connectionGeneration.accepts(epoch) else { return }
            // Live's onClosed handler retains the armed queue and exposes Resume.
            if self.effectiveEngine == .live { return }
            if self.state != .disconnected {
                self.logger.warning("Realtime connection lost unexpectedly")
                self.deactivate()
            }
        }

        client.onAudioDelta = { [weak self] base64Audio in
            guard let self, self.connectionGeneration.accepts(epoch), !self.audioRoutes.blocksAudio, self.state != .idle, self.state != .disconnected else { return }
            guard !self.readingPrompt else { return }
            if self.state != .speaking {
                self.state = .speaking
                self.cancelIdleTimer()
            }
            if let announcement = self.announcement {
                guard announcement.deadline > Date() else { self.audioPipeline.stopPlayback(); return }
            }
            self.bargeInPolicy.notePlaybackStarted()
            // While the agent's audio is audibly playing, gate server VAD
            // responses so residual echo can't make the server cancel or
            // answer its own voice (NIM-1314); the client keeps barge-in
            // control. No-ops after the first chunk of a turn.
            self.voiceClient?.playbackChanged(active: true)
            self.audioPipeline.enqueuePlayback(base64Audio: base64Audio)
            if self.effectiveEngine == .live { self.audioPipeline.markEndOfPlayback() }
        }

        client.onAudioDone = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch), !self.audioRoutes.blocksAudio, self.state != .idle, self.state != .disconnected else { return }
            self.audioPipeline.markEndOfPlayback()
        }

        audioPipeline.onAudioCaptured = { [weak self] base64Audio in
            guard let self, self.connectionGeneration.accepts(epoch), self.state != .idle, self.state != .disconnected, !self.audioRoutes.blocksAudio else { return }
            guard !self.readingPrompt else { return }
            self.voiceClient?.sendAudio(base64Audio)
        }

        audioPipeline.onPlaybackFinished = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch), !self.audioRoutes.blocksAudio, self.state != .idle, self.state != .disconnected else { return }
            guard self.state != .idle, self.state != .disconnected else { return }
            guard !self.readingPrompt else { return }
            self.bargeInPolicy.notePlaybackStopped()
            self.voiceClient?.playbackChanged(active: false)
            self.state = .listening
            self.resetIdleTimer()
            self.processQueuedCompletions()
            Task { [weak self] in await self?.presentNextVoiceEvent() }
        }

        client.onResponseCreated = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch), !self.audioRoutes.blocksAudio, self.state != .idle, self.state != .disconnected else { return }
            if self.state == .listening {
                self.state = .processing
                self.cancelIdleTimer()
            }
        }

        client.onResponseDone = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch), !self.audioRoutes.blocksAudio, self.state != .idle, self.state != .disconnected else { return }
            // If no audio was produced (text-only or tool-only response), go back to listening
            if self.state == .processing {
                self.state = .listening
                self.resetIdleTimer()
            }
        }

        client.onSpeechStarted = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch), !self.audioRoutes.blocksAudio, self.state != .idle, self.state != .disconnected else { return }
            // Server VAD fired. Route the barge-in decision through the policy
            // seam: it classifies echo-suspect (agent audio still audibly
            // playing -- residual echo can trip VAD on speakerphone, NIM-1314)
            // vs genuine. Genuine triggers interrupt now; echo-suspect ones get
            // a probation window (min-duration heuristic) resolved by a timer.
            // The local hasActiveResponse flag races the server (audio streams
            // faster than realtime, so playback often outlives response.done),
            // which is why the audible-playback signal is used instead, and
            // cancelResponse() suppresses the benign "no active response".
            let playbackActive = self.audioPipeline.isAudiblyPlaying
            let decision = self.bargeInPolicy.onSpeechStarted(playbackActive: playbackActive)
            let m = self.bargeInPolicy.metrics
            self.logger.info("[barge-in] speech_started echoSuspect=\(decision.echoSuspect) msSincePlayback=\(decision.msSincePlaybackStarted.map(String.init) ?? "n/a") interrupt=\(decision.shouldInterrupt) deferMs=\(decision.deferInterruptMs.map(String.init) ?? "n/a") totals=\(m.echoSuspectCount)/\(m.genuineCount) (echo/genuine)")
            if decision.shouldInterrupt {
                self.performBargeInInterrupt(msSincePlaybackStarted: decision.msSincePlaybackStarted)
            } else if let deferMs = decision.deferInterruptMs {
                self.scheduleDeferredBargeIn(afterMs: deferMs)
            }
            self.cancelIdleTimer()
        }

        client.onSpeechStopped = { [weak self] in
            guard let self, self.connectionGeneration.accepts(epoch), !self.audioRoutes.blocksAudio, self.state != .idle, self.state != .disconnected else { return }
            if let ms = self.bargeInPolicy.onSpeechStopped() {
                self.logger.info("[barge-in] speech_stopped durationMs=\(ms)")
            }
            self.state = .processing
        }

        client.onFunctionCall = { [weak self, weak client] name, arguments, callId in
            guard let self, self.connectionGeneration.accepts(epoch) else { return }
            // Light up the floating-mic tool indicator for the duration of the call.
            let dispatchId = self.toolResults.register { [weak self, weak client] output in
                guard let self, self.connectionGeneration.accepts(epoch) else { return }
                client?.sendFunctionCallResult(callId: callId, output: output)
            }
            let args = self.parseArguments(arguments)
            let targetSession = args["session_id"] as? String ?? self.activeSessionId
            if let project = self.resolveProjectId(), let host = self.selectedHostDeviceId ?? targetSession.flatMap({ try? self.database?.session(byId: $0)?.hostDeviceId }) {
                self.toolScopes[dispatchId] = VoiceRelayScope(version: 1, hostDeviceId: host, projectId: project, sessionId: targetSession,
                    voiceGeneration: epoch.uuidString, actionId: dispatchId, announcingDeviceId: WebSocketClient.deviceId)
            }
            self.currentToolCall = ActiveToolCall(name: name, callId: callId)
            self.handleToolCall(name: name, arguments: arguments, callId: dispatchId)
        }

        client.onFunctionResultSent = { [weak self] callId in
            guard let self, self.connectionGeneration.accepts(epoch) else { return }
            // Clear the indicator only for the call that just finished, so a
            // newer in-flight tool call isn't dismissed by an older one's result.
            if self.currentToolCall?.callId == callId {
                self.currentToolCall = nil
            }
        }

        client.onError = { [weak self] type, message in
            guard let self, self.connectionGeneration.accepts(epoch) else { return }
            self.connectionError = message
            self.logger.error("Voice error [\(type)]: \(message)")
        }
    }

}
#endif
