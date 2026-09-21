import Foundation

struct PreparedVoicePrompt: Codable, Equatable {
    let promptId: String
    let sessionId: String
    let version: String
    let token: String
    let claimToken: String
    let readout: String
    let ttlMs: Int
}

/// Source identity survives screen changes; incomplete playback never arms an answer.
struct VoicePromptPresentation {
    let prompt: PreparedVoicePrompt
    let generation: UUID
    let projectId: String
    let hostId: String
    var deadline: Date
    var presented = false
    var inputBoundaryMs: Double = .infinity
    var answer = ""
    var inputRevision = 0
    var submitting = false

    mutating func recordInput(_ text: String, startMs: Double) {
        guard presented, !submitting, startMs >= inputBoundaryMs else { return }
        answer += text
        inputRevision += 1
    }
    func canAnswer(generation: UUID, now: Date) -> Bool {
        presented && !submitting && self.generation == generation && deadline > now && !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

#if os(iOS)
import AVFoundation

@MainActor
protocol VoicePromptSpeaker: AnyObject {
    func speak(_ text: String, language: String?, completion: @escaping (Bool) -> Void)
    func stop()
}

/// Native speech has a bounded utterance and an actual didFinish boundary. Live
/// audio/transcript deltas do not have a turn-done event and cannot grant this receipt.
@MainActor
final class NativeVoicePromptSpeaker: NSObject, VoicePromptSpeaker, @preconcurrency AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var utterance: AVSpeechUtterance?
    private var completion: ((Bool) -> Void)?
    override init() { super.init(); synthesizer.delegate = self; synthesizer.usesApplicationAudioSession = true }
    func speak(_ text: String, language: String?, completion: @escaping (Bool) -> Void) {
        stop()
        let utterance = AVSpeechUtterance(string: text)
        let code = language == "English" ? "en-US" : language
        utterance.voice = AVSpeechSynthesisVoice(language: code)
        self.utterance = utterance
        self.completion = completion
        synthesizer.speak(utterance)
    }
    func stop() {
        completion = nil
        utterance = nil
        synthesizer.stopSpeaking(at: .immediate)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { finish(utterance, played: true) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { finish(utterance, played: false) }
    private func finish(_ utterance: AVSpeechUtterance, played: Bool) {
        guard self.utterance === utterance else { return }
        let completion = self.completion
        self.completion = nil; self.utterance = nil
        completion?(played)
    }
}
#endif
