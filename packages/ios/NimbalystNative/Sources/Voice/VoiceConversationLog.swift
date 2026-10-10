import Foundation

/// One line of a phone voice conversation, in the format desktop voice sessions
/// already store and render: `input` for the user, `output` for the agent,
/// `[system] ...` lines, and `voiceToolCall` JSON.
struct VoiceLogEntry: Codable, Equatable, Sendable {
    let entryId: String
    let direction: String
    let content: String
    let timestamp: Double
}

/// Outbox for one voice conversation's record on the desktop. An entry leaves
/// only when the desktop acknowledges it; the desktop dedupes by entry id, so a
/// batch whose reply was lost is simply sent again.
struct VoiceConversationLog {
    static let maxPending = 1000
    static let batchSize = 25
    static let maxContent = 8000

    let conversationId: String
    let hostDeviceId: String
    let projectId: String
    let linkedSessionId: String?
    private(set) var pending: [VoiceLogEntry] = []
    private(set) var dropped = 0
    private var loggedTranscripts: Set<String> = []
    private var toolNames: [String: String] = [:]
    private var sequence = 0

    init(conversationId: String = UUID().uuidString.lowercased(), hostDeviceId: String, projectId: String, linkedSessionId: String?) {
        self.conversationId = conversationId
        self.hostDeviceId = hostDeviceId
        self.projectId = projectId
        self.linkedSessionId = linkedSessionId
    }

    mutating func append(direction: String, content: String, entryId: String? = nil, now: Date = Date()) {
        let text = content.count > Self.maxContent ? String(content.prefix(Self.maxContent)) + " [truncated]" : content
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sequence += 1
        if pending.count >= Self.maxPending { pending.removeFirst(); dropped += 1 }
        pending.append(VoiceLogEntry(entryId: entryId ?? "phone-\(sequence)-\(UUID().uuidString)", direction: direction,
                                     content: text, timestamp: (now.timeIntervalSince1970 * 1000).rounded()))
    }

    mutating func system(_ message: String, now: Date = Date()) {
        append(direction: "output", content: "[system] " + message, now: now)
    }

    /// The next batch to send, led by a note if the outbox ever overflowed.
    mutating func nextBatch(now: Date = Date()) -> [VoiceLogEntry] {
        if dropped > 0 {
            let note = VoiceLogEntry(entryId: "phone-dropped-\(sequence)-\(dropped)", direction: "output",
                                     content: "[system] \(dropped) earlier lines were dropped while the desktop was unreachable.",
                                     timestamp: (now.timeIntervalSince1970 * 1000).rounded())
            pending.insert(note, at: 0)
            dropped = 0
        }
        return Array(pending.prefix(Self.batchSize))
    }

    mutating func acknowledge(_ ids: Set<String>) {
        pending.removeAll { ids.contains($0.entryId) }
    }

    /// Live splits speech into many small fragments, so record a turn -- a run of
    /// consecutive fragments from one speaker -- as one line, once it is done: the
    /// other speaker has taken over, it has gone quiet for 5s of audio, or the
    /// conversation is ending.
    mutating func recordTranscripts(_ fragments: [LiveTranscript], final: Bool, now: Date = Date()) {
        var turns: [[LiveTranscript]] = []
        for fragment in fragments {
            if let last = turns.last?.last, last.speaker == fragment.speaker { turns[turns.count - 1].append(fragment) }
            else { turns.append([fragment]) }
        }
        let latestEnd = fragments.map(\.endMs).max() ?? 0
        for (index, turn) in turns.enumerated() {
            guard let first = turn.first, !turn.contains(where: { loggedTranscripts.contains($0.id) }) else { continue }
            let quiet = latestEnd - (turn.last?.endMs ?? 0) > 5000
            guard final || index < turns.count - 1 || quiet else { continue }
            turn.forEach { loggedTranscripts.insert($0.id) }
            let text = turn.map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines)
            append(direction: first.speaker == "user" ? "input" : "output", content: text,
                   entryId: "transcript-\(first.id)", now: now)
        }
    }

    mutating func toolStarted(callId: String, name: String, arguments: String, now: Date = Date()) {
        toolNames[callId] = name
        let args = (try? JSONSerialization.jsonObject(with: Data(arguments.utf8))) as? [String: Any] ?? [:]
        append(direction: "output", content: Self.json(["kind": "voiceToolCall", "phase": "started", "callId": callId,
                                                        "name": name, "displayName": name, "args": args]),
               entryId: "tool-started-\(callId)", now: now)
    }

    mutating func toolCompleted(callId: String, output: String, now: Date = Date()) {
        let name = toolNames.removeValue(forKey: callId) ?? "app"
        let parsed = (try? JSONSerialization.jsonObject(with: Data(output.utf8))) as? [String: Any]
        let success = (parsed?["success"] as? Bool) != false
        append(direction: "output", content: Self.json(["kind": "voiceToolCall", "phase": "completed", "callId": callId,
                                                        "name": name, "displayName": name, "success": success,
                                                        "summary": String(output.prefix(4000))]),
               entryId: "tool-completed-\(callId)", now: now)
    }

    private static func json(_ value: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }
}
