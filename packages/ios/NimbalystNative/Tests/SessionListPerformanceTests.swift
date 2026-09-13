import XCTest
import GRDB
@testable import NimbalystNative

/// Measured comparison between the sidebar's previous "materialize the whole project,
/// then group in Swift" path and the bounded SQL window, at 100 / 1,000 / 10,000
/// sessions.
///
/// `LegacySessionListGrouping` below reproduces the removed in-memory algorithm so the
/// two are measured on the same corpus and the same operation — a capped view that
/// simply hides the old work would not be a comparison.
///
/// These are host (macOS, SwiftPM) numbers. They cover SQLite plus grouping only; they
/// are not a physical-iPhone frame-time profile and do not include SwiftUI diff, row
/// rendering, decryption or transport.
final class SessionListPerformanceTests: XCTestCase {

    private let projectId = "/p"
    private let corpusSizes = [100, 1_000, 10_000]

    func testWindowCostIsIndependentOfHistorySize() throws {
        var report: [String] = [
            "",
            "iOS sidebar window — host measurements (median of 5 after 1 warmup)",
            String(repeating: "-", widthOf: 78),
            "sessions | legacy in-memory | live SQL | PAGE | FULL WINDOW | search | exceptions | rows held",
        ]

        var windowTimings: [Int: Double] = [:]

        for size in corpusSizes {
            let db = try seededDatabase(size: size)
            let filter = SessionListFilter(projectId: projectId)

            let legacy = median(of: 5) {
                _ = try! LegacySessionListGrouping.groupEverything(db, projectId: self.projectId)
            }
            // Before the projection: grouping re-derived from `sessions` on every read.
            let live = median(of: 5) {
                _ = try! db.sessionListPageLive(filter: filter, after: nil, limit: 100)
            }

            try db.rebuildSessionListProjection(projectId: projectId, metaAgentEnabled: true)
            var pageItems = 0
            let window = median(of: 5) {
                pageItems = try! db.sessionListPage(filter: filter, after: nil, limit: 100).items.count
            }
            let search = median(of: 5) {
                _ = try! db.sessionListPage(
                    filter: SessionListFilter(projectId: self.projectId, searchText: "needle"),
                    after: nil, limit: 100
                )
            }
            let exceptions = median(of: 5) {
                _ = try! db.sessionListExceptions(filter: filter, after: nil, limit: 50)
            }

            let fullWindow = median(of: 5) {
                _ = try! db.sessionListWindow(SessionListWindowRequest(filter: filter))
            }
            windowTimings[size] = fullWindow
            report.append(String(
                format: "%8d | %15.2fms | %6.2fms | %7.2fms | %10.2fms | %4.2fms | %8.2fms | %9d",
                size, legacy, live, window, fullWindow, search, exceptions, pageItems
            ))

            XCTAssertLessThanOrEqual(pageItems, 100, "the page never exceeds its budget")
        }

        // The whole point of the slice: the first query stops scaling with history.
        let smallest = try XCTUnwrap(windowTimings[corpusSizes.first!])
        let largest = try XCTUnwrap(windowTimings[corpusSizes.last!])
        report.append(String(format: "window growth 100 -> 10,000 sessions: %.1fx", largest / max(smallest, 0.001)))
        print(report.joined(separator: "\n"))

        // The projected page reads `limit` rows off an ordered index, so a 100x corpus
        // must not cost meaningfully more. Generous factor so the assertion reports a
        // real regression rather than machine noise.
        XCTAssertLessThan(largest, smallest * 4, "complete window query cost tracked history size")
    }

