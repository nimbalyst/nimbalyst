import XCTest
@testable import NimbalystNative

final class VoiceConversationLogTests: XCTestCase {
    private func fragment(_ id: String, _ speaker: String, _ start: Double, _ end: Double, _ text: String) -> LiveTranscript {
        LiveTranscript(id: id, speaker: speaker, startMs: start, endMs: end, text: text)
    }

    func testEachSpeakersTurnIsRecordedOnceAsOneLine() {
        var log = VoiceConversationLog(hostDeviceId: "mac", projectId: "/p", linkedSessionId: "s")
        // Live delivers a sentence as many small, non-contiguous fragments.
        let asking = [fragment("u1", "user", 0, 300, " Can you"), fragment("u2", "user", 400, 700, " see the"), fragment("u3", "user", 800, 900, " question")]
        log.recordTranscripts(asking, final: false)
        XCTAssertTrue(log.pending.isEmpty, "the user's turn is not recorded while they are still talking")

        let reply = [fragment("a1", "assistant", 1000, 1500, " It is not"), fragment("a2", "assistant", 1600, 2000, " waiting.")]
        let next = fragment("u4", "user", 2100, 2400, " blue")
        log.recordTranscripts(asking + reply + [next], final: false)
        log.recordTranscripts(asking + reply + [next], final: false)
        XCTAssertEqual(log.pending.map(\.content), ["Can you see the question", "It is not waiting."])
        XCTAssertEqual(log.pending.map(\.direction), ["input", "output"])

        log.recordTranscripts(asking + reply + [next], final: true)
        XCTAssertEqual(log.pending.map(\.content), ["Can you see the question", "It is not waiting.", "blue"])
    }

    func testToolCallsUseTheDesktopVoiceToolCallShapeAndAcknowledgedEntriesLeave() throws {
        var log = VoiceConversationLog(hostDeviceId: "mac", projectId: "/p", linkedSessionId: nil)
        log.toolStarted(callId: "c1", name: "read_pending_prompt", arguments: "{\"session_id\":\"s\"}")
        log.toolCompleted(callId: "c1", output: "{\"success\":false,\"error\":\"This session is not waiting on a question.\"}")
        let started = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(log.pending[0].content.utf8)) as? [String: Any])
        let completed = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(log.pending[1].content.utf8)) as? [String: Any])
        XCTAssertEqual(started["kind"] as? String, "voiceToolCall")
        XCTAssertEqual(started["phase"] as? String, "started")
        XCTAssertEqual((started["args"] as? [String: Any])?["session_id"] as? String, "s")
        XCTAssertEqual(completed["name"] as? String, "read_pending_prompt")
        XCTAssertEqual(completed["success"] as? Bool, false)
        XCTAssertTrue((completed["summary"] as? String)?.contains("not waiting") == true)

        let batch = log.nextBatch()
        log.acknowledge([batch[0].entryId])
        XCTAssertEqual(log.pending.map(\.entryId), [batch[1].entryId], "an unacknowledged entry stays for the retry")
    }

    func testOverflowKeepsTheNewestLinesAndSaysWhatWasDropped() {
        var log = VoiceConversationLog(hostDeviceId: "mac", projectId: "/p", linkedSessionId: nil)
        for i in 0..<(VoiceConversationLog.maxPending + 3) { log.system("line \(i)") }
        let batch = log.nextBatch()
        XCTAssertEqual(batch.first?.content, "[system] 3 earlier lines were dropped while the desktop was unreachable.")
        XCTAssertEqual(batch[1].content, "[system] line 3")
        XCTAssertEqual(log.nextBatch().first?.entryId, batch.first?.entryId, "the note is sent once, and resent until acknowledged")
    }
}
