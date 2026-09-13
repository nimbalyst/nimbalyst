import XCTest
import GRDB
import Combine
@testable import NimbalystNative

/// Behavioral regressions for the bounded SQL sidebar window (Slice 2 of the iOS
/// session-list performance plan).
///
/// The invariant every test here defends is the same one: the work the sidebar does
/// must be a function of the *window* the user can see, not of how much history the
/// account has retained. Filtering, grouping, aggregate status and the archive/phase
/// facets all run in SQL, so a project with 10,000 sessions materializes the same
/// number of rows as a project with 100.
///
/// `MetaAgentGrouper` (Tests/MetaAgentGroupTests.swift) remains the reference
/// implementation of the desktop grouping rules; `testGroupingMatchesReferenceGrouper`
/// asserts the SQL reproduces it rather than duplicating its cases here.
final class SessionListWindowTests: XCTestCase {

    private let projectId = "/p"

    func testMachineFilterKeepsOtherHostsOutOfWindow() throws {
        let db = try makeDatabase()
        try seed(db, count: 3)
        try db.writer.write { database in
            try database.execute(sql: "UPDATE sessions SET hostDeviceId = 'sandbox' WHERE id = 's-000001'")
            try database.execute(sql: "UPDATE sessions SET hostDeviceId = 'desktop' WHERE id <> 's-000001'")
        }
        let page = try db.sessionListPage(filter: SessionListFilter(projectId: projectId, hostDeviceId: "sandbox"), after: nil, limit: 100)
        XCTAssertEqual(page.items.map { $0.parent.id }, ["s-000001"])
    }

    // MARK: - Fixtures