    /// The adversarial shape for a windowed sidebar: almost all history lives inside a
    /// handful of groups, so a bounded page still has to know each group's complete
    /// membership. This is the case that decides whether "bounded page" also means
    /// "bounded work".
    func testGroupHeavyHistoryCost() throws {
        var report: [String] = [
            "",
            "iOS sidebar window — GROUP-HEAVY corpus (95% of history inside 12 groups)",
            "sessions | live SQL | PAGE | FULL WINDOW | exceptions | rebuild | groups on page",
        ]
        var projectedTimings: [Double] = []

        for size in corpusSizes {
            let db = try seededDatabase(size: size, groupHeavy: true)
            let filter = SessionListFilter(projectId: projectId)
            let live = median(of: 5) {
                _ = try! db.sessionListPageLive(filter: filter, after: nil, limit: 100)
            }
            var rebuild = 0.0
            do {
                let start = DispatchTime.now().uptimeNanoseconds
                try db.rebuildSessionListProjection(projectId: projectId, metaAgentEnabled: true)
                rebuild = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
            }
            var groups = 0
            let window = median(of: 5) {
                groups = try! db.sessionListPage(filter: filter, after: nil, limit: 100).items.count
            }
            let exceptions = median(of: 5) {
                _ = try! db.sessionListExceptions(filter: filter, after: nil, limit: 50)
            }
            let fullWindow = median(of: 5) {
                _ = try! db.sessionListWindow(SessionListWindowRequest(filter: filter))
            }
            projectedTimings.append(fullWindow)
            report.append(String(format: "%8d | %6.2fms | %7.2fms | %10.2fms | %8.2fms | %5.1fms | %15d",
                                 size, live, window, fullWindow, exceptions, rebuild, groups))
            if size == corpusSizes.last {
                report.append("")
                report.append("EXPLAIN QUERY PLAN (projected page) at \(size) sessions:")
                report.append(try db.sessionListPageQueryPlan(filter: filter, limit: 100))
            }
        }
        print(report.joined(separator: "\n"))

        // The shape that broke the CTE: a bounded page over a few enormous groups.
        XCTAssertLessThan(projectedTimings[2], max(projectedTimings[0], 0.2) * 4,
                          "complete window query cost tracked history size on a group-heavy corpus")
    }

    func testMaterializedRowsDoNotGrowWithHistory() throws {
        var counts: [Int] = []
        for size in corpusSizes {
            let db = try seededDatabase(size: size)
            let snapshot = try db.sessionListWindow(SessionListWindowRequest(
                filter: SessionListFilter(projectId: projectId),
                materializedLimit: SessionListWindowModel.pageSize
            ))
            counts.append(snapshot.items.count + snapshot.exceptions.count)
        }
        // 100 sessions do not fill a page (grouping and archives collapse them), so the
        // meaningful assertion is that once the page saturates, more history adds nothing.
        for count in counts {
            XCTAssertLessThanOrEqual(count, SessionListWindowModel.pageSize + 1)
        }
        XCTAssertEqual(counts[1], counts[2],
                       "materialized rows grew from 1,000 to 10,000 sessions: \(counts)")
    }

    // MARK: - Corpus

    /// Mixed history: archives, a large workstream, worktrees, a meta-agent group, one
    /// running session buried in the oldest rows, and one searchable title.
    private func seededDatabase(size: Int, groupHeavy: Bool = false) throws -> DatabaseManager {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: projectId, name: "p"))
        try db.writer.write { database in
            try Session(id: "ws-parent", projectId: projectId, titleDecrypted: "Big workstream",
                        sessionType: "workstream", createdAt: 0, updatedAt: 0).save(database)
            try Session(id: "meta-parent", projectId: projectId, titleDecrypted: "Meta",
                        agentRole: "meta-agent", createdAt: 0, updatedAt: 1).save(database)
            for index in 0..<size {
                let id = String(format: "s-%06d", index)
                // Roughly a fifth of history sits in one large workstream, a tenth in
                // worktrees, a twentieth under the meta agent, and half is archived.
                // Group-heavy: nearly everything hangs off twelve group headers, so a
                // page of a dozen rows still spans most of history.
                let inWorkstream = groupHeavy ? index % 10 < 6 : index % 5 == 0
                let inWorktree = !inWorkstream && (groupHeavy ? index % 10 < 9 : index % 10 == 3)
                let underMeta = !inWorkstream && !inWorktree && (groupHeavy ? index % 10 < 9 : index % 20 == 7)
                try Session(
                    id: id,
                    projectId: projectId,
                    titleDecrypted: index == 0 ? "needle in the oldest history" : "session \(index)",
                    sessionType: nil,
                    parentSessionId: inWorkstream ? "ws-parent" : nil,
                    createdBySessionId: underMeta ? "meta-parent" : nil,
                    phase: index % 3 == 0 ? "implementing" : nil,
                    worktreeId: inWorktree ? "wt-\(index % (groupHeavy ? 5 : 40))" : nil,
                    isArchived: index % 2 == 1,
                    isExecuting: index == 0,
                    createdAt: 1_000 + index,
                    updatedAt: 1_000 + index
                ).save(database)
            }
        }
        return db
    }

    private func median(of iterations: Int, _ block: () -> Void) -> Double {
        block() // warmup
        var samples: [Double] = []
        for _ in 0..<iterations {
            let start = DispatchTime.now().uptimeNanoseconds
            block()
            samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        return samples.sorted()[iterations / 2]
    }
}

