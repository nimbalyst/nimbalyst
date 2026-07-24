import XCTest
@testable import NimbalystNative
import GRDB

/// Tests for Phase 2: Native Navigation features.
/// Covers DatabaseManager new methods, ValueObservation behavior,
/// session count tracking, and relative timestamp formatting.
final class Phase2Tests: XCTestCase {

    // MARK: - DatabaseManager.session(byId:)

    func testSessionByIdReturnsSession() throws {
        let db = try DatabaseManager()

        let project = Project(id: "/path/to/project", name: "project")
        try db.upsertProject(project)

        let session = Session(
            id: "session-1",
            projectId: project.id,
            titleDecrypted: "Test Session",
            createdAt: 1000,
            updatedAt: 2000
        )
        try db.upsertSession(session)

        let fetched = try db.session(byId: "session-1")
        XCTAssertNotNil(fetched)
        XCTAssertEqual(fetched?.id, "session-1")
        XCTAssertEqual(fetched?.titleDecrypted, "Test Session")
    }

    func testSessionByIdReturnsNilForMissing() throws {
        let db = try DatabaseManager()
        let fetched = try db.session(byId: "nonexistent")
        XCTAssertNil(fetched)
    }

    // MARK: - DatabaseManager.deleteSession

    func testDeleteSessionRemovesSession() throws {
        let db = try DatabaseManager()

        let project = Project(id: "/path/to/project", name: "project")
        try db.upsertProject(project)

        let session = Session(id: "s1", projectId: project.id, createdAt: 1000, updatedAt: 2000)
        try db.upsertSession(session)

        // Verify it exists
        XCTAssertNotNil(try db.session(byId: "s1"))

        // Delete it
        try db.deleteSession("s1")

        // Verify it's gone
        XCTAssertNil(try db.session(byId: "s1"))
    }

    func testDeleteSessionCascadesToMessages() throws {
        let db = try DatabaseManager()

        let project = Project(id: "/path", name: "p")
        try db.upsertProject(project)

        let session = Session(id: "s1", projectId: project.id, createdAt: 1000, updatedAt: 2000)
        try db.upsertSession(session)

        // Add messages
        let msg1 = Message(
            id: "m1", sessionId: "s1", sequence: 1,
            source: "user", direction: "input",
            encryptedContent: "enc1", iv: "iv1",
            createdAt: 1000
        )
        let msg2 = Message(
            id: "m2", sessionId: "s1", sequence: 2,
            source: "assistant", direction: "output",
            encryptedContent: "enc2", iv: "iv2",
            createdAt: 2000
        )
        try db.appendMessages([msg1, msg2])

        // Verify messages exist
        let messages = try db.messages(forSession: "s1")
        XCTAssertEqual(messages.count, 2)

        // Delete the session - should cascade to messages
        try db.deleteSession("s1")

        // Messages should be gone too
        let remainingMessages = try db.messages(forSession: "s1")
        XCTAssertEqual(remainingMessages.count, 0)
    }

    // MARK: - DatabaseManager.refreshSessionCount

    func testRefreshSessionCountUpdatesProject() throws {
        let db = try DatabaseManager()

        let project = Project(id: "/path", name: "p", sessionCount: 0)
        try db.upsertProject(project)

        // Add 3 sessions
        for i in 1...3 {
            let session = Session(
                id: "s\(i)", projectId: "/path",
                createdAt: i * 1000, updatedAt: i * 1000
            )
            try db.upsertSession(session)
        }

        // Refresh count
        try db.refreshSessionCount(forProject: "/path")

        // Verify the count is updated
        let projects = try db.allProjects()
        XCTAssertEqual(projects.first?.sessionCount, 3)
    }

    func testRefreshSessionCountAfterDelete() throws {
        let db = try DatabaseManager()

        let project = Project(id: "/path", name: "p")
        try db.upsertProject(project)

        for i in 1...3 {
            let session = Session(
                id: "s\(i)", projectId: "/path",
                createdAt: i * 1000, updatedAt: i * 1000
            )
            try db.upsertSession(session)
        }

        try db.refreshSessionCount(forProject: "/path")
        XCTAssertEqual(try db.allProjects().first?.sessionCount, 3)

        // Delete one session
        try db.deleteSession("s2")
        try db.refreshSessionCount(forProject: "/path")

        XCTAssertEqual(try db.allProjects().first?.sessionCount, 2)
    }

