import XCTest
@testable import NimbalystNative

final class VoiceEventQueueTests: XCTestCase {
    func testQuestionsLeadCoalescedCompletionsAndReplaysStayPresented() {
        func event(_ id: String, _ kind: String, session: String = "s") -> VoiceSourceEvent {
            .init(eventId: id, kind: kind, sessionId: session, hostDeviceId: "host", projectId: "/project", taskId: "task", revision: 1, promptId: kind == "question" ? id : nil, label: "Session", summary: "result")
        }
        var queue = VoiceEventQueue()
        queue.enqueue(event("old", "completion"))
        queue.enqueue(event("new", "completion"))
        queue.enqueue(event("q1", "question", session: "other"))
        queue.enqueue(event("q2", "question", session: "third"))
        XCTAssertEqual(queue.events.map(\.id), ["q1", "q2", "new"])
        queue.markPresented("q1")
        queue.enqueue(event("q1", "question", session: "other"))
        XCTAssertEqual(queue.events.map(\.id), ["q2", "new"])
    }
}
extension VoiceEventQueueTests {
    func testOnlyCompletePresentationAndNewInputCanAnswerAcrossScreenChanges() {
        let epoch = UUID()
        let prompt = PreparedVoicePrompt(promptId: "p", sessionId: "a", version: "v", token: "token", claimToken: "claim", readout: "Commit?", ttlMs: 30000)
        var presentation = VoicePromptPresentation(prompt: prompt, generation: epoch, projectId: "/p", hostId: "host", deadline: Date().addingTimeInterval(30))
        presentation.recordInput("yes", startMs: 10)
        XCTAssertFalse(presentation.canAnswer(generation: epoch, now: Date()))
        presentation.presented = true
        presentation.inputBoundaryMs = 100
        presentation.recordInput("approve", startMs: 99)
        XCTAssertFalse(presentation.canAnswer(generation: epoch, now: Date()))
        presentation.recordInput("yes", startMs: 101)
        presentation.recordInput(", but don't commit", startMs: 110)
        XCTAssertEqual(presentation.answer, "yes, but don't commit")
        XCTAssertEqual(presentation.prompt.sessionId, "a")
        XCTAssertTrue(presentation.canAnswer(generation: epoch, now: Date()))
        XCTAssertFalse(presentation.canAnswer(generation: UUID(), now: Date()))
        XCTAssertFalse(presentation.canAnswer(generation: epoch, now: Date().addingTimeInterval(31)))
        presentation.submitting = true
        XCTAssertFalse(presentation.canAnswer(generation: epoch, now: Date()))
    }
}
