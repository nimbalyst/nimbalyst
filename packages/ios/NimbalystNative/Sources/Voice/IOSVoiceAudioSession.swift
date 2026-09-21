#if os(iOS)
@preconcurrency import AVFoundation

/// AVAudioSession stays behind this adapter so routing policy can be tested
/// without opening a real microphone or starting a paid voice connection.
@MainActor
final class IOSVoiceAudioSession: VoiceAudioSession {
    private let session = AVAudioSession.sharedInstance()
    private let observers = AudioSessionObservers()
    private let workQueue = DispatchQueue(label: "com.nimbalyst.voice.audio-session", qos: .userInitiated)

    var route: VoiceAudioRoute {
        VoiceAudioRoute(
            inputs: session.currentRoute.inputs.map(Self.port),
            outputs: session.currentRoute.outputs.map(Self.port),
            availableInputs: (session.availableInputs ?? []).map(Self.port),
            preferredInputID: session.preferredInput?.uid,
            sampleRate: session.sampleRate,
            bufferDuration: session.ioBufferDuration,
            inputChannels: session.inputNumberOfChannels,
            outputChannels: session.outputNumberOfChannels
        )
    }

    func activate() async throws {
        let session = session
        try await performSessionWork {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            try session.setPreferredSampleRate(48000)
            try session.setPreferredIOBufferDuration(0.02)
            try session.setActive(true)
            // Preserve the pipeline's existing optional input-gain boost.
            if session.isInputGainSettable { try? session.setInputGain(1.0) }
        }
    }

    func deactivate() async throws {
        let session = session
        try await performSessionWork {
            // Explicit preferences belong to this conversation, not the next one.
            var failure: Error?
            do {
                try session.overrideOutputAudioPort(.none)
                try session.setPreferredInput(nil)
            } catch { failure = error }
            do { try session.setActive(false, options: .notifyOthersOnDeactivation) }
            catch { if failure == nil { failure = error } }
            if let failure { throw failure }
        }
    }

    /// setActive may block on audio hardware. Keep it off the main actor on all
    /// supported versions, including iOS 18 which lacks async activation APIs.
    func performSessionWork(_ operation: @escaping @Sendable () throws -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            workQueue.async {
                do {
                    try operation()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func preferInput(id: String?) throws {
        guard let id else { try session.setPreferredInput(nil); return }
        guard let input = session.availableInputs?.first(where: { $0.uid == id }) else {
            throw AudioRouteController.RouteError.unavailable
        }
        try session.setPreferredInput(input)
    }

    func overrideSpeaker(_ enabled: Bool) throws {
        try session.overrideOutputAudioPort(enabled ? .speaker : .none)
    }

    func observe(_ handler: @escaping @MainActor (VoiceAudioSessionEvent) -> Void) {
        stopObserving()
        let center = NotificationCenter.default
        observers.tokens.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: .main) { notification in
            let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            let previous = notification.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            let removed = reason == .oldDeviceUnavailable ? (previous?.outputs.map(Self.port) ?? []) : []
            Task { @MainActor in handler(.routeChanged(removedOutputs: removed)) }
        })
        observers.tokens.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { notification in
            let type = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            Task { @MainActor in
                if type == AVAudioSession.InterruptionType.began.rawValue { handler(.interruptionBegan) }
                else if type == AVAudioSession.InterruptionType.ended.rawValue { handler(.interruptionEnded) }
            }
        })
        observers.tokens.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main) { _ in
            Task { @MainActor in handler(.mediaServicesReset) }
        })
        observers.tokens.append(center.addObserver(forName: AVAudioSession.mediaServicesWereLostNotification, object: session, queue: .main) { _ in
            Task { @MainActor in handler(.mediaServicesLost) }
        })
    }

    func stopObserving() {
        observers.removeAll()
    }

    nonisolated private static func port(_ port: AVAudioSessionPortDescription) -> VoiceAudioPort {
        let kind: VoiceAudioPort.Kind
        switch port.portType {
        case .builtInMic: kind = .microphone
        case .builtInSpeaker: kind = .speaker
        case .builtInReceiver: kind = .receiver
        case .headphones, .headsetMic, .usbAudio: kind = .headphones
        case .bluetoothHFP, .bluetoothA2DP, .bluetoothLE: kind = .bluetooth
        default: kind = .other
        }
        return VoiceAudioPort(id: port.uid, name: port.portName, kind: kind)
    }
}

/// Tokens are released even if the owning voice agent disappears without an
/// explicit cancellation. NotificationCenter removal is thread-safe.
private final class AudioSessionObservers {
    var tokens: [NSObjectProtocol] = []
    func removeAll() {
        for token in tokens { NotificationCenter.default.removeObserver(token) }
        tokens.removeAll()
    }
    deinit { removeAll() }
}
#endif
