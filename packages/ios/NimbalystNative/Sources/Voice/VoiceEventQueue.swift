import Foundation

struct VoiceSourceEvent: Codable, Equatable, Identifiable, Sendable {
    var id: String { eventId }
    let eventId: String
    let kind: String
    let sessionId: String
    let hostDeviceId: String
    let projectId: String
    let taskId: String
    let revision: Int
    let promptId: String?
    let label: String
    let summary: String
}

struct VoiceEventQueue {
    private(set) var events: [VoiceSourceEvent] = []
    private var presented = Set<String>()
    mutating func enqueue(_ event: VoiceSourceEvent) {
        guard !presented.contains(event.id) else { return }
        events.removeAll { $0.id == event.id || ($0.kind == "completion" && event.kind == "completion" && $0.sessionId == event.sessionId) }
        events.append(event)
        events.sort { $0.kind == "question" && $1.kind != "question" }
        if events.count > 50 { events.removeLast(events.count - 50) }
    }
    mutating func markPresented(_ id: String) { presented.insert(id); events.removeAll { $0.id == id } }
    mutating func discard(_ id: String) { events.removeAll { $0.id == id } }
}
