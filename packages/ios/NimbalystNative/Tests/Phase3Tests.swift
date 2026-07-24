import XCTest
@testable import NimbalystNative
import GRDB

/// Tests for Phase 3: Transcript and input features.
/// Covers message observation, message content parsing, session room sync protocol,
/// and prompt sending.
final class Phase3Tests: XCTestCase {

    // MARK: - Helpers

    private func makeDB() throws -> DatabaseManager {
        let db = try DatabaseManager()
        let project = Project(id: "/path", name: "project")
        try db.upsertProject(project)
        return db
    }

    private func makeSession(db: DatabaseManager, id: String = "s1") throws -> Session {
        let session = Session(
            id: id, projectId: "/path",
            titleDecrypted: "Test Session",
            provider: "claude-code", model: "claude-opus-4-6", mode: "agent",
            createdAt: 1000, updatedAt: 2000
        )
        try db.upsertSession(session)
        return session
    }

    // MARK: - Message Observation

    @MainActor func testMessageObservationDetectsNewMessages() throws {
        let db = try makeDB()
        let session = try makeSession(db: db)

        let expectation = XCTestExpectation(description: "Observation fires on message insert")
        var observedCounts: [Int] = []

        let observation = ValueObservation.tracking { db in
            try Message
                .filter(Message.Columns.sessionId == session.id)
                .order(Message.Columns.sequence)
                .fetchAll(db)
        }

        let cancellable = observation.start(
            in: db.writer,
            onError: { _ in },
            onChange: { messages in
                observedCounts.append(messages.count)
                if observedCounts.count >= 2 {
                    expectation.fulfill()
                }
            }
        )

        // Insert a message after observation starts
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            let msg = Message(
                id: "m1", sessionId: session.id, sequence: 1,
                source: "user", direction: "input",
                encryptedContent: "enc", iv: "iv",
                contentDecrypted: "Hello",
                createdAt: 3000
            )
            try? db.appendMessage(msg)
        }

        wait(for: [expectation], timeout: 2.0)
        cancellable.cancel()