private extension String {
    init(repeating character: String, widthOf width: Int) {
        self = String(repeating: character, count: width)
    }
}

/// The sidebar's pre-Slice-2 behaviour, kept in the test target only: fetch every
/// session for the project and rebuild the hierarchy, aggregate status and time-period
/// sections in Swift. It exists so the "before" column measures the same work the
/// window replaced.
enum LegacySessionListGrouping {

    static func groupEverything(_ db: DatabaseManager, projectId: String) throws -> Int {
        let sessions = try db.writer.read { database in
            try Session
                .filter(Session.Columns.projectId == projectId)
                .order(Session.Columns.updatedAt.desc)
                .fetchAll(database)
        }
        let visible = sessions.filter { !$0.isArchived }

        // Meta-agent groups claim their members first.
        let metaGrouping = MetaAgentGrouper.group(sessions: visible, enabled: true)
        let remaining = visible.filter { !metaGrouping.groupedSessionIds.contains($0.id) }

        // Workstreams.
        let parentIds = Set(remaining.filter { $0.sessionType == "workstream" }.map(\.id))
        let childrenByParent = Dictionary(grouping: remaining.filter {
            if let pid = $0.parentSessionId { return parentIds.contains(pid) }
            return false
        }) { $0.parentSessionId! }

        var groupCount = metaGrouping.groups.count
        var groupedIds = metaGrouping.groupedSessionIds
        var latestUpdates: [Int] = metaGrouping.groups.map(\.latestUpdate)

        for parent in remaining where parent.sessionType == "workstream" {
            let children = (childrenByParent[parent.id] ?? []).sorted { $0.updatedAt > $1.updatedAt }
            _ = computeAggregatedStatus(children.isEmpty ? [parent] : children)
            latestUpdates.append(children.map(\.updatedAt).max() ?? parent.updatedAt)
            groupedIds.insert(parent.id)
            for child in children { groupedIds.insert(child.id) }
            groupCount += 1
        }

        // Worktrees.
        let worktreeSessions = remaining.filter { $0.worktreeId != nil && !groupedIds.contains($0.id) }
        for (_, members) in Dictionary(grouping: worktreeSessions, by: { $0.worktreeId! }) {
            let sorted = members.sorted { $0.createdAt < $1.createdAt }
            guard let parent = sorted.first else { continue }
            let children = sorted.count == 1 ? [] : sorted.sorted { $0.updatedAt > $1.updatedAt }
            _ = computeAggregatedStatus(children.isEmpty ? [parent] : children)
            latestUpdates.append(children.map(\.updatedAt).max() ?? parent.updatedAt)
            for member in sorted { groupedIds.insert(member.id) }
            groupCount += 1
        }

        // Standalone rows plus the time-period bucketing the list rendered.
        let standalone = remaining.filter { !groupedIds.contains($0.id) && $0.sessionType != "workstream" }
        var byPeriod: [TimePeriod: Int] = [:]
        for session in standalone {
            byPeriod[TimePeriod.classify(epochMs: session.updatedAt), default: 0] += 1
        }
        for update in latestUpdates {
            byPeriod[TimePeriod.classify(epochMs: update), default: 0] += 1
        }
        return groupCount + standalone.count + byPeriod.count
    }
}
