import XCTest
@testable import NimbalystNative

/// Tests for the Meta Agent collapsible group on iOS (Phase 3):
/// - `MetaAgentGrouper` partitions a session list into meta-agent groups, mirroring
///   the desktop grouping in `SessionHistory.tsx` (meta = `agentRole == "meta-agent"`,
///   children = `createdBySessionId == metaId`), and leaves unknown/missing links as
///   normal (ungrouped) rows.
/// - `MetaAgentExpansion` persists collapse state with a default-expanded semantics
///   that mirrors desktop (`!collapsedGroups.includes(...)`).
///
/// These are pure-logic tests with no UI host, matching the grouping helper used by
/// `SessionListView`.
final class MetaAgentGroupTests: XCTestCase {

    // MARK: - Fixtures

    private func makeSession(
        id: String,
        agentRole: String? = nil,
        createdBySessionId: String? = nil,
        updatedAt: Int = 0
    ) -> Session {
        Session(
            id: id,
            projectId: "/p",
            agentRole: agentRole,
            createdBySessionId: createdBySessionId,
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
    }

    // MARK: - Grouping logic

    func testGroupingDisabledReturnsNoGroups() {
        let meta = makeSession(id: "meta-1", agentRole: "meta-agent", updatedAt: 100)
        let child = makeSession(id: "c1", createdBySessionId: "meta-1", updatedAt: 110)

        let result = MetaAgentGrouper.group(sessions: [meta, child], enabled: false)

        XCTAssertTrue(result.groups.isEmpty, "no grouping when the alpha flag is off")
        XCTAssertTrue(result.groupedSessionIds.isEmpty)
    }

    func testNoMetaAgentsReturnsNoGroups() {
        let a = makeSession(id: "a", updatedAt: 10)
        let b = makeSession(id: "b", updatedAt: 20)

        let result = MetaAgentGrouper.group(sessions: [a, b], enabled: true)

        XCTAssertTrue(result.groups.isEmpty)
        XCTAssertTrue(result.groupedSessionIds.isEmpty)
    }

    func testGroupsMetaAgentWithChildrenAndExcludesUnrelated() {
        let meta = makeSession(id: "meta-1", agentRole: "meta-agent", updatedAt: 100)
        let c1 = makeSession(id: "c1", createdBySessionId: "meta-1", updatedAt: 110)
        let c2 = makeSession(id: "c2", createdBySessionId: "meta-1", updatedAt: 120)
        let c3 = makeSession(id: "c3", createdBySessionId: "meta-1", updatedAt: 130)
        let unrelated1 = makeSession(id: "u1", updatedAt: 90)
        let unrelated2 = makeSession(id: "u2", updatedAt: 80)

        let result = MetaAgentGrouper.group(
            sessions: [meta, c1, c2, c3, unrelated1, unrelated2],
            enabled: true
        )

        XCTAssertEqual(result.groups.count, 1)
        let group = result.groups[0]
        XCTAssertEqual(group.metaSession.id, "meta-1")
        XCTAssertEqual(Set(group.children.map(\.id)), ["c1", "c2", "c3"])
        // Meta + children are reported as grouped; unrelated sessions are not.
        XCTAssertEqual(result.groupedSessionIds, ["meta-1", "c1", "c2", "c3"])
        XCTAssertFalse(result.groupedSessionIds.contains("u1"))
        XCTAssertFalse(result.groupedSessionIds.contains("u2"))
    }

    func testChildrenSortedByUpdatedAtDescending() {
        let meta = makeSession(id: "meta-1", agentRole: "meta-agent", updatedAt: 100)
        let older = makeSession(id: "older", createdBySessionId: "meta-1", updatedAt: 110)
        let newest = makeSession(id: "newest", createdBySessionId: "meta-1", updatedAt: 130)
        let middle = makeSession(id: "middle", createdBySessionId: "meta-1", updatedAt: 120)

        let result = MetaAgentGrouper.group(sessions: [meta, older, newest, middle], enabled: true)

        XCTAssertEqual(result.groups.count, 1)
        XCTAssertEqual(result.groups[0].children.map(\.id), ["newest", "middle", "older"])
    }

    func testUnknownOrMissingCreatedBySessionIdFallsBackToNormalRow() {
        let meta = makeSession(id: "meta-1", agentRole: "meta-agent", updatedAt: 100)
        // Points at a session id that does not exist / is not a meta agent.
        let orphan = makeSession(id: "orphan", createdBySessionId: "does-not-exist", updatedAt: 50)
        // No parent link at all.
        let plain = makeSession(id: "plain", createdBySessionId: nil, updatedAt: 40)

        let result = MetaAgentGrouper.group(sessions: [meta, orphan, plain], enabled: true)

        XCTAssertEqual(result.groups.count, 1)
        XCTAssertTrue(result.groups[0].children.isEmpty, "orphan/plain must not attach to the meta group")
        // Only the meta session is grouped; the orphan and plain rows stay standalone.
        XCTAssertEqual(result.groupedSessionIds, ["meta-1"])
        XCTAssertFalse(result.groupedSessionIds.contains("orphan"))
        XCTAssertFalse(result.groupedSessionIds.contains("plain"))
    }

    func testChildOfNonMetaSessionIsNotGrouped() {
        // A session whose createdBySessionId points at a NORMAL session (not a meta
        // agent) is not a sub-agent and must render as a normal row.
        let normal = makeSession(id: "normal", updatedAt: 100)
        let child = makeSession(id: "child", createdBySessionId: "normal", updatedAt: 90)

        let result = MetaAgentGrouper.group(sessions: [normal, child], enabled: true)

        XCTAssertTrue(result.groups.isEmpty)
        XCTAssertTrue(result.groupedSessionIds.isEmpty)
    }

    func testNestedMetaIsNotCountedAsChildOfAnotherMeta() {
        // A session that is ITSELF a meta but whose createdBySessionId points at another
        // meta must not attach as a child -- otherwise it would render twice (a child row
        // AND its own group header) and emit a duplicate List selection tag on iPad.
        let parent = makeSession(id: "meta-parent", agentRole: "meta-agent", updatedAt: 100)
        let nested = makeSession(
            id: "meta-nested",
            agentRole: "meta-agent",
            createdBySessionId: "meta-parent",
            updatedAt: 110
        )

        let result = MetaAgentGrouper.group(sessions: [parent, nested], enabled: true)

        // Each meta gets its own group header; the nested meta is never a child.
        XCTAssertEqual(result.groups.count, 2)
        let parentGroup = result.groups.first { $0.id == "meta-parent" }
        XCTAssertNotNil(parentGroup)
        XCTAssertTrue(parentGroup?.children.isEmpty ?? false, "a nested meta must not attach as a child")
        // The nested meta is grouped exactly once -- as its own header, not duplicated.
        XCTAssertEqual(result.groupedSessionIds, ["meta-parent", "meta-nested"])
    }

    func testMultipleMetaAgentsGroupSeparatelyAndSortByRecency() {
        // meta-A's most recent activity is its child at 200; meta-B's is its child at
        // 500, so the meta-B group should sort first (newest group first).
        let metaA = makeSession(id: "meta-A", agentRole: "meta-agent", updatedAt: 100)
        let a1 = makeSession(id: "a1", createdBySessionId: "meta-A", updatedAt: 200)
        let metaB = makeSession(id: "meta-B", agentRole: "meta-agent", updatedAt: 150)
        let b1 = makeSession(id: "b1", createdBySessionId: "meta-B", updatedAt: 500)

        let result = MetaAgentGrouper.group(sessions: [metaA, a1, metaB, b1], enabled: true)

        XCTAssertEqual(result.groups.count, 2)
        XCTAssertEqual(result.groups.map(\.id), ["meta-B", "meta-A"])
        XCTAssertEqual(result.groups[0].children.map(\.id), ["b1"])
        XCTAssertEqual(result.groups[1].children.map(\.id), ["a1"])
        XCTAssertEqual(result.groupedSessionIds, ["meta-A", "a1", "meta-B", "b1"])
    }

    func testGroupLatestUpdatePrefersChildActivity() {
        let meta = makeSession(id: "meta-1", agentRole: "meta-agent", updatedAt: 100)
        let child = makeSession(id: "c1", createdBySessionId: "meta-1", updatedAt: 250)

        let group = MetaAgentGroup(metaSession: meta, children: [child])
        XCTAssertEqual(group.latestUpdate, 250)

        let childless = MetaAgentGroup(metaSession: meta, children: [])
        XCTAssertEqual(childless.latestUpdate, 100, "falls back to the meta session's own timestamp")
    }

    // MARK: - Expand/collapse persistence

    /// Returns a clean, isolated UserDefaults suite for one test. `#function` as a
    /// default argument resolves at the call site, so each test gets a unique suite.
    private func freshDefaults(_ name: String = #function) -> UserDefaults {
        let suite = "MetaAgentExpansionTests.\(name)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func testExpansionDefaultsToExpanded() {
        let store = MetaAgentExpansion(projectId: "/p", defaults: freshDefaults())
        XCTAssertTrue(store.isExpanded("meta-1"), "meta-agent groups default to expanded (mirroring desktop)")
        XCTAssertTrue(store.collapsedIds().isEmpty)
    }

    func testCollapseAndExpandRoundTrip() {
        let defaults = freshDefaults()
        let store = MetaAgentExpansion(projectId: "/p", defaults: defaults)

        store.setExpanded(false, for: "meta-1")
        XCTAssertFalse(store.isExpanded("meta-1"))

        // A fresh store over the same defaults reads the persisted collapse.
        let reread = MetaAgentExpansion(projectId: "/p", defaults: defaults)
        XCTAssertFalse(reread.isExpanded("meta-1"))
        XCTAssertEqual(reread.collapsedIds(), ["meta-1"])

        // Re-expanding removes it from the persisted collapsed set.
        reread.setExpanded(true, for: "meta-1")
        XCTAssertTrue(reread.isExpanded("meta-1"))
        XCTAssertTrue(MetaAgentExpansion(projectId: "/p", defaults: defaults).collapsedIds().isEmpty)
    }

    func testExpansionScopedPerProject() {
        let defaults = freshDefaults()
        let projectA = MetaAgentExpansion(projectId: "/a", defaults: defaults)
        let projectB = MetaAgentExpansion(projectId: "/b", defaults: defaults)

        projectA.setExpanded(false, for: "meta-1")

        XCTAssertFalse(projectA.isExpanded("meta-1"))
        XCTAssertTrue(projectB.isExpanded("meta-1"), "a collapse in one project must not leak into another")
    }
}