        XCTAssertEqual(observedCounts[0], 0)
        XCTAssertEqual(observedCounts.last, 1)
    }

    func testMessageObservationOrdersBySequence() throws {
        let db = try makeDB()
        let session = try makeSession(db: db)

        // Insert messages out of order
        let msg3 = Message(id: "m3", sessionId: session.id, sequence: 3,
                           source: "assistant", direction: "output",
                           encryptedContent: "e", iv: "i",
                           contentDecrypted: "Third", createdAt: 3000)
        let msg1 = Message(id: "m1", sessionId: session.id, sequence: 1,
                           source: "user", direction: "input",
                           encryptedContent: "e", iv: "i",
                           contentDecrypted: "First", createdAt: 1000)
        let msg2 = Message(id: "m2", sessionId: session.id, sequence: 2,
                           source: "assistant", direction: "output",
                           encryptedContent: "e", iv: "i",
                           contentDecrypted: "Second", createdAt: 2000)

        try db.appendMessages([msg3, msg1, msg2])

        let messages = try db.messages(forSession: session.id)
        XCTAssertEqual(messages.count, 3)
        XCTAssertEqual(messages[0].contentDecrypted, "First")
        XCTAssertEqual(messages[1].contentDecrypted, "Second")
        XCTAssertEqual(messages[2].contentDecrypted, "Third")
    }

    func testMessageObservationOnlyShowsSessionMessages() throws {
        let db = try makeDB()
        let s1 = try makeSession(db: db, id: "s1")
        _ = try makeSession(db: db, id: "s2")

        // Add messages to both sessions
        try db.appendMessage(Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "user", direction: "input",
            encryptedContent: "e", iv: "i",
            contentDecrypted: "Session 1 msg", createdAt: 1000
        ))
        try db.appendMessage(Message(
            id: "m2", sessionId: "s2", sequence: 1,
            source: "user", direction: "input",
            encryptedContent: "e", iv: "i",
            contentDecrypted: "Session 2 msg", createdAt: 1000
        ))

        let s1Messages = try db.messages(forSession: s1.id)
        XCTAssertEqual(s1Messages.count, 1)
        XCTAssertEqual(s1Messages[0].contentDecrypted, "Session 1 msg")
    }

    // MARK: - Message Content Parsing

    func testPlainTextContent() {
        let msg = Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "user", direction: "input",
            encryptedContent: "e", iv: "i",
            contentDecrypted: "Hello, world!",
            createdAt: 1000
        )

        // MessageBubbleView parses content - test the same logic
        let content = parseDisplayContent(msg.contentDecrypted)
        XCTAssertEqual(content, "Hello, world!")
    }

    func testJsonContentWithContentField() {
        let msg = Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "assistant", direction: "output",
            encryptedContent: "e", iv: "i",
            contentDecrypted: "{\"content\": \"Parsed from JSON\"}",
            createdAt: 1000
        )

        let content = parseDisplayContent(msg.contentDecrypted)
        XCTAssertEqual(content, "Parsed from JSON")
    }

    func testJsonContentWithPromptField() {
        let msg = Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "user", direction: "input",
            encryptedContent: "e", iv: "i",
            contentDecrypted: "{\"prompt\": \"User typed this\"}",
            createdAt: 1000
        )

        let content = parseDisplayContent(msg.contentDecrypted)
        XCTAssertEqual(content, "User typed this")
    }

    func testNilContentReturnsEmpty() {
        let content = parseDisplayContent(nil)
        XCTAssertEqual(content, "")
    }

    func testToolNameFromMetadata() {
        let msg = Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "tool", direction: "output",
            encryptedContent: "e", iv: "i",
            metadataJson: "{\"tool_name\": \"Read\"}",
            createdAt: 1000
        )

        let toolName = parseToolName(message: msg)
        XCTAssertEqual(toolName, "Read")
    }

    func testToolNameFromContentJson() {
        let msg = Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "tool", direction: "output",
            encryptedContent: "e", iv: "i",
            contentDecrypted: "{\"tool_name\": \"Write\", \"path\": \"test.swift\"}",
            createdAt: 1000
        )

        let toolName = parseToolName(message: msg)
        XCTAssertEqual(toolName, "Write")
    }

    // MARK: - Session Sync Protocol Types

    func testSessionSyncRequestEncoding() throws {
        let request = SessionSyncRequest(sinceSeq: 42)
        let data = try JSONEncoder().encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "syncRequest")
        XCTAssertEqual(json["sinceSeq"] as? Int, 42)
    }

    func testSessionSyncRequestEncodingNilSeq() throws {
        let request = SessionSyncRequest(sinceSeq: nil)
        let data = try JSONEncoder().encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "syncRequest")
        XCTAssertNil(json["sinceSeq"])
    }

    func testSessionSyncResponseDecoding() throws {
        let json = """
        {
            "type": "syncResponse",
            "messages": [
                {
                    "id": "msg-1",
                    "sequence": 1,
                    "createdAt": 1707820800000,
                    "source": "user",
                    "direction": "input",
                    "encryptedContent": "base64data",
                    "iv": "base64iv"
                }
            ],
            "hasMore": true,
            "cursor": "1"
        }
        """.data(using: .utf8)!

        let response = try JSONDecoder().decode(SessionSyncResponse.self, from: json)
        XCTAssertEqual(response.type, "syncResponse")
        XCTAssertEqual(response.messages.count, 1)
        XCTAssertEqual(response.messages[0].id, "msg-1")
        XCTAssertEqual(response.messages[0].sequence, 1)
        XCTAssertEqual(response.messages[0].source, "user")
        XCTAssertTrue(response.hasMore)
        XCTAssertEqual(response.cursor, "1")
    }

    func testMessageBroadcastDecoding() throws {
        let json = """
        {
            "type": "messageBroadcast",
            "message": {
                "id": "msg-2",
                "sequence": 5,
                "createdAt": 1707820900000,
                "source": "assistant",
                "direction": "output",
                "encryptedContent": "encdata",
                "iv": "ivdata"
            },
            "fromConnectionId": "conn-123"
        }
        """.data(using: .utf8)!

        let broadcast = try JSONDecoder().decode(MessageBroadcast.self, from: json)
        XCTAssertEqual(broadcast.type, "messageBroadcast")
        XCTAssertEqual(broadcast.message.id, "msg-2")
        XCTAssertEqual(broadcast.message.sequence, 5)
        XCTAssertEqual(broadcast.message.source, "assistant")
        XCTAssertEqual(broadcast.fromConnectionId, "conn-123")
    }

    func testMetadataBroadcastDecoding() throws {
        let json = """
        {
            "type": "metadataBroadcast",
            "metadata": {
                "isExecuting": false,
                "provider": "claude-code",
                "model": "claude-opus-4-6",
                "updatedAt": 1707821000000
            },
            "fromConnectionId": "conn-456"
        }
        """.data(using: .utf8)!

        let broadcast = try JSONDecoder().decode(MetadataBroadcast.self, from: json)
        XCTAssertEqual(broadcast.type, "metadataBroadcast")
        XCTAssertEqual(broadcast.metadata.isExecuting, false)
        XCTAssertEqual(broadcast.metadata.provider, "claude-code")
        XCTAssertEqual(broadcast.metadata.model, "claude-opus-4-6")
        XCTAssertEqual(broadcast.metadata.updatedAt, 1707821000000)
    }

    func testAppendMessageRequestEncoding() throws {
        let entry = ServerMessageEntry(
            id: "msg-new",
            sequence: 0,
            createdAt: 1707820800000,
            source: "user",
            direction: "input",
            encryptedContent: "encrypted",
            iv: "iv123",
            metadata: nil
        )
        let request = AppendMessageRequest(message: entry)
        let data = try JSONEncoder().encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "appendMessage")
        let message = json["message"] as! [String: Any]
        XCTAssertEqual(message["id"] as? String, "msg-new")
        XCTAssertEqual(message["source"] as? String, "user")
    }

    // MARK: - Next Sequence

    func testNextSequenceEmptySession() throws {
        let db = try makeDB()
        _ = try makeSession(db: db)

        let seq = try db.nextSequence(forSession: "s1")
        XCTAssertEqual(seq, 1, "Empty session should return sequence 1")
    }

    func testNextSequenceAfterExistingMessages() throws {
        let db = try makeDB()
        _ = try makeSession(db: db)

        // Add messages with sequences 1, 2, 3
        for i in 1...3 {
            try db.appendMessage(Message(
                id: "m\(i)", sessionId: "s1", sequence: i,
                source: "user", direction: "input",
                encryptedContent: "e", iv: "i",
                contentDecrypted: "msg \(i)", createdAt: 1000 + i
            ))
        }

        let seq = try db.nextSequence(forSession: "s1")
        XCTAssertEqual(seq, 4, "Should return max sequence + 1")
    }

    func testNextSequenceIsolatedBySessions() throws {
        let db = try makeDB()
        _ = try makeSession(db: db, id: "s1")
        _ = try makeSession(db: db, id: "s2")

        // Add 5 messages to s1
        for i in 1...5 {
            try db.appendMessage(Message(
                id: "s1-m\(i)", sessionId: "s1", sequence: i,
                source: "user", direction: "input",
                encryptedContent: "e", iv: "i",
                createdAt: 1000
            ))
        }

        // s2 should still return 1
        let seq = try db.nextSequence(forSession: "s2")
        XCTAssertEqual(seq, 1)
    }

    // MARK: - IndexUpdateMessage Encoding (queued prompts wire format)

    func testIndexUpdateMessageEncodingWithQueuedPrompts() throws {
        let prompt = EncryptedQueuedPrompt(
            id: "prompt-1",
            encryptedPrompt: "encrypted-text",
            iv: "prompt-iv",
            timestamp: 1707820800000,
            source: "keyboard"
        )

        let entry = IndexUpdateEntry(
            sessionId: "sess-1",
            encryptedProjectId: "enc-project",
            projectIdIv: CryptoManager.projectIdIvBase64,
            encryptedTitle: "enc-title",
            titleIv: "title-iv",
            provider: "claude-code",
            model: "claude-opus-4-6",
            mode: "agent",
            messageCount: 5,
            lastMessageAt: 1707820800000,
            createdAt: 1707000000000,
            updatedAt: 1707820800000,
            isExecuting: false,
            queuedPromptCount: 1,
            encryptedQueuedPrompts: [prompt]
        )

        let message = IndexUpdateMessage(session: entry)

        // Encode with default strategy - types use camelCase field names
        let data = try JSONEncoder().encode(message)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        // Top-level type
        XCTAssertEqual(json["type"] as? String, "indexUpdate")

        // Session entry uses camelCase keys (standard Codable encoding)
        let session = json["session"] as! [String: Any]
        XCTAssertEqual(session["sessionId"] as? String, "sess-1")
        XCTAssertEqual(session["encryptedProjectId"] as? String, "enc-project")
        XCTAssertEqual(session["projectIdIv"] as? String, CryptoManager.projectIdIvBase64)
        XCTAssertEqual(session["encryptedTitle"] as? String, "enc-title")
        XCTAssertEqual(session["messageCount"] as? Int, 5)
        XCTAssertEqual(session["createdAt"] as? Int, 1707000000000)
        XCTAssertEqual(session["provider"] as? String, "claude-code")

        // Queued prompts array
        let prompts = session["encryptedQueuedPrompts"] as? [[String: Any]]
        XCTAssertNotNil(prompts)
        XCTAssertEqual(prompts?.count, 1)

        let firstPrompt = prompts![0]
        XCTAssertEqual(firstPrompt["id"] as? String, "prompt-1")
        XCTAssertEqual(firstPrompt["encryptedPrompt"] as? String, "encrypted-text")
        XCTAssertEqual(firstPrompt["iv"] as? String, "prompt-iv")
        XCTAssertEqual(firstPrompt["timestamp"] as? Int, 1707820800000)
        XCTAssertEqual(firstPrompt["source"] as? String, "keyboard")
    }

    // MARK: - AppendMessageRequest Encoding (camelCase wire format)

    func testAppendMessageRequestEncodingFields() throws {
        let entry = ServerMessageEntry(
            id: "msg-new",
            sequence: 0,
            createdAt: 1707820800000,
            source: "user",
            direction: "input",
            encryptedContent: "encrypted-data",
            iv: "iv123",
            metadata: nil
        )
        let request = AppendMessageRequest(message: entry)

        let data = try JSONEncoder().encode(request)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]

        XCTAssertEqual(json["type"] as? String, "appendMessage")
        let message = json["message"] as! [String: Any]
        XCTAssertEqual(message["createdAt"] as? Int, 1707820800000)
        XCTAssertEqual(message["encryptedContent"] as? String, "encrypted-data")
        XCTAssertEqual(message["iv"] as? String, "iv123")
        XCTAssertEqual(message["source"] as? String, "user")
        XCTAssertEqual(message["direction"] as? String, "input")
    }

    // MARK: - Sync State Watermark

    func testSyncStateUpdatesAfterMessageSync() throws {
        let db = try makeDB()

        // No sync state initially
        let initial = try db.syncState(forRoom: "session-1")
        XCTAssertNil(initial)

        // Update sync state
        let state = SyncState(roomId: "session-1", lastCursor: nil, lastSequence: 42, lastSyncedAt: 1000)
        try db.updateSyncState(state)

        let fetched = try db.syncState(forRoom: "session-1")
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.lastSequence, 42)
    }

    // MARK: - Helpers (mirror MessageBubbleView logic)

    /// Mirrors the displayContent parsing from MessageBubbleView
    private func parseDisplayContent(_ raw: String?) -> String {
        guard let raw = raw, !raw.isEmpty else { return "" }

        if raw.hasPrefix("{"),
           let data = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let content = json["content"] as? String {
            return content
        }

        if raw.hasPrefix("{"),
           let data = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let prompt = json["prompt"] as? String {
            return prompt
        }

        return raw
    }

    /// Mirrors the toolName parsing from MessageBubbleView
    private func parseToolName(message: Message) -> String? {
        if let metaJson = message.metadataJson,
           let data = metaJson.data(using: .utf8),
           let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let name = meta["tool_name"] as? String {
            return name
        }

        if let raw = message.contentDecrypted, raw.hasPrefix("{"),
           let data = raw.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return json["tool_name"] as? String ?? json["name"] as? String
        }

        return nil
    }
}
