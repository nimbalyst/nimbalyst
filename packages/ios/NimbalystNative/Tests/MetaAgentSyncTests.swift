import XCTest
import GRDB
@testable import NimbalystNative

/// Tests for Meta Agent sync to mobile (Phase 2):
/// - the session index entry carries `agentRole` + `createdBySessionId` (camelCase wire format)
/// - the v13 migration adds both columns to the sessions table
/// - upserting a session persists both fields so mobile can group meta agents and their children
final class MetaAgentSyncTests: XCTestCase {

    // MARK: - Index entry decodes the meta-agent fields

    func testServerSessionEntryDecodesMetaAgentFields() throws {
        let json = #"""
        {
            "sessionId": "child-1",
            "encryptedProjectId": "enc-project",
            "projectIdIv": "iv",
            "agentRole": "meta-agent",
            "createdBySessionId": "meta-1",
            "createdAt": 1707820800000,
            "updatedAt": 1707820800001
        }
        """#.data(using: .utf8)!

        let entry = try JSONDecoder().decode(ServerSessionEntry.self, from: json)
        XCTAssertEqual(entry.agentRole, "meta-agent")
        XCTAssertEqual(entry.createdBySessionId, "meta-1")
    }

    func testServerSessionEntryOmitsMetaAgentFieldsWhenAbsent() throws {
        // Older desktops won't send these fields; they must decode to nil (back-compat).
        let json = #"""
        {
            "sessionId": "s1",
            "encryptedProjectId": "enc-project",
            "projectIdIv": "iv",
            "createdAt": 1707820800000,
            "updatedAt": 1707820800001
        }
        """#.data(using: .utf8)!

        let entry = try JSONDecoder().decode(ServerSessionEntry.self, from: json)
        XCTAssertNil(entry.agentRole)
        XCTAssertNil(entry.createdBySessionId)
    }

    // MARK: - v13 migration adds the columns + child-lookup index

    func testMigrationAddsMetaAgentColumns() throws {
        let manager = try DatabaseManager()

        let columnNames = try manager.writer.read { db in
            try db.columns(in: "sessions").map { $0.name }
        }
        XCTAssertTrue(columnNames.contains("agentRole"), "sessions table missing agentRole column")
        XCTAssertTrue(columnNames.contains("createdBySessionId"), "sessions table missing createdBySessionId column")

        let indexNames = try manager.writer.read { db in
            try db.indexes(on: "sessions").map { $0.name }
        }
        XCTAssertTrue(indexNames.contains("idx_sessions_created_by"), "missing createdBySessionId child-lookup index")
    }

    // MARK: - Upsert persists the meta-agent fields

    func testUpsertPersistsMetaAgentFields() throws {
        let manager = try DatabaseManager()
        try manager.upsertProject(Project(id: "/p", name: "p"))

        // A meta agent carries agentRole but no createdBySessionId.
        let meta = Session(
            id: "meta-1",
            projectId: "/p",
            agentRole: "meta-agent",
            createdAt: 1,
            updatedAt: 1
        )
        // A sub-agent carries createdBySessionId pointing at its meta agent.
        let child = Session(
            id: "child-1",
            projectId: "/p",
            createdBySessionId: "meta-1",
            createdAt: 2,
            updatedAt: 2
        )
        try manager.upsertSession(meta)
        try manager.upsertSession(child)

        let fetchedMeta = try manager.session(byId: "meta-1")
        XCTAssertEqual(fetchedMeta?.agentRole, "meta-agent")
        XCTAssertNil(fetchedMeta?.createdBySessionId)

        let fetchedChild = try manager.session(byId: "child-1")
        XCTAssertEqual(fetchedChild?.createdBySessionId, "meta-1")
        XCTAssertNil(fetchedChild?.agentRole)
    }
}
