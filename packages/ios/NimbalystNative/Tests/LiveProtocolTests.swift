import XCTest
@testable import NimbalystNative

final class LiveProtocolTests: XCTestCase {
    private func started() -> LiveProtocolState {
        var state = LiveProtocolState()
        _ = state.receive(["type": "session.started", "event_id": "start", "session": ["id": "live_test", "model": "gpt-live-1"]])
        return state
    }
    private func nested(_ type: String, id: String = UUID().uuidString, delegation: String = "d1", response: String = "r1", item: [String: Any]? = nil) -> [String: Any] {
        var event: [String: Any] = ["type": type, "response": ["id": response]]
        if let item { event["item"] = item }
        return ["type": "response.event", "event_id": id, "delegation_id": delegation, "event": event]
    }
    private func call(_ id: String) -> [String: Any] {
        ["type": "function_call", "id": "item_" + id, "call_id": id, "name": "remember", "arguments": "{\"text\":\"x\"}"]
    }
    func testFastMultipleResultsWaitForWholeBatchAndReserveOnce() throws {
        var state = started()
        _ = state.receive(nested("response.created"))
        var tokens: [String] = []
        for id in ["a", "b"] {
            let effects = state.receive(nested("response.output_item.done", item: call(id)))
            guard case .call(let value) = effects.first else { return XCTFail("Missing tool") }
            tokens.append(value.token)
            XCTAssertTrue(state.accept(token: value.token, output: "accepted"))
            XCTAssertTrue(state.takeResults().isEmpty)
        }
        _ = state.receive(nested("response.completed"))
        let events = state.takeResults()
        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events.last?["type"] as? String, "response.create")
        XCTAssertTrue(state.takeResults().isEmpty)
        XCTAssertFalse(state.accept(token: tokens[0], output: "duplicate"))
        state.resultsSent()
        _ = state.receive(nested("response.created", response: "r2"))
        XCTAssertNil(state.fault)
    }
    func testOverlapAndIdentityConflictLatchFaultAndBlockOutputs() {
        var state = started()
        _ = state.receive(nested("response.created"))
        _ = state.receive(nested("response.created", delegation: "d2", response: "r2"))
        XCTAssertNotNil(state.fault)
        XCTAssertTrue(state.takeResults().isEmpty)
        XCTAssertFalse(state.accept(token: "anything", output: "x"))
    }
    func testDuplicateItemNeverExecutesAgainAndClosureRejectsLateResult() {
        var state = started()
        _ = state.receive(nested("response.created"))
        let event = nested("response.output_item.done", item: call("a"))
        guard case .call(let tool) = state.receive(event).first else { return XCTFail("Missing call") }
        XCTAssertTrue(state.receive(event).isEmpty)
        XCTAssertTrue(state.receive(nested("response.output_item.done", item: call("a"))).isEmpty)
        state.transportEnded()
        XCTAssertFalse(state.accept(token: tool.token, output: "late"))
        XCTAssertTrue(state.usage.finalizationMissing)
    }
    func testUsageIsCumulativeAndLateContiguousTranscriptsKeepIdentity() {
        var state = started()
        for seconds in [12, 12, 11, 20] {
            _ = state.receive(["type": "session.usage.updated", "event_id": UUID().uuidString, "usage": ["seconds": seconds]])
        }
        XCTAssertEqual(state.usage.seconds, 20)
        for (speaker, start, end, text) in [("input", 0, 10, "hel"), ("output", 0, 20, "hi"), ("input", 10, 30, "lo")] {
            _ = state.receive(["type": "session.\(speaker)_transcript.delta", "event_id": UUID().uuidString, "start_ms": start, "end_ms": end, "delta": text])
        }
        XCTAssertEqual(state.transcripts.count, 2)
        XCTAssertEqual(state.transcripts.first?.text, "hello")
        _ = state.receive(["type": "session.closed", "event_id": "closed", "usage": ["seconds": 21]])
        XCTAssertEqual(state.usage.seconds, 21)
        XCTAssertTrue(state.usage.finalized)
    }
    func testSharedDesktopDelegationFixtureUsesSameNativeContract() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let directory = root.appendingPathComponent("electron/src/main/services/voice/engine/live/__tests__/fixtures/live")
        func fixture(_ name: String) throws -> [[String: Any]] {
            try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent(name + ".json"))) as! [[String: Any]]
        }
        var state = LiveProtocolState()
        for event in try fixture("startup") where event["type"] as? String == "session.started" { _ = state.receive(event) }
        var calls: [LiveCall] = []
        for event in try fixture("delegated-tool-call") {
            for effect in state.receive(event) { if case .call(let call) = effect { calls.append(call) } }
        }
        XCTAssertNil(state.fault)
        XCTAssertEqual(calls.count, 1)
        let call = try XCTUnwrap(calls.first)
        XCTAssertEqual(call.name, "open_file")
        XCTAssertEqual(call.responseId, "resp_1")
        XCTAssertEqual(call.delegationId, "delegation_1")
        XCTAssertTrue(state.accept(token: call.token, output: "opened"))
        XCTAssertEqual(state.takeResults().count, 2)
        XCTAssertEqual(state.usage.backendInputTokens, 120)
        XCTAssertEqual(state.usage.backendOutputTokens, 30)
    }
    @MainActor
    func testDispatchCannotDeliverIntoReplacementConnection() {
        let results = VoiceToolResults()
        var delivered: [String] = []
        let old = results.register { delivered.append($0) }
        results.invalidate()
        let new = results.register { delivered.append($0) }
        results.finish(old, output: "stale")
        results.finish(new, output: "current")
        results.finish(new, output: "duplicate")
        XCTAssertEqual(delivered, ["current"])
        var generation = VoiceConnectionGeneration()
        let prior = generation.value
        _ = generation.replace()
        XCTAssertFalse(generation.accepts(prior))
    }
}
