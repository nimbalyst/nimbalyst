import XCTest
@testable import NimbalystNative
import GRDB

final class UnreadStateTests: XCTestCase {

    // MARK: - hasUnread Computed Property

    func testHasUnreadWhenNoLastReadAt() {
        let session = Session(
            id: "s1", projectId: "p1",
            lastReadAt: nil, lastMessageAt: 1000
        )
        XCTAssertTrue(session.hasUnread, "Session with messages but no lastReadAt should be unread")
    }

    func testHasUnreadWhenMessageAfterRead() {
        let session = Session(
            id: "s1", projectId: "p1",
            lastReadAt: 1000, lastMessageAt: 2000
        )
        XCTAssertTrue(session.hasUnread, "Session with message after read should be unread")
    }

    func testNotUnreadWhenReadAfterMessage() {
        let session = Session(
            id: "s1", projectId: "p1",
            lastReadAt: 2000, lastMessageAt: 1000
        )
        XCTAssertFalse(session.hasUnread, "Session read after last message should not be unread")
    }

    func testNotUnreadWhenReadAtSameTimeAsMessage() {
        let session = Session(
            id: "s1", projectId: "p1",
            lastReadAt: 1000, lastMessageAt: 1000
        )
        XCTAssertFalse(session.hasUnread, "Session read at same time as message should not be unread")
    }

    func testNotUnreadWhenNoMessages() {
        let session = Session(
            id: "s1", projectId: "p1",
            lastReadAt: nil, lastMessageAt: nil
        )
        XCTAssertFalse(session.hasUnread, "Session with no messages should not be unread")
    }

    func testNotUnreadWhenLastMessageAtIsZero() {
        let session = Session(
            id: "s1", projectId: "p1",
            lastReadAt: nil, lastMessageAt: 0
        )
        XCTAssertFalse(session.hasUnread, "Session with lastMessageAt=0 should not be unread")
    }

    // MARK: - Database Persistence

    func testMarkSessionReadUpdatesDatabase() throws {
        let db = try DatabaseManager()

        // Create project and session
        try db.upsertProject(Project(id: "p1", name: "Project"))
        let session = Session(
            id: "s1", projectId: "p1",
            createdAt: 1000, updatedAt: 1000,
            lastReadAt: nil, lastMessageAt: 5000
        )
        try db.upsertSession(session)

        // Verify initially unread
        let before = try db.session(byId: "s1")!
        XCTAssertTrue(before.hasUnread)

        // Mark as read
        try db.markSessionRead("s1")

        // Verify now read
        let after = try db.session(byId: "s1")!
        XCTAssertFalse(after.hasUnread)
        XCTAssertNotNil(after.lastReadAt)
        XCTAssertGreaterThan(after.lastReadAt!, 0)
    }

    func testSessionRoundtripWithReadState() throws {
        let db = try DatabaseManager()

        try db.upsertProject(Project(id: "p1", name: "Project"))
        let session = Session(
            id: "s1", projectId: "p1",
            createdAt: 1000, updatedAt: 1000,
            lastReadAt: 3000, lastMessageAt: 5000
        )
        try db.upsertSession(session)

        let fetched = try db.session(byId: "s1")!
        XCTAssertEqual(fetched.lastReadAt, 3000)
        XCTAssertEqual(fetched.lastMessageAt, 5000)
        XCTAssertTrue(fetched.hasUnread)
    }

    // MARK: - Protocol Decoding

    func testServerSessionEntryDecodesLastReadAt() throws {
        let json = """
        {
            "sessionId": "s1",
            "encryptedProjectId": "abc",
            "projectIdIv": "def",
            "provider": "claude-code",
            "messageCount": 10,
            "lastMessageAt": 5000,
            "createdAt": 1000,
            "updatedAt": 2000,
            "lastReadAt": 3000
        }
        """

        let data = json.data(using: .utf8)!
        let entry = try JSONDecoder().decode(ServerSessionEntry.self, from: data)
        XCTAssertEqual(entry.lastReadAt, 3000)
        XCTAssertEqual(entry.lastMessageAt, 5000)
    }

    func testServerSessionEntryDecodesWithoutLastReadAt() throws {
        let json = """
        {
            "sessionId": "s1",
            "encryptedProjectId": "abc",
            "projectIdIv": "def",
            "provider": "claude-code",
            "messageCount": 10,
            "lastMessageAt": 5000,
            "createdAt": 1000,
            "updatedAt": 2000
        }
        """

        let data = json.data(using: .utf8)!
        let entry = try JSONDecoder().decode(ServerSessionEntry.self, from: data)
        XCTAssertNil(entry.lastReadAt)
    }

    // MARK: - Migration

    func testV3MigrationAddsReadStateColumns() throws {
        let db = try DatabaseManager()

        // The migration should have run. Verify by inserting a session with the new fields.
        try db.upsertProject(Project(id: "p1", name: "Project"))
        let session = Session(
            id: "s1", projectId: "p1",
            createdAt: 1000, updatedAt: 1000,
            lastReadAt: 1234, lastMessageAt: 5678
        )
        try db.upsertSession(session)

        let fetched = try db.session(byId: "s1")!
        XCTAssertEqual(fetched.lastReadAt, 1234)
        XCTAssertEqual(fetched.lastMessageAt, 5678)
    }
}
