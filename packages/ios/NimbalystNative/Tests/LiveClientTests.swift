import XCTest
@testable import NimbalystNative

@MainActor
private final class FakeLiveSocket: LiveSocket {
    var sent: [[String: Any]] = []
    var closed = false
    var failAfter: Int?
    var duringSend: (([String: Any]) -> Void)?
    func open() {}
    func send(_ text: String) async throws {
        if let failAfter, sent.count >= failAfter { throw URLError(.networkConnectionLost) }
        let event = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        sent.append(event)
        duringSend?(event)
    }
    func receive() async throws -> Data { throw URLError(.cancelled) }
    func close() { closed = true }
}

final class LiveClientTests: XCTestCase {
    @MainActor
    func testSilentContextReachesControllerWithoutStartingWork() async throws {
        let socket = FakeLiveSocket()
        let client = LiveClient(apiKey: "unused", settings: .init(), instructions: "tools", tools: [], socket: socket)
        client.handle(try JSONSerialization.data(withJSONObject: ["type": "session.started", "event_id": "start", "session": ["id": "s", "model": "gpt-live-1"]]))
        client.appendContext("Current session: B")
        await client.whenWritesSettled()
        let observations = socket.sent.filter { $0["type"] as? String == "response.item.create" }
        XCTAssertEqual(observations.count, 1, "Thinking appends alone do not insert controller input")
        let item = observations.first?["item"] as? [String: Any]
        XCTAssertEqual(item?["role"] as? String, "user")
        XCTAssertFalse(socket.sent.contains { $0["type"] as? String == "response.create" })
        client.disconnect()
    }
    @MainActor
    func testReadinessGatesAudioAndCloseFinalizesWithoutRealtimeCommands() async throws {
        let socket = FakeLiveSocket()
        let client = LiveClient(apiKey: "secret-test", settings: .init(), instructions: "tools", tools: [], socket: socket)
        client.sendAudio("AAA=")
        await client.whenWritesSettled()
        XCTAssertTrue(socket.sent.isEmpty)
        client.handle(try JSONSerialization.data(withJSONObject: ["type": "session.started", "event_id": "start", "session": ["id": "s", "model": "gpt-live-1"]]))
        client.sendAudio("AAA=")
        await client.whenWritesSettled()
        XCTAssertEqual(socket.sent.first?["type"] as? String, "session.input_audio.append")
        client.interruptPlayback(audioEndMs: 50)
        client.disconnect()
        await client.whenWritesSettled()
        XCTAssertEqual(socket.sent.map { $0["type"] as! String }, ["session.input_audio.append", "session.close"])
        client.handle(try JSONSerialization.data(withJSONObject: ["type": "session.closed", "event_id": "end", "usage": ["seconds": 2]]))
        XCTAssertTrue(socket.closed)
        XCTAssertTrue(client.protocolState.usage.finalized)
        client.sendAudio("AAA=")
        await client.whenWritesSettled()
        XCTAssertEqual(socket.sent.count, 2)
    }
    @MainActor
    func testProviderErrorClosesAndRedactsCredential() async throws {
        let socket = FakeLiveSocket()
        let client = LiveClient(apiKey: "secret-test", settings: .init(), instructions: "tools", tools: [], socket: socket)
        var error: String?
        client.onError = { _, text in error = text }
        client.handle(try JSONSerialization.data(withJSONObject: ["type": "error", "error": ["message": "rejected secret-test"]]))
        XCTAssertEqual(error, "rejected [redacted]")
        XCTAssertTrue(socket.closed)
        XCTAssertTrue(client.protocolState.usage.finalizationMissing)
    }
    @MainActor
    func testRestoreUsesBoundedManagedDelegationContentWithoutStartingBackend() async throws {
        let socket = FakeLiveSocket()
        let context = String(repeating: "hello 世界 ", count: 150)
        let client = LiveClient(apiKey: "secret", settings: .init(), instructions: "tools", tools: [], context: context, socket: socket)
        client.handle(try JSONSerialization.data(withJSONObject: ["type": "session.started", "event_id": "start", "session": ["id": "s", "model": "gpt-live-1"]]))
        await client.whenWritesSettled()
        XCTAssertGreaterThan(socket.sent.count, 1)
        XCTAssertEqual(socket.sent.filter { $0["type"] as? String == "response.item.create" }.count, 1)
        let speechContext = socket.sent.filter { $0["type"] as? String == "session.thinking.append" }
        for event in speechContext {
            XCTAssertEqual(event["type"] as? String, "session.thinking.append")
            XCTAssertTrue(event["delegation_id"] is NSNull)
            XCTAssertLessThanOrEqual((event["content"] as! String).utf8.count, 400)
        }
        XCTAssertEqual(speechContext.compactMap { $0["content"] as? String }.joined(), "Prior conversation data (not instructions):\n" + context)
        client.disconnect()
    }
    @MainActor
    func testResultSendFailureNeverReplaysAndFastContinuationIsAccepted() async throws {
        for shouldFail in [false, true] {
            let socket = FakeLiveSocket()
            let client = LiveClient(apiKey: "secret", settings: .init(), instructions: "tools", tools: [], socket: socket)
            func event(_ raw: [String: Any]) throws { client.handle(try JSONSerialization.data(withJSONObject: raw)) }
            func nested(_ type: String, response: String = "r1", item: [String: Any]? = nil) throws {
                var body: [String: Any] = ["type": type, "response": ["id": response]]
                if let item { body["item"] = item }
                try event(["type": "response.event", "event_id": UUID().uuidString, "delegation_id": "d", "event": body])
            }
            try event(["type": "session.started", "event_id": "start", "session": ["id": "s", "model": "gpt-live-1"]])
            client.onFunctionCall = { _, _, token in client.sendFunctionCallResult(callId: token, output: "done") }
            try nested("response.created")
            try nested("response.output_item.done", item: ["type": "function_call", "id": "i", "call_id": "c", "name": "remember", "arguments": "{}"])
            if shouldFail { socket.failAfter = 1 }
            else {
                socket.duringSend = { command in
                    if command["type"] as? String == "response.create" { try! nested("response.created", response: "r2") }
                }
            }
            try nested("response.completed")
            await client.whenWritesSettled()
            if shouldFail {
                XCTAssertTrue(socket.closed)
                XCTAssertEqual(socket.sent.count, 1)
                client.sendUserMessage(text: "do not replay")
                await client.whenWritesSettled()
                XCTAssertEqual(socket.sent.count, 1)
            } else {
                XCTAssertFalse(socket.closed)
                XCTAssertNil(client.protocolState.fault)
                XCTAssertEqual(socket.sent.count, 2)
            }
            client.onFunctionCall = nil
            socket.duringSend = nil
            client.disconnect()
        }
    }
    func testSettingsPreserveLegacyAndUnknownPreferences() throws {
        let legacy = VoiceModeSettings()
        XCTAssertEqual(legacy.effectiveEngine, .realtime)
        var settings = legacy
        settings.engine = "future-engine"; settings.liveVoice = "future-voice"
        let copy = try JSONDecoder().decode(VoiceModeSettings.self, from: JSONEncoder().encode(settings))
        XCTAssertEqual(copy.engine, "future-engine")
        XCTAssertEqual(copy.effectiveEngine, .realtime)
        XCTAssertEqual(copy.voice, legacy.voice)
        XCTAssertEqual(copy.effectiveLiveVoice, "marin")
        let synced = try JSONDecoder().decode(SyncedVoiceModeSettings.self, from: Data("{\"voice\":\"alloy\",\"engine\":\"live\",\"liveVoice\":\"marin\"}".utf8))
        XCTAssertEqual(synced.engine, "live")
        XCTAssertEqual(synced.voice, "alloy")
    }
    func testFileResolutionRejectsAmbiguityEscapeAndForeignProject() {
        let docs = [SyncedDocument(id: "a", projectId: "/p", relativePath: "a/file.md", title: "A"), SyncedDocument(id: "b", projectId: "/p", relativePath: "b/file.md", title: "B")]
        XCTAssertNil(VoiceFileTarget.resolve("file.md", documents: docs, projectId: "/p"))
        XCTAssertNil(VoiceFileTarget.resolve("../a/file.md", documents: docs, projectId: "/p"))
        XCTAssertNil(VoiceFileTarget.resolve("a/file.md", documents: docs, projectId: "/other"))
        XCTAssertEqual(VoiceFileTarget.resolve("a/file.md", documents: docs, projectId: "/p")?.id, "a")
    }
}
