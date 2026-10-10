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

/// Source identity survives screen changes; only the user's speech after presentation becomes the answer.
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

