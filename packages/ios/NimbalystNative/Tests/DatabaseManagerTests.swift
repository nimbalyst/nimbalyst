import XCTest
import GRDB
import Darwin
@testable import NimbalystNative

final class DatabaseManagerTests: XCTestCase {

    @MainActor
    func testUtilityReadRunsAtDatabaseQoSAndReleasesReaderAfterErrors() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = try DatabaseManager(path: directory.appendingPathComponent("test.sqlite").path)
        let finished = expectation(description: "Utility reads complete")
        // Do not await task.value: that would promote the utility task to the
        // test's priority and hide the synchronous-read regression.
        Task.detached(priority: .utility) {
            defer { finished.fulfill() }
            do {
                let qos = try await database.readOnDatabaseQueue { db in
                    XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT 42"), 42)
                    return qos_class_self().rawValue
                }
                XCTAssertEqual(qos, QOS_CLASS_USER_INITIATED.rawValue)
                // Fill all five readers before allowing any of the first wave
                // to finish, with further reads queued behind them.
                let readers = DispatchGroup()
                for _ in 0..<5 { readers.enter() }
                let values = try await withThrowingTaskGroup(of: Int.self) { group in
                    for index in 0..<12 {
                        group.addTask {
                            try await database.readOnDatabaseQueue { db in
                                if index < 5 {
                                    readers.leave()
                                    XCTAssertEqual(readers.wait(timeout: .now() + 2), .success)
                                }
                                return try Int.fetchOne(db, sql: "SELECT ?", arguments: [index])!
                            }
                        }
                    }
                    var values: [Int] = []
                    for try await value in group { values.append(value) }
                    return values.sorted()
                }
                XCTAssertEqual(values, Array(0..<12))
                // More failures than available readers must not exhaust the pool.
                for _ in 0..<10 {
                    do {
                        _ = try await database.readOnDatabaseQueue { db in
                            try db.execute(sql: "SELECT * FROM nonexistent_table")
                        }
                        XCTFail("Query errors must propagate")
                    } catch let error as DatabaseError {
                        XCTAssertEqual(error.resultCode, .SQLITE_ERROR)
                    }
                }
                let result = try await database.readOnDatabaseQueue { db in
                    try Int.fetchOne(db, sql: "SELECT 7")
                }
                XCTAssertEqual(result, 7)
            } catch {
                XCTFail("Unexpected read failure: \(error)")
            }
        }
        await fulfillment(of: [finished], timeout: 5)
    }

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
