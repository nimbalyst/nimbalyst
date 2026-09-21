#if os(iOS)
import Foundation

@MainActor
extension VoiceAgent {
    func setupAudioRouting() {
        audioRoutes.onWillChange = { [weak self] in self?.prepareForAudioRouteChange() }
        audioRoutes.onDidChange = { [weak self] in self?.finishAudioRouteChange() }
        audioRoutes.onSuspended = { [weak self] in self?.suspendForAudioRouteLoss() }
    }

    private func stopAudioForRouteChange() {
        invalidatePromptPresentation()
        cancelIdleTimer()
        cancelDeferredBargeInTimer()
        // Stop the callbacks before clearing their shared buffers. No fade tail
        // should follow the user onto a newly selected speaker.
        audioPipeline.stopCapture()
        audioPipeline.stopPlayback()
        voiceClient?.interruptPlayback(audioEndMs: bargeInPolicy.msSincePlaybackStarted())
        bargeInPolicy.notePlaybackStopped()
    }

    private func prepareForAudioRouteChange() {
        resumeAudioAfterRouteChange = audioPipeline.isRunning
            || (audioSessionReady && state != .idle && state != .disconnected)
        stopAudioForRouteChange()
    }

    private func finishAudioRouteChange() {
        let shouldResume = resumeAudioAfterRouteChange
        resumeAudioAfterRouteChange = false
        guard shouldResume, !audioRoutes.blocksAudio, state != .idle, state != .disconnected else { return }
        do {
            try audioPipeline.startCapture()
            state = .listening
            resetIdleTimer()
            processQueuedCompletions()
        } catch {
            audioRoutes.failRecovery(error)
        }
    }

    private func suspendForAudioRouteLoss() {
        guard state != .disconnected else { return }
        resumeAudioAfterRouteChange = false
        resumeAfterClose = false
        stopAudioForRouteChange()
        state = .idle
        if effectiveEngine == .live, !isClosing, voiceClient != nil {
            // Use the existing close-and-restore behavior, preserving the event
            // queue and already-submitted coding work while paid voice is idle.
            toolResults.invalidate()
            toolScopes.removeAll()
            isClosing = true
            voiceClient?.disconnect()
        }
    }

    func resumeSelectedAudioRoute() async -> Bool {
        guard state == .idle, !audioRoutes.isSwitching, !audioRoutes.isActivating else { return false }
        let epoch = connectionGeneration.value
        do {
            try await audioRoutes.resume()
            return connectionGeneration.accepts(epoch) && state == .idle
        } catch is CancellationError {
            return false
        } catch {
            guard connectionGeneration.accepts(epoch), state == .idle else { return false }
            audioRoutes.failRecovery(error)
            return false
        }
    }
}
#endif
