import XCTest
import GRDB
@testable import NimbalystNative

/// The persisted group projection is a second representation of the same grouping
/// rules, so the regression that matters is drift: the projected sidebar must show
/// exactly what re-deriving grouping from `sessions` would show, after any sequence of
/// writes.
///
/// Every test here ends in the same assertion (`assertParity`) against
/// `sessionListPageLive`, which is the live fallback query — not a second copy of the
/// rules written for the test.
final class SessionListProjectionTests: XCTestCase {

    private let projectId = "/p"

    private func makeDatabase() throws -> DatabaseManager {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: projectId, name: "p"))
        return db
    }

    private var filter: SessionListFilter {
        SessionListFilter(projectId: projectId)
    }

    private func write(_ db: DatabaseManager, _ body: @escaping (Database) throws -> Void) throws {
        try db.writer.write { database in try body(database) }
    }

    /// Refresh, then assert the projected page matches the live page field for field.
    private func assertParity(
        _ db: DatabaseManager,
        phase: PhaseFilter = .all,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)
        var filter = self.filter
        filter.phase = phase

        let projected = try db.sessionListPage(filter: filter, after: nil, limit: 200)
        let live = try db.sessionListPageLive(filter: filter, after: nil, limit: 200)

        XCTAssertEqual(projected.items.map(\.group.key), live.items.map(\.group.key),
                       "group set/order drifted", file: file, line: line)
        XCTAssertEqual(projected.items.map(\.group.orderTimestamp), live.items.map(\.group.orderTimestamp),
                       "ordering timestamps drifted", file: file, line: line)
        XCTAssertEqual(projected.items.map(\.group.childCount), live.items.map(\.group.childCount),
                       "child counts drifted", file: file, line: line)
        XCTAssertEqual(projected.items.map(\.group.status), live.items.map(\.group.status),
                       "aggregate status drifted", file: file, line: line)
        XCTAssertEqual(projected.items.map(\.parent.id), live.items.map(\.parent.id),
                       "group headers drifted", file: file, line: line)
        let pending = try db.writer.read { database in
            try SessionListProjection.pendingCount(database, projectId: self.projectId)
        }
        XCTAssertEqual(pending, 0, "refresh left work behind", file: file, line: line)
    }

    // MARK: - Convergence under mutation

    func testProjectionMatchesLiveGroupingAcrossMutations() throws {
        let db = try makeDatabase()

        // 1. A mixed starting corpus.
        try write(db) { database in
            try Session(id: "ws", projectId: "/p", titleDecrypted: "WS",
                        sessionType: "workstream", createdAt: 1, updatedAt: 1).save(database)
            try Session(id: "meta", projectId: "/p", titleDecrypted: "Meta",
                        agentRole: "meta-agent", createdAt: 2, updatedAt: 2).save(database)
            for index in 0..<20 {
                try Session(id: "c\(index)", projectId: "/p", titleDecrypted: "c\(index)",
                            parentSessionId: index < 10 ? "ws" : nil,
                            createdBySessionId: index >= 15 ? "meta" : nil,
                            phase: index % 3 == 0 ? "implementing" : "complete",
                            worktreeId: (10..<15).contains(index) ? "wt-a" : nil,
                            createdAt: 10 + index, updatedAt: 100 + index).save(database)
            }
        }
        try assertParity(db)

        // 2. Activity on one child re-orders its group.
        try write(db) { database in
            try database.execute(sql: "UPDATE sessions SET updatedAt = 9000, isExecuting = 1 WHERE id = 'c3'")
        }
        try assertParity(db)

        // 3. Reparenting moves a session between groups.
        try write(db) { database in
            try database.execute(sql: "UPDATE sessions SET parentSessionId = 'ws' WHERE id = 'c18'")
        }
        try assertParity(db)

        // 4. Archiving the workstream parent re-homes its children in the default view.
        try write(db) { database in
            try database.execute(sql: "UPDATE sessions SET isArchived = 1 WHERE id = 'ws'")
        }
        try assertParity(db)

        // 5. Un-archiving puts them back.
        try write(db) { database in
            try database.execute(sql: "UPDATE sessions SET isArchived = 0 WHERE id = 'ws'")
        }
        try assertParity(db)

        // 6. Deleting a group member.
        try write(db) { database in
            try database.execute(sql: "DELETE FROM sessions WHERE id = 'c5'")
        }
        try assertParity(db)

        // 7. Deleting a whole group's parent.
        try write(db) { database in
            try database.execute(sql: "DELETE FROM sessions WHERE id = 'meta'")
        }
        try assertParity(db)

        // 8. A parent arriving AFTER its children claims them.
        try write(db) { database in
            try Session(id: "ws2", projectId: "/p", titleDecrypted: "WS2",
                        sessionType: "workstream", createdAt: 500, updatedAt: 500).save(database)
            try database.execute(sql: "UPDATE sessions SET parentSessionId = 'ws2' WHERE id IN ('c16','c17')")
        }
        try assertParity(db)

        // 9. Phase filtering is served from precomputed columns, so it has to agree too.
        try assertParity(db, phase: .active)
        try assertParity(db, phase: .complete)
    }

    func testChildrenAndDeepLinksAgreeWithTheLivePath() throws {
        let db = try makeDatabase()
        try write(db) { database in
            try Session(id: "ws", projectId: "/p", sessionType: "workstream",
                        createdAt: 1, updatedAt: 1).save(database)
            for index in 0..<40 {
                try Session(id: "c\(String(format: "%02d", index))", projectId: "/p",
                            parentSessionId: "ws", createdAt: 2, updatedAt: 100 + index).save(database)
            }
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)

        let projected = try db.sessionListChildren(filter: filter, groupKey: "ws:ws", after: nil, limit: 10)
        XCTAssertEqual(projected.rows.map(\.id), (30..<40).reversed().map { "c\(String(format: "%02d", $0))" })
        XCTAssertTrue(projected.hasMore)

        let next = try db.sessionListChildren(filter: filter, groupKey: "ws:ws",
                                              after: projected.nextCursor, limit: 10)
        XCTAssertTrue(Set(projected.rows.map(\.id)).isDisjoint(with: next.rows.map(\.id)))

        let located = try XCTUnwrap(db.sessionListItem(containing: "c03", filter: filter))
        XCTAssertEqual(located.group.key, "ws:ws")
        XCTAssertEqual(located.parent.id, "ws")

        XCTAssertEqual(try db.sessionListGroupMemberIds(filter: filter, groupKey: "ws:ws").count, 41)
    }

    func testExceptionLaneReadsFromTheProjection() throws {
        let db = try makeDatabase()
        try write(db) { database in
            for index in 0..<400 {
                try Session(id: "s\(String(format: "%03d", index))", projectId: "/p",
                            createdAt: 1, updatedAt: 1_000 + index).save(database)
            }
            // Running and pinned rows at the very bottom of history.
            try Session(id: "running", projectId: "/p", isExecuting: true,
                        createdAt: 1, updatedAt: 2).save(database)
            try Session(id: "pinned", projectId: "/p", isPinned: true,
                        createdAt: 1, updatedAt: 3).save(database)
            try Session(id: "queued-parent", projectId: "/p", sessionType: "workstream", hasQueuedPrompts: true,
                        createdAt: 1, updatedAt: 4).save(database)
            try Session(id: "idle-child", projectId: "/p", parentSessionId: "queued-parent",
                        createdAt: 1, updatedAt: 5).save(database)
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)

        let page = try db.sessionListPage(filter: filter, after: nil, limit: 100)
        XCTAssertFalse(page.items.contains { $0.parent.id == "running" })

        let exceptions = try db.sessionListExceptions(filter: filter, after: nil, limit: 50)
        XCTAssertEqual(Set(exceptions.items.map(\.parent.id)), ["running", "pinned", "queued-parent"])

        let live = try db.writer.read { database in
            try SessionListQueryRunner.liveGroups(database, filter: self.filter, source: .attention,
                                                  after: nil, limit: 50)
        }
        XCTAssertEqual(Set(exceptions.items.map(\.group.key)), Set(live.items.map(\.group.key)),
                       "projected exception lane drifted from the live one")
    }

    // MARK: - Maintenance

    @MainActor
    func testWriteDuringRefreshCompletionIsEventuallyProjected() async throws {
        let db = try makeDatabase()
        try write(db) { database in
            try Session(id: "first", projectId: "/p", createdAt: 1, updatedAt: 1).save(database)
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)
        let barrier = ProjectionCompletionBarrier()
        let model = SessionListWindowModel { database, project, metaEnabled in
            try await Task.detached {
                try database.refreshSessionListProjection(projectId: project, metaAgentEnabled: metaEnabled)
            }.value
            await barrier.afterRefresh()
        }
        model.start(database: db, filter: filter)
        defer { model.stop() }
        for _ in 0..<100 {
            if await barrier.calls > 0 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        try write(db) { database in
            try Session(id: "second", projectId: "/p", createdAt: 1, updatedAt: 2).save(database)
        }
        // Let the real GRDB observation report pending work while refresh one
        // is still completing, then release it without another database write.
        try await Task.sleep(for: .milliseconds(150))
        await barrier.release()
        for _ in 0..<100 {
            if model.sections.flatMap(\.items).count == 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(model.sections.flatMap(\.items).count, 2)
    }

    func testWholeRecordDraftSaveDoesNotInvalidateAnEntireGroup() throws {
        let db = try makeDatabase()
        try write(db) { database in
            try Session(id: "ws", projectId: "/p", sessionType: "workstream", createdAt: 1, updatedAt: 1).save(database)
            for index in 0..<20 {
                try Session(id: "child\(index)", projectId: "/p", parentSessionId: "ws", createdAt: 1, updatedAt: 1).save(database)
            }
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)
        try write(db) { database in
            var session = try XCTUnwrap(Session.fetchOne(database, id: "ws"))
            session.draftInput = "An unsent local draft"
            try session.save(database)
        }
        XCTAssertEqual(try db.writer.read { try SessionListProjection.pendingCount($0, projectId: "/p") }, 0)
        try write(db) { database in
            var session = try XCTUnwrap(Session.fetchOne(database, id: "ws"))
            session.phase = "implementing"
            try session.save(database)
        }
        XCTAssertEqual(try db.writer.read { try SessionListProjection.pendingCount($0, projectId: "/p") }, 1)
    }

    func testGroupsAreProjectScopedAndMovesInvalidateBothProjects() throws {
        let db = try makeDatabase()
        try db.upsertProject(Project(id: "/q", name: "q"))
        try write(db) { database in
            try Session(id: "a", projectId: "/p", worktreeId: "shared", createdAt: 1, updatedAt: 1).save(database)
            try Session(id: "b", projectId: "/q", worktreeId: "shared", createdAt: 1, updatedAt: 2).save(database)
            try Session(id: "moving", projectId: "/p", createdAt: 1, updatedAt: 3).save(database)
        }
        for project in ["/p", "/q"] {
            try db.refreshSessionListProjection(projectId: project, metaAgentEnabled: true)
        }
        XCTAssertEqual(Set(try db.sessionListPage(filter: filter, after: nil, limit: 100).items.map(\.parent.id)), ["a", "moving"])
        XCTAssertEqual(try db.sessionListPage(filter: SessionListFilter(projectId: "/q"), after: nil, limit: 100).items.map(\.parent.id), ["b"])
        try write(db) { database in
            try database.execute(sql: "UPDATE sessions SET projectId='/q' WHERE id IN ('a','moving')")
        }
        for project in ["/q", "/p"] {
            try db.refreshSessionListProjection(projectId: project, metaAgentEnabled: true)
        }
        XCTAssertTrue(try db.sessionListPage(filter: filter, after: nil, limit: 100).items.isEmpty)
        let destination = try db.sessionListPage(filter: SessionListFilter(projectId: "/q"), after: nil, limit: 100)
        XCTAssertEqual(destination.items.count, 2)
        XCTAssertEqual(destination.items.first(where: { $0.group.key == "wt:shared" })?.group.childCount, 2)
    }

    func testAnyWriterInvalidatesTheProjectionWithoutCallingIntoIt() throws {
        let db = try makeDatabase()
        try write(db) { database in
            try Session(id: "a", projectId: "/p", createdAt: 1, updatedAt: 1).save(database)
        }
        // No refresh call yet: the trigger alone must have recorded the change.
        let pending = try db.writer.read { try SessionListProjection.pendingCount($0, projectId: self.projectId) }
        XCTAssertEqual(pending, 1, "session writes must dirty the projection without cooperation")

        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)
        XCTAssertEqual(
            try db.writer.read { try SessionListProjection.pendingCount($0, projectId: self.projectId) },
            0
        )
        XCTAssertEqual(try db.sessionListPage(filter: filter, after: nil, limit: 10).items.count, 1)
    }

    func testMetaAgentFlagFlipRebuildsRatherThanReportingStaleGrouping() throws {
        let db = try makeDatabase()
        try write(db) { database in
            try Session(id: "meta", projectId: "/p", agentRole: "meta-agent",
                        createdAt: 1, updatedAt: 1).save(database)
            try Session(id: "sub", projectId: "/p", createdBySessionId: "meta",
                        createdAt: 2, updatedAt: 2).save(database)
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)
        XCTAssertEqual(try db.sessionListPage(filter: filter, after: nil, limit: 10).items.map(\.group.kind),
                       [.metaAgent])

        var off = filter
        off.metaAgentEnabled = false
        // The stored grouping no longer applies: the read must not serve it.
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: false)
        XCTAssertEqual(try db.sessionListPage(filter: off, after: nil, limit: 10).items.map(\.group.kind),
                       [.standalone, .standalone])
    }

    func testArchiveAndSearchViewsFallBackToTheLiveQuery() throws {
        let db = try makeDatabase()
        try write(db) { database in
            try Session(id: "live", projectId: "/p", titleDecrypted: "live one",
                        createdAt: 1, updatedAt: 2).save(database)
            try Session(id: "old", projectId: "/p", titleDecrypted: "archived one",
                        isArchived: true, createdAt: 1, updatedAt: 1).save(database)
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)

        var archived = filter
        archived.includeArchived = true
        XCTAssertEqual(try db.sessionListPage(filter: archived, after: nil, limit: 10).items.count, 2,
                       "archives are outside the projection and must still be listed")

        var search = filter
        search.searchText = "archived"
        XCTAssertEqual(try db.sessionListPage(filter: search, after: nil, limit: 10).items.count, 0,
                       "search respects the archive filter it was given")

        search.includeArchived = true
        XCTAssertEqual(try db.sessionListPage(filter: search, after: nil, limit: 10).items.map(\.parent.id),
                       ["old"])
    }

    func testRebuildRepairsATamperedProjection() throws {
        let db = try makeDatabase()
        try write(db) { database in
            for index in 0..<10 {
                try Session(id: "s\(index)", projectId: "/p", createdAt: 1,
                            updatedAt: 100 + index).save(database)
            }
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)

        // Simulate drift from any cause: the projection is derived, so a rebuild is
        // always available and always correct.
        try write(db) { database in
            try database.execute(sql: "DELETE FROM sessionListGroups WHERE groupKey = 's:s5'")
            try database.execute(sql: "UPDATE sessionListGroups SET childCount = 99 WHERE groupKey = 's:s1'")
        }
        XCTAssertEqual(try db.sessionListPage(filter: filter, after: nil, limit: 20).items.count, 9)

        try db.rebuildSessionListProjection(projectId: projectId, metaAgentEnabled: true)
        try assertParity(db)
    }

    /// The migrator records that the projection migration ran, not which shape it
    /// created. An install that ran an earlier shape keeps stale triggers unless the
    /// shape marker forces a drop-and-recreate on open.
    func testStaleShapeMarkerRecreatesEveryProjectionObject() throws {
        let db = try makeDatabase()
        try write(db) { database in
            for index in 0..<3 {
                try Session(id: "s\(index)", projectId: "/p", createdAt: 1,
                            updatedAt: 100 + index).save(database)
            }
        }
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)

        try write(db) { database in
            try database.execute(sql: "DROP TRIGGER trg_slg_dirty_update")
            try database.execute(sql: "UPDATE sessionListProjectionSchema SET version = 0")
            try SessionListProjection.ensureSchema(database)
        }

        let triggers = try db.writer.read { database in
            try String.fetchAll(database, sql: """
                SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg\\_slg\\_%' ESCAPE '\\' ORDER BY name
                """)
        }
        XCTAssertEqual(triggers, ["trg_slg_dirty_delete", "trg_slg_dirty_insert",
                                  "trg_slg_dirty_reparent", "trg_slg_dirty_update"])
        XCTAssertEqual(try db.writer.read { try Int.fetchOne($0, sql: "SELECT version FROM sessionListProjectionSchema") },
                       SessionListProjection.schemaVersion)
        // The state marker went with the old shape, so the next refresh is a rebuild.
        XCTAssertNil(try db.writer.read { try SessionListProjection.builtForMetaAgentEnabled($0, projectId: self.projectId) })
        try assertParity(db)
    }

    /// Refresh work includes the affected group's membership, but not unrelated history.
    func testIncrementalRefreshCostDoesNotTrackHistorySize() throws {
        for giantGroup in [false, true] {
            var timings: [Double] = []
            for size in [1_000, 10_000] {
                let db = try makeDatabase()
                try db.writer.write { database in
                    try Session(id: "ws", projectId: "/p", sessionType: "workstream",
                                createdAt: 1, updatedAt: 1).save(database)
                    for index in 0..<size {
                        try Session(id: "c\(index)", projectId: "/p", parentSessionId: giantGroup || index < 100 ? "ws" : nil,
                                    createdAt: 2, updatedAt: 100 + index).save(database)
                    }
                }
                try db.rebuildSessionListProjection(projectId: projectId, metaAgentEnabled: true)

                try db.writer.write { database in
                    try database.execute(sql: "UPDATE sessions SET updatedAt = 999999 WHERE id = 'c1'")
                }
                let start = DispatchTime.now().uptimeNanoseconds
                try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)
                timings.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
                try db.writer.read { database in
                    let group = try Row.fetchOne(database, sql: "SELECT childCount,orderTimestamp FROM sessionListGroups WHERE projectId = '/p' AND groupKey = 'ws:ws'")
                    XCTAssertEqual(group?["childCount"] as Int?, giantGroup ? size : 100)
                    XCTAssertEqual(group?["orderTimestamp"] as Int?, 999999)
                }
            }
            print(String(format: "incremental refresh (%@): 1k=%.2fms 10k=%.2fms", giantGroup ? "one giant group" : "fixed group, unrelated history grows", timings[0], timings[1]))
            if !giantGroup {
                XCTAssertLessThan(timings[1], max(timings[0], 0.5) * 6,
                                  "incremental refresh scaled with unrelated history: \(timings)")
            }
            // A single giant group's aggregate remains proportional to its membership.
            // Report that cost and verify the result; it is not the bounded-history claim.
        }
    }
}

private actor ProjectionCompletionBarrier {
    private(set) var calls = 0
    private var continuation: CheckedContinuation<Void, Never>?

    func afterRefresh() async {
        calls += 1
        if calls == 1 {
            await withCheckedContinuation { continuation = $0 }
        }
    }

    func release() {
        continuation?.resume()
        continuation = nil
    }
}