    private func makeDatabase() throws -> DatabaseManager {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: projectId, name: "p"))
        return db
    }

    @discardableResult
    private func seed(
        _ db: DatabaseManager,
        count: Int,
        idPrefix: String = "s",
        startUpdatedAt: Int = 1_000_000,
        step: Int = 1_000,
        isArchived: Bool = false
    ) throws -> [Session] {
        var sessions: [Session] = []
        for index in 0..<count {
            sessions.append(Session(
                id: "\(idPrefix)-\(String(format: "%06d", index))",
                projectId: projectId,
                titleDecrypted: "\(idPrefix) \(index)",
                isArchived: isArchived,
                createdAt: startUpdatedAt + index * step,
                updatedAt: startUpdatedAt + index * step
            ))
        }
        try db.writer.write { database in
            for session in sessions { try session.save(database) }
        }
        return sessions
    }

    private func filter(
        includeArchived: Bool = false,
        search: String? = nil,
        phase: PhaseFilter = .all,
        metaAgentEnabled: Bool = true
    ) -> SessionListFilter {
        SessionListFilter(
            projectId: projectId,
            includeArchived: includeArchived,
            searchText: search,
            phase: phase,
            metaAgentEnabled: metaAgentEnabled
        )
    }

    // MARK: - Bounded window

    func testPageIsBoundedAndKeysetPagesThroughEveryItem() throws {
        let db = try makeDatabase()
        try seed(db, count: 450)

        var seen: [String] = []
        var cursor: SessionListCursor?
        var pages = 0
        repeat {
            let page = try db.sessionListPage(filter: filter(), after: cursor, limit: 100)
            XCTAssertLessThanOrEqual(page.items.count, 100, "page must never exceed its limit")
            seen.append(contentsOf: page.items.map(\.group.key))
            cursor = page.nextCursor
            pages += 1
            XCTAssertLessThan(pages, 10, "keyset paging did not terminate")
        } while cursor != nil

        XCTAssertEqual(seen.count, 450)
        XCTAssertEqual(Set(seen).count, 450, "keyset paging must not duplicate or drop items")
        // Newest first.
        XCTAssertEqual(seen.first, "s:s-000449")
        XCTAssertEqual(seen.last, "s:s-000000")
    }

    func testIdenticalTimestampsPageWithoutDuplicatesOrGaps() throws {
        let db = try makeDatabase()
        // Every row shares one updatedAt, so ordering rests entirely on the id tie-breaker.
        try seed(db, count: 300, startUpdatedAt: 5_000, step: 0)

        var seen: [String] = []
        var cursor: SessionListCursor?
        repeat {
            let page = try db.sessionListPage(filter: filter(), after: cursor, limit: 50)
            seen.append(contentsOf: page.items.map(\.group.key))
            cursor = page.nextCursor
        } while cursor != nil

        XCTAssertEqual(seen.count, 300)
        XCTAssertEqual(Set(seen).count, 300)
    }

    func testPageFillsEvenWhenTheNewestHistoryIsOneHugeGroup() throws {
        let db = try makeDatabase()
        // The newest ~900 rows all collapse into a single workstream, so the candidate
        // cap that normally bounds grouping cannot produce a full page on its own.
        try db.writer.write { database in
            try Session(id: "ws", projectId: projectId, sessionType: "workstream",
                        createdAt: 1, updatedAt: 1).save(database)
            for index in 0..<900 {
                try Session(id: "c\(String(format: "%04d", index))", projectId: projectId,
                            parentSessionId: "ws", createdAt: 2, updatedAt: 100_000 + index).save(database)
            }
        }
        try seed(db, count: 150, idPrefix: "older", startUpdatedAt: 1_000, step: 1)

        let page = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertEqual(page.items.count, 100, "the query widens rather than returning a short page")
        XCTAssertEqual(page.items.first?.group.key, "ws:ws")
        XCTAssertEqual(page.items[1].group.key, "s:older-000149", "older standalone rows still rank correctly")
    }

    // MARK: - Groups

    func testWorkstreamGroupCollapsesChildrenAndOrdersByChildActivity() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "ws", projectId: projectId, titleDecrypted: "Workstream",
                        sessionType: "workstream", createdAt: 10, updatedAt: 10).save(database)
            for index in 0..<3 {
                try Session(id: "c\(index)", projectId: projectId, titleDecrypted: "child \(index)",
                            parentSessionId: "ws", createdAt: 20, updatedAt: 100 + index).save(database)
            }
            try Session(id: "solo", projectId: projectId, titleDecrypted: "solo",
                        createdAt: 5, updatedAt: 50).save(database)
        }

        let page = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertEqual(page.items.map(\.group.key), ["ws:ws", "s:solo"])

        let group = page.items[0].group
        XCTAssertEqual(group.kind, .workstream)
        XCTAssertEqual(group.childCount, 3)
        // Ordering uses the newest CHILD, not the (stale) parent row.
        XCTAssertEqual(group.orderTimestamp, 102)
        XCTAssertEqual(page.items[0].parent.id, "ws")
    }

    func testCollapsedGroupAggregatesStatusWithoutMaterializingChildren() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "ws", projectId: projectId, sessionType: "workstream",
                        createdAt: 10, updatedAt: 10).save(database)
            for index in 0..<500 {
                try Session(
                    id: "c\(String(format: "%04d", index))",
                    projectId: projectId,
                    parentSessionId: "ws",
                    isExecuting: index == 499,
                    createdAt: 20,
                    updatedAt: 100 + index
                ).save(database)
            }
        }

        let page = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertEqual(page.items.count, 1, "500 children collapse into one display group")
        XCTAssertEqual(page.items[0].group.childCount, 500)
        XCTAssertEqual(page.items[0].group.status, .processing,
                       "aggregate status spans the whole cached group, not a page of it")
    }

    func testWorktreeParentIsOldestMemberRegardlessOfInsertionOrder() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            // Inserted newest-first so "whichever child arrived first" would pick the wrong parent.
            try Session(id: "late", projectId: projectId, worktreeId: "wt-1",
                        createdAt: 900, updatedAt: 900).save(database)
            try Session(id: "early", projectId: projectId, worktreeId: "wt-1",
                        createdAt: 100, updatedAt: 200).save(database)
        }

        let page = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertEqual(page.items.count, 1)
        XCTAssertEqual(page.items[0].group.kind, .worktree)
        XCTAssertEqual(page.items[0].parent.id, "early")
        XCTAssertEqual(page.items[0].group.childCount, 2, "a multi-session worktree lists every member")
        XCTAssertEqual(page.items[0].group.orderTimestamp, 900)
    }

    func testGroupingMatchesReferenceGrouper() throws {
        let db = try makeDatabase()
        var sessions: [Session] = [
            Session(id: "meta", projectId: projectId, agentRole: "meta-agent", createdAt: 1, updatedAt: 10),
            Session(id: "sub-a", projectId: projectId, createdBySessionId: "meta", createdAt: 2, updatedAt: 30),
            Session(id: "sub-b", projectId: projectId, createdBySessionId: "meta", createdAt: 3, updatedAt: 20),
            Session(id: "orphan", projectId: projectId, createdBySessionId: "gone", createdAt: 4, updatedAt: 40),
            Session(id: "plain", projectId: projectId, createdAt: 5, updatedAt: 50)
        ]
        sessions.sort { $0.id < $1.id }
        try db.writer.write { database in
            for session in sessions { try session.save(database) }
        }

        let reference = MetaAgentGrouper.group(sessions: sessions, enabled: true)
        let page = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        let metaItems = page.items.filter { $0.group.kind == .metaAgent }

        XCTAssertEqual(metaItems.map(\.parent.id), reference.groups.map(\.metaSession.id))
        XCTAssertEqual(metaItems.map(\.group.childCount), reference.groups.map { $0.children.count })
        XCTAssertEqual(metaItems[0].group.orderTimestamp, reference.groups[0].latestUpdate)

        // Sessions the reference grouper leaves ungrouped still render as ordinary rows.
        let standalone = Set(page.items.filter { $0.group.kind == .standalone }.map(\.parent.id))
        XCTAssertEqual(standalone, ["orphan", "plain"])
        XCTAssertTrue(reference.groupedSessionIds.isDisjoint(with: standalone))
    }

    func testMetaAgentGroupingDisabledFallsBackToFlatRows() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "meta", projectId: projectId, agentRole: "meta-agent",
                        createdAt: 1, updatedAt: 10).save(database)
            try Session(id: "sub", projectId: projectId, createdBySessionId: "meta",
                        createdAt: 2, updatedAt: 20).save(database)
        }

        let page = try db.sessionListPage(filter: filter(metaAgentEnabled: false), after: nil, limit: 100)
        XCTAssertEqual(page.items.map(\.group.kind), [.standalone, .standalone])
    }

    // MARK: - Filters in SQL

    func testArchiveFilterAppliesInSQL() throws {
        let db = try makeDatabase()
        try seed(db, count: 5, idPrefix: "live")
        try seed(db, count: 7, idPrefix: "old", startUpdatedAt: 1, step: 1, isArchived: true)

        let visible = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertEqual(visible.items.count, 5)

        let withArchives = try db.sessionListPage(filter: filter(includeArchived: true), after: nil, limit: 100)
        XCTAssertEqual(withArchives.items.count, 12)
    }

    func testSearchFindsOlderSessionsOutsideTheLoadedPage() throws {
        let db = try makeDatabase()
        try seed(db, count: 2_000)
        try db.writer.write { database in
            try Session(id: "needle", projectId: projectId, titleDecrypted: "Ancient migration notes",
                        createdAt: 1, updatedAt: 1).save(database)
        }

        // The needle is the oldest row in the project: far outside the first page.
        let firstPage = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertFalse(firstPage.items.contains { $0.parent.id == "needle" })

        let hits = try db.sessionListPage(filter: filter(search: "ancient MIGRATION"), after: nil, limit: 100)
        XCTAssertEqual(hits.items.map(\.parent.id), ["needle"], "search queries all cached metadata")
    }

    func testSearchTreatsWildcardsLiterally() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "a", projectId: projectId, titleDecrypted: "100% done",
                        createdAt: 1, updatedAt: 2).save(database)
            try Session(id: "b", projectId: projectId, titleDecrypted: "unrelated",
                        createdAt: 1, updatedAt: 1).save(database)
        }
        let hits = try db.sessionListPage(filter: filter(search: "100%"), after: nil, limit: 10)
        XCTAssertEqual(hits.items.map(\.parent.id), ["a"])
    }

    func testPhaseFilterMatchesGroupsThroughTheirChildren() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "ws", projectId: projectId, sessionType: "workstream",
                        phase: "complete", createdAt: 1, updatedAt: 1).save(database)
            try Session(id: "child", projectId: projectId, parentSessionId: "ws",
                        phase: "implementing", createdAt: 2, updatedAt: 5).save(database)
            try Session(id: "done", projectId: projectId, phase: "complete",
                        createdAt: 3, updatedAt: 3).save(database)
        }

        let active = try db.sessionListPage(filter: filter(phase: .active), after: nil, limit: 100)
        XCTAssertEqual(active.items.map(\.group.key), ["ws:ws"], "a group matches when a child matches")

        let complete = try db.sessionListPage(filter: filter(phase: .complete), after: nil, limit: 100)
        XCTAssertEqual(complete.items.map(\.group.key), ["s:done"])
    }

    // MARK: - Page exceptions

    func testRunningAndPinnedSessionsSurfaceFromOutsideThePage() throws {
        let db = try makeDatabase()
        try seed(db, count: 1_000)
        try db.writer.write { database in
            try Session(id: "running", projectId: projectId, isExecuting: true,
                        createdAt: 1, updatedAt: 2).save(database)
            try Session(id: "pinned", projectId: projectId, isPinned: true,
                        createdAt: 1, updatedAt: 3).save(database)
            try Session(id: "waiting", projectId: projectId, isExecuting: true,
                        hasQueuedPrompts: true, createdAt: 1, updatedAt: 4).save(database)
        }

        let page = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertFalse(page.items.contains { $0.parent.id == "running" })

        let exceptions = try db.sessionListExceptions(filter: filter(), after: nil, limit: 50)
        XCTAssertEqual(Set(exceptions.items.map(\.parent.id)), ["running", "pinned", "waiting"])
        XCTAssertFalse(exceptions.hasMore)
    }

    func testExceptionsPageRatherThanTruncateSilently() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            for index in 0..<40 {
                try Session(id: "r\(String(format: "%03d", index))", projectId: projectId,
                            isExecuting: true, createdAt: 1, updatedAt: 100 + index).save(database)
            }
        }

        let first = try db.sessionListExceptions(filter: filter(), after: nil, limit: 10)
        XCTAssertEqual(first.items.count, 10)
        XCTAssertTrue(first.hasMore, "an overflowing exception set reports more, it does not truncate")

        var seen = Set(first.items.map(\.parent.id))
        var cursor = first.nextCursor
        while let next = cursor {
            let page = try db.sessionListExceptions(filter: filter(), after: next, limit: 10)
            seen.formUnion(page.items.map(\.parent.id))
            cursor = page.nextCursor
        }
        XCTAssertEqual(seen.count, 40)
    }

    // MARK: - Deep links and ancestors

    func testDeepLinkResolvesTheGroupOfAnOffPageChild() throws {
        let db = try makeDatabase()
        try seed(db, count: 500)
        try db.writer.write { database in
            try Session(id: "ws", projectId: projectId, titleDecrypted: "Old workstream",
                        sessionType: "workstream", createdAt: 1, updatedAt: 1).save(database)
            try Session(id: "buried", projectId: projectId, titleDecrypted: "Buried child",
                        parentSessionId: "ws", createdAt: 2, updatedAt: 2).save(database)
        }

        let page = try db.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertFalse(page.items.contains { $0.group.key == "ws:ws" })

        let located = try XCTUnwrap(db.sessionListItem(containing: "buried", filter: filter()))
        XCTAssertEqual(located.group.key, "ws:ws")
        XCTAssertEqual(located.parent.id, "ws", "the ancestor is resolved by id, not by page membership")
    }

    func testDeepLinkReachesArchivedHistoryTheCurrentFilterHides() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "archived", projectId: projectId, isArchived: true,
                        createdAt: 1, updatedAt: 1).save(database)
        }
        XCTAssertNil(try db.sessionListItem(containing: "archived", filter: filter()))
        let located = try db.sessionListItem(containing: "archived", filter: .locating(projectId: projectId))
        XCTAssertEqual(located?.parent.id, "archived")
    }

    // MARK: - Child paging

    func testLargeGroupPagesItsChildren() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "ws", projectId: projectId, sessionType: "workstream",
                        createdAt: 1, updatedAt: 1).save(database)
            for index in 0..<1_000 {
                try Session(id: "c\(String(format: "%04d", index))", projectId: projectId,
                            parentSessionId: "ws", createdAt: 2, updatedAt: 1_000 + index).save(database)
            }
        }

        let first = try db.sessionListChildren(filter: filter(), groupKey: "ws:ws", after: nil, limit: 50)
        XCTAssertEqual(first.rows.count, 50)
        XCTAssertTrue(first.hasMore)
        XCTAssertEqual(first.rows.first?.id, "c0999", "children page newest-first")

        let second = try db.sessionListChildren(filter: filter(), groupKey: "ws:ws",
                                                after: first.nextCursor, limit: 50)
        XCTAssertEqual(second.rows.count, 50)
        XCTAssertTrue(Set(first.rows.map(\.id)).isDisjoint(with: second.rows.map(\.id)))
    }

    func testGroupMemberIdsCoverTheWholeGroupForBulkActions() throws {
        let db = try makeDatabase()
        try db.writer.write { database in
            try Session(id: "meta", projectId: projectId, agentRole: "meta-agent",
                        createdAt: 1, updatedAt: 1).save(database)
            for index in 0..<120 {
                try Session(id: "sub\(index)", projectId: projectId, createdBySessionId: "meta",
                            createdAt: 2, updatedAt: 2).save(database)
            }
        }
        let ids = try db.sessionListGroupMemberIds(filter: filter(), groupKey: "meta:meta")
        XCTAssertEqual(ids.count, 121, "archive/delete of a group covers every member, not a page")
        XCTAssertTrue(ids.contains("meta"))
    }

    // MARK: - Facets

    func testFacetsAreQueriedIndependentlyOfThePage() throws {
        let db = try makeDatabase()
        try seed(db, count: 200)
        try db.writer.write { database in
            try Session(id: "ancient-archived", projectId: projectId, isArchived: true,
                        createdAt: 1, updatedAt: 1).save(database)
            try Session(id: "ancient-phase", projectId: projectId, phase: "planning",
                        createdAt: 1, updatedAt: 2).save(database)
        }

        let facets = try db.sessionListFacets(projectId: projectId)
        XCTAssertTrue(facets.hasArchived, "the archive toggle must not depend on the loaded page")
        XCTAssertTrue(facets.hasPhaseData)
    }

    func testWorkstreamParentsQueryIsBounded() throws {
        let db = try makeDatabase()
        try seed(db, count: 300)
        try db.writer.write { database in
            for index in 0..<5 {
                try Session(id: "ws\(index)", projectId: projectId, titleDecrypted: "WS \(index)",
                            sessionType: "workstream", createdAt: 1, updatedAt: 10 + index).save(database)
            }
        }
        let parents = try db.workstreamParents(projectId: projectId, limit: 3)
        XCTAssertEqual(parents.count, 3)
        XCTAssertEqual(parents.first?.id, "ws4", "newest workstreams first")
    }

    // MARK: - Indexes and migration

    func testIndexMigrationPreservesCachedRows() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("session-list-migration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("cache.sqlite").path

        do {
            let db = try DatabaseManager(path: path)
            try db.upsertProject(Project(id: projectId, name: "p"))
            try seed(db, count: 10)
        }

        let reopened = try DatabaseManager(path: path)
        let page = try reopened.sessionListPage(filter: filter(), after: nil, limit: 100)
        XCTAssertEqual(page.items.count, 10, "re-running migrations must not discard the local cache")

        let indexes = try reopened.writer.read { db in
            try String.fetchAll(db, sql: "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions'")
        }
        XCTAssertTrue(indexes.contains("idx_sessions_project_updated"))
        XCTAssertTrue(indexes.contains("idx_sessions_project_worktree"))
    }

    // MARK: - Window model

    @MainActor
    func testWindowStaysBoundedWhilePagingThroughHistory() async throws {
        let db = try makeDatabase()
        try seed(db, count: 1_000)

        let model = SessionListWindowModel()
        model.start(database: db, filter: filter())
        try await settle(model)
        XCTAssertEqual(model.materializedItemCount, SessionListWindowModel.pageSize)
        let newestKey = model.firstItemKey

        for _ in 0..<8 {
            model.loadNextPage(anchorId: nil)
            try await settle(model)
            XCTAssertLessThanOrEqual(
                model.materializedItemCount,
                SessionListWindowModel.maxMaterializedItems,
                "the window is a ceiling, not a running total"
            )
        }
        XCTAssertEqual(model.materializedItemCount, SessionListWindowModel.maxMaterializedItems)
        XCTAssertTrue(model.canLoadPrevious, "trimmed pages are recorded so scrolling up restores them")
        XCTAssertNotEqual(model.firstItemKey, newestKey, "the window advanced past the newest page")

        let retainedHead = model.firstItemKey?.replacingOccurrences(of: "s:", with: "")
        model.loadPreviousPage()
        XCTAssertEqual(model.scrollAnchor, retainedHead, "upward paging must anchor the rendered row identity")
        try await settle(model)
        XCTAssertLessThanOrEqual(model.materializedItemCount, SessionListWindowModel.maxMaterializedItems)
        model.stop()
    }

    @MainActor
    func testWorkstreamMenuPagesPastItsFirstHundredParents() async throws {
        let db = try makeDatabase()
        try seedWorkstreamParents(db)
        let model = SessionListWindowModel()
        model.start(database: db, filter: filter())
        defer { model.stop() }
        try await settle(model)
        var seen = Set(model.workstreamParents.map(\.id))
        XCTAssertEqual(seen.count, 100)
        while model.workstreamParentsHaveMore {
            model.loadOlderWorkstreams()
            try await settle(model)
            XCTAssertLessThanOrEqual(model.workstreamParents.count, 100)
            seen.formUnion(model.workstreamParents.map(\.id))
        }
        XCTAssertEqual(seen.count, 225)
        model.loadNewerWorkstreams()
        try await settle(model)
        XCTAssertEqual(model.workstreamParents.count, 100)
    }

    private nonisolated func seedWorkstreamParents(_ db: DatabaseManager) throws {
        try db.writer.write { database in
            for index in 0..<225 {
                try Session(id: "ws-\(index)", projectId: "/p", sessionType: "workstream", createdAt: 1, updatedAt: index).save(database)
            }
        }
    }

    @MainActor
    func testAttentionRowsDoNotStallHistoryPaging() async throws {
        let db = try makeDatabase()
        try seed(db, count: 1_000)
        try markNewestPinned(db)
        let model = SessionListWindowModel()
        model.start(database: db, filter: filter())
        defer { model.stop() }
        try await settle(model)
        for _ in 0..<5 {
            model.loadMoreExceptions()
            try await settle(model)
        }
        for _ in 0..<5 {
            model.loadNextPage(anchorId: nil)
            try await settle(model)
        }
        XCTAssertEqual(model.firstItemKey, "s:s-000699",
                       "attention rows outside the page must not set its keyset boundary")
    }

    @MainActor
    func testMoreThanTwelveDefaultExpandedGroupsSettle() async throws {
        let db = try makeDatabase()
        try seedMetaGroups(db)
        let model = SessionListWindowModel()
        var publications = 0
        let subscription = model.$children.sink { _ in publications += 1 }
        model.start(database: db, filter: filter())
        defer { model.stop(); subscription.cancel() }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(model.children.count, SessionListWindowModel.maxExpandedGroups)
        let settledCount = publications
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(publications, settledCount,
                       "restoring evicted default expansions must not restart observation forever")
    }

    private nonisolated func markNewestPinned(_ db: DatabaseManager) throws {
        try db.writer.write { database in
            try database.execute(sql: "UPDATE sessions SET isPinned=1 WHERE id >= 's-000700'")
        }
    }

    private nonisolated func seedMetaGroups(_ db: DatabaseManager) throws {
        try db.writer.write { database in
            for index in 0..<20 {
                let id = "meta\(index)"
                try Session(id: id, projectId: "/p", agentRole: "meta-agent", createdAt: 1, updatedAt: index).save(database)
                try Session(id: "child\(index)", projectId: "/p", createdBySessionId: id, createdAt: 1, updatedAt: index).save(database)
            }
        }
    }

    @MainActor
    func testExpandedGroupLoadsChildrenOnlyWhileExpanded() async throws {
        let db = try makeDatabase()
        try seedWorkstreamGroup(db, childCount: 200)

        let model = SessionListWindowModel()
        model.start(database: db, filter: filter())
        try await settle(model)
        XCTAssertTrue(model.children.isEmpty, "a collapsed group loads no children")

        model.setExpanded(true, groupKey: "ws:ws")
        try await settle(model)
        XCTAssertEqual(model.children["ws:ws"]?.count, SessionListWindowModel.childPageSize)
        XCTAssertTrue(model.childrenHaveMore.contains("ws:ws"))

        model.setExpanded(false, groupKey: "ws:ws")
        try await settle(model)
        XCTAssertNil(model.children["ws:ws"])
        model.stop()
    }

    func testSectionsKeepWindowOrderAndExcludeMetaGroups() {
        let items = [
            makeItem(key: "s:a", kind: .standalone, updatedAt: 900),
            makeItem(key: "meta:m", kind: .metaAgent, updatedAt: 800),
            makeItem(key: "s:b", kind: .standalone, updatedAt: 700)
        ]
        let sections = SessionListWindowModel.sections(for: items.filter { $0.group.kind != .metaAgent })
        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].items.map(\.id), ["s:a", "s:b"])
    }

    /// Nonisolated so the synchronous GRDB write overload is selected inside the
    /// `@MainActor` async tests.
    private nonisolated func seedWorkstreamGroup(_ db: DatabaseManager, childCount: Int) throws {
        let projectId = "/p"
        try db.writer.write { database in
            try Session(id: "ws", projectId: projectId, sessionType: "workstream",
                        createdAt: 1, updatedAt: 1).save(database)
            for index in 0..<childCount {
                try Session(id: "c\(String(format: "%03d", index))", projectId: projectId,
                            parentSessionId: "ws", createdAt: 2, updatedAt: 100 + index).save(database)
            }
        }
    }

    private func makeItem(key: String, kind: SessionListGroupKind, updatedAt: Int) -> SessionListPageItem {
        SessionListPageItem(
            group: SessionListGroup(key: key, kind: kind, childCount: 0, status: .idle, orderTimestamp: updatedAt),
            parent: SessionListRow(
                id: key, projectId: projectId, titleDecrypted: nil, provider: nil, model: nil,
                phase: nil, sessionType: nil, agentRole: nil, parentSessionId: nil,
                createdBySessionId: nil, worktreeId: nil, isArchived: false, isPinned: false,
                isExecuting: false, hasQueuedPrompts: false, createdAt: updatedAt,
                updatedAt: updatedAt, lastReadAt: nil, lastMessageAt: nil
            )
        )
    }

    /// Wait for the observation to publish. `state` returns to `.loading` on every
    /// restart, so this also covers the extra fetch that restoring expansion triggers.
    @MainActor
    private func settle(_ model: SessionListWindowModel, timeout: TimeInterval = 5) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            try await Task.sleep(nanoseconds: 20_000_000)
            if model.state == .loaded { return }
        } while Date() < deadline
        XCTFail("session list window did not publish within \(timeout)s")
    }

    func testActualWindowAuxiliaryQueriesUseSelectiveIndexes() throws {
        let db = try makeDatabase()
        try seed(db, count: 1_000)
        try db.refreshSessionListProjection(projectId: projectId, metaAgentEnabled: true)
        let plans = try db.writer.read { database in
            var statements: [String] = []
            database.trace(options: .statement) { event in
                if case .statement(let statement) = event { statements.append(statement.expandedSQL) }
            }
            _ = try SessionListQueryRunner.window(database, request: SessionListWindowRequest(filter: self.filter()))
            database.trace(options: [])
            let auxiliary = statements.filter { $0.contains("AS hasArchived") || $0.contains("s.sessionType = 'workstream'") }
            XCTAssertEqual(auxiliary.count, 2, "capture the actual window's facet and parent queries")
            return try auxiliary.flatMap { sql in
                try Row.fetchAll(database, sql: "EXPLAIN QUERY PLAN " + sql).map { row in row["detail"] as String }
            }.joined(separator: "\n")
        }
        for index in ["idx_sessions_workstream_page", "idx_sessions_archived_project", "idx_sessions_phase_project"] {
            XCTAssertTrue(plans.contains(index), "Missing selective index \(index):\n\(plans)")
        }
    }

    func testPageQueryUsesTheProjectOrderingIndex() throws {
        let db = try makeDatabase()
        try seed(db, count: 200)
        let plan = try db.sessionListQueryPlan(filter: filter(), limit: 100)
        XCTAssertFalse(
            plan.contains("SCAN sessions") && !plan.contains("idx_sessions_project"),
            "the window query must reach sessions through a project index, not a full table scan:\n\(plan)"
        )
    }
}
