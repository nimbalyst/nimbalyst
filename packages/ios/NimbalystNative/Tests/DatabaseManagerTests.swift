import XCTest
@testable import NimbalystNative

final class DatabaseManagerTests: XCTestCase {

    func testMigrationCreatesAllTables() throws {
        let db = try DatabaseManager()

        // Verify we can insert and query projects
        let project = Project(id: "/Users/test/project", name: "project", sessionCount: 0)
        try db.upsertProject(project)

        let projects = try db.allProjects()
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0].id, "/Users/test/project")
        XCTAssertEqual(projects[0].name, "project")
    }

    func testSessionCRUD() throws {
        let db = try DatabaseManager()

        // Create project first (foreign key)
        let project = Project(id: "/Users/test/project", name: "project")
        try db.upsertProject(project)

        // Create session
        let session = Session(
            id: "session-1",
            projectId: "/Users/test/project",
            titleDecrypted: "Test Session",
            provider: "claude",
            mode: "agent",
            createdAt: 1000,
            updatedAt: 2000
        )
        try db.upsertSession(session)

        let sessions = try db.sessions(forProject: "/Users/test/project")
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].titleDecrypted, "Test Session")
        XCTAssertEqual(sessions[0].provider, "claude")
    }

    func testMessageAppendAndQuery() throws {
        let db = try DatabaseManager()

        let project = Project(id: "/p", name: "p")
        try db.upsertProject(project)

        let session = Session(id: "s1", projectId: "/p", createdAt: 1, updatedAt: 1)
        try db.upsertSession(session)

        let msg1 = Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "user", direction: "input",
            encryptedContent: "encrypted1", iv: "iv1",
            contentDecrypted: "Hello",
            createdAt: 100
        )
        let msg2 = Message(
            id: "m2", sessionId: "s1", sequence: 2,
            source: "assistant", direction: "output",
            encryptedContent: "encrypted2", iv: "iv2",
            contentDecrypted: "Hi there",
            createdAt: 200
        )
        try db.appendMessages([msg1, msg2])

        let messages = try db.messages(forSession: "s1")
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].sequence, 1)
        XCTAssertEqual(messages[1].sequence, 2)
    }

    func testSyncStateTracking() throws {
        let db = try DatabaseManager()

        let state = SyncState(roomId: "index", lastCursor: "cursor-abc", lastSequence: 42, lastSyncedAt: 999)
        try db.updateSyncState(state)

        let fetched = try db.syncState(forRoom: "index")
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.lastCursor, "cursor-abc")
        XCTAssertEqual(fetched?.lastSequence, 42)
    }
}
