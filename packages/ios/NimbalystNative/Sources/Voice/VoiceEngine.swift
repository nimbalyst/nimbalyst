import Foundation

public enum VoiceEngineKind: String, Codable, Sendable {
    case realtime, live
}

/// Native media and tools use this boundary; Realtime VAD/turn controls stay in its adapter.
@MainActor
protocol VoiceEngine: AnyObject {
    var kind: VoiceEngineKind { get }
    var onConnected: (() -> Void)? { get set }
    var onSessionReady: (() -> Void)? { get set }
    var onDisconnected: (() -> Void)? { get set }
    var onAudioDelta: ((String) -> Void)? { get set }
    var onAudioDone: (() -> Void)? { get set }
    var onFunctionCall: ((String, String, String) -> Void)? { get set }
    var onFunctionResultSent: ((String) -> Void)? { get set }
    var onSpeechStarted: (() -> Void)? { get set }
    var onSpeechStopped: (() -> Void)? { get set }
    var onError: ((String, String) -> Void)? { get set }
    var onResponseCreated: (() -> Void)? { get set }
    var onResponseDone: (() -> Void)? { get set }
    func connect()
    func disconnect()
    func sendAudio(_ audio: String)
    func sendUserMessage(text: String)
    func updateContext(_ text: String)
    func sendFunctionCallResult(callId: String, output: String)
    func interruptPlayback(audioEndMs: Int?)
    func playbackChanged(active: Bool)
}

extension RealtimeClient: VoiceEngine {
    var kind: VoiceEngineKind { .realtime }
    func interruptPlayback(audioEndMs: Int?) {
        if let audioEndMs { truncatePlayedAudio(audioEndMs: audioEndMs) }
        cancelResponse()
        setServerResponsesGated(false)
    }
    func playbackChanged(active: Bool) { setServerResponsesGated(active) }
}

/// Permission and transport callbacks must belong to the activation that created them.
struct VoiceConnectionGeneration {
    private(set) var value = UUID()
    mutating func replace() -> UUID { value = UUID(); return value }
    func accepts(_ candidate: UUID) -> Bool { candidate == value }
}

/// A tool result is bound to one connection and one dispatch, never a mutable client pointer.
@MainActor
final class VoiceToolResults {
    private var pending: [String: (String) -> Void] = [:]
    func register(_ deliver: @escaping (String) -> Void) -> String {
        let id = UUID().uuidString
        pending[id] = deliver
        return id
    }
    func finish(_ id: String, output: String) { pending.removeValue(forKey: id)?(output) }
    func invalidate() { pending.removeAll() }
    func contains(_ id: String) -> Bool { pending[id] != nil }
}