    // MARK: - GRDB ValueObservation

    @MainActor func testValueObservationDetectsInsert() throws {
        let db = try DatabaseManager()
        let expectation = XCTestExpectation(description: "Observation fires on insert")

        var observedProjects: [[Project]] = []

        let observation = ValueObservation.tracking { db in
            try Project.order(Project.Columns.name).fetchAll(db)
        }

        let cancellable = observation.start(
            in: db.writer,
            onError: { _ in },
            onChange: { projects in
                observedProjects.append(projects)
                if observedProjects.count >= 2 {
                    expectation.fulfill()
                }
            }
        )

        // Insert a project after observation is set up
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            try? db.upsertProject(Project(id: "/test", name: "TestProject"))
        }

        wait(for: [expectation], timeout: 2.0)
        cancellable.cancel()

        // First notification is the initial empty state, second is after insert
        XCTAssertGreaterThanOrEqual(observedProjects.count, 2)
        XCTAssertEqual(observedProjects[0].count, 0)
        XCTAssertEqual(observedProjects.last?.count, 1)
        XCTAssertEqual(observedProjects.last?.first?.name, "TestProject")
    }

    @MainActor func testValueObservationDetectsSessionDelete() throws {
        let db = try DatabaseManager()

        // Pre-populate
        let project = Project(id: "/path", name: "p")
        try db.upsertProject(project)
        try db.upsertSession(Session(id: "s1", projectId: "/path", createdAt: 1000, updatedAt: 1000))

        let expectation = XCTestExpectation(description: "Observation fires on delete")
        var observedCounts: [Int] = []

        let observation = ValueObservation.tracking { db in
            try Session.filter(Session.Columns.projectId == "/path").fetchAll(db)
        }

        let cancellable = observation.start(
            in: db.writer,
            onError: { _ in },
            onChange: { sessions in
                observedCounts.append(sessions.count)
                if observedCounts.count >= 2 {
                    expectation.fulfill()
                }
            }
        )

        // Delete after observation starts
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            try? db.deleteSession("s1")
        }

        wait(for: [expectation], timeout: 2.0)
        cancellable.cancel()

        // First observation: 1 session, second: 0 sessions
        XCTAssertGreaterThanOrEqual(observedCounts.count, 2)
        XCTAssertEqual(observedCounts[0], 1)
        XCTAssertEqual(observedCounts.last, 0)
    }

    // MARK: - RelativeTimestamp

    func testRelativeTimestampNow() {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let result = RelativeTimestamp.format(epochMs: now)
        XCTAssertEqual(result, "now")
    }

    func testRelativeTimestampMinutesAgo() {
        let fiveMinutesAgo = Int(Date().timeIntervalSince1970 * 1000) - 5 * 60 * 1000
        let result = RelativeTimestamp.format(epochMs: fiveMinutesAgo)
        XCTAssertEqual(result, "5m ago")
    }

    func testRelativeTimestampHoursAgo() {
        let threeHoursAgo = Int(Date().timeIntervalSince1970 * 1000) - 3 * 3600 * 1000
        let result = RelativeTimestamp.format(epochMs: threeHoursAgo)
        XCTAssertEqual(result, "3h ago")
    }

    func testRelativeTimestampDaysAgo() {
        let twoDaysAgo = Int(Date().timeIntervalSince1970 * 1000) - 2 * 86400 * 1000
        let result = RelativeTimestamp.format(epochMs: twoDaysAgo)
        XCTAssertEqual(result, "2d ago")
    }

    func testRelativeTimestampOlderThanWeek() {
        // 10 days ago should show a date, not "10d ago"
        let tenDaysAgo = Int(Date().timeIntervalSince1970 * 1000) - 10 * 86400 * 1000
        let result = RelativeTimestamp.format(epochMs: tenDaysAgo)
        // Should be a formatted date, not relative
        XCTAssertFalse(result.contains("ago"))
        XCTAssertFalse(result.isEmpty)
    }
}
