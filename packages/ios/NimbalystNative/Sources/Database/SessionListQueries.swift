import Foundation
import GRDB

// MARK: - Projection

/// The subset of a session the sidebar actually renders.
///
/// The list never needs the encrypted title blobs, the synced draft, branch metadata
/// or the sync watermark, so the window queries project these columns only. Loading a
/// full `Session` for every visible row is what the bounded-window work exists to avoid.
public struct SessionListRow: Identifiable, Hashable, Sendable {
    public var id: String
    public var projectId: String
    public var titleDecrypted: String?
    public var provider: String?
    public var model: String?
    public var phase: String?
    public var sessionType: String?
    public var agentRole: String?
    public var parentSessionId: String?
    public var createdBySessionId: String?
    public var worktreeId: String?
    public var isArchived: Bool
    public var isPinned: Bool
    public var isExecuting: Bool
    public var hasQueuedPrompts: Bool
    public var createdAt: Int
    public var updatedAt: Int
    public var lastReadAt: Int?
    public var lastMessageAt: Int?

    /// Whether a message arrived after the last read (mirrors `Session.hasUnread`).
    public var hasUnread: Bool {
        guard let messageAt = lastMessageAt, messageAt > 0 else { return false }
        guard let readAt = lastReadAt else { return true }
        return messageAt > readAt
    }

    /// Column list used by every window query, so the projection stays in one place.
    static let columns = [
        "id", "projectId", "titleDecrypted", "provider", "model", "phase",
        "sessionType", "agentRole", "parentSessionId", "createdBySessionId", "worktreeId",
        "isArchived", "isPinned", "isExecuting", "hasQueuedPrompts",
        "createdAt", "updatedAt", "lastReadAt", "lastMessageAt"
    ]

    static func selectList(alias: String, prefix: String = "") -> String {
        columns.map { column in
            prefix.isEmpty ? "\(alias).\(column)" : "\(alias).\(column) AS \(prefix)\(column)"
        }.joined(separator: ", ")
    }

    public init(
        id: String,
        projectId: String,
        titleDecrypted: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        phase: String? = nil,
        sessionType: String? = nil,
        agentRole: String? = nil,
        parentSessionId: String? = nil,
        createdBySessionId: String? = nil,
        worktreeId: String? = nil,
        isArchived: Bool = false,
        isPinned: Bool = false,
        isExecuting: Bool = false,
        hasQueuedPrompts: Bool = false,
        createdAt: Int = 0,
        updatedAt: Int = 0,
        lastReadAt: Int? = nil,
        lastMessageAt: Int? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.titleDecrypted = titleDecrypted
        self.provider = provider
        self.model = model
        self.phase = phase
        self.sessionType = sessionType
        self.agentRole = agentRole
        self.parentSessionId = parentSessionId
        self.createdBySessionId = createdBySessionId
        self.worktreeId = worktreeId
        self.isArchived = isArchived
        self.isPinned = isPinned
        self.isExecuting = isExecuting
        self.hasQueuedPrompts = hasQueuedPrompts
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastReadAt = lastReadAt
        self.lastMessageAt = lastMessageAt
    }

    init(row: Row, prefix: String = "") {
        id = row["\(prefix)id"]
        projectId = row["\(prefix)projectId"]
        titleDecrypted = row["\(prefix)titleDecrypted"]
        provider = row["\(prefix)provider"]
        model = row["\(prefix)model"]
        phase = row["\(prefix)phase"]
        sessionType = row["\(prefix)sessionType"]
        agentRole = row["\(prefix)agentRole"]
        parentSessionId = row["\(prefix)parentSessionId"]
        createdBySessionId = row["\(prefix)createdBySessionId"]
        worktreeId = row["\(prefix)worktreeId"]
        isArchived = row["\(prefix)isArchived"] ?? false
        isPinned = row["\(prefix)isPinned"] ?? false
        isExecuting = row["\(prefix)isExecuting"] ?? false
        hasQueuedPrompts = row["\(prefix)hasQueuedPrompts"] ?? false
        createdAt = row["\(prefix)createdAt"] ?? 0
        updatedAt = row["\(prefix)updatedAt"] ?? 0
        lastReadAt = row["\(prefix)lastReadAt"]
        lastMessageAt = row["\(prefix)lastMessageAt"]
    }
}

// MARK: - Display groups

/// How a display row was formed. Mirrors the desktop grouping rules; `SessionListQueries`
/// resolves it in SQL so a collapsed group never has to materialize its children.
public enum SessionListGroupKind: String, Sendable {
    case standalone
    case workstream
    case worktree
    case metaAgent
}

/// One row in the sidebar: either a standalone session or a collapsed group header.
public struct SessionListGroup: Identifiable, Hashable, Sendable {
    /// Stable, unique key (`s:<id>`, `ws:<parentId>`, `wt:<worktreeId>`, `meta:<metaId>`).
    /// It is the pagination tie-breaker and the SwiftUI identity, so it must never
    /// depend on which member of the group happened to sync first.
    public let key: String
    public let kind: SessionListGroupKind
    /// Number of rows the group shows when expanded (0 for standalone rows).
    public let childCount: Int
    public let status: AggregatedStatus
    /// Timestamp the sidebar sorts by, aggregated across the whole cached group.
    public let orderTimestamp: Int
    public var id: String { key }
}

public struct SessionListPageItem: Identifiable, Hashable, Sendable {
    public let group: SessionListGroup
    public let parent: SessionListRow
    public var id: String { group.key }
    /// Identity used by the rendered List row, which differs from the SQL group
    /// key for standalone sessions.
    public var rowIdentity: String { group.kind == .standalone ? parent.id : group.key }
}

/// Keyset cursor. Ordering is `(orderTimestamp DESC, groupKey DESC)`; the group key is
/// unique, so pages never overlap or skip even when every row shares a timestamp.
public struct SessionListCursor: Hashable, Sendable {
    public let orderTimestamp: Int
    public let groupKey: String
}

public struct SessionListPage: Sendable {
    public let items: [SessionListPageItem]
    public let nextCursor: SessionListCursor?
    public var hasMore: Bool { nextCursor != nil }
}

public struct SessionListChildPage: Sendable {
    public let rows: [SessionListRow]
    public let nextCursor: SessionListChildCursor?
    public var hasMore: Bool { nextCursor != nil }
}

public struct SessionListChildCursor: Hashable, Sendable {
    public let updatedAt: Int
    public let id: String
}

public struct SessionListFacets: Sendable {
    public let hasArchived: Bool
    public let hasPhaseData: Bool
}

// MARK: - Filter

/// Everything the sidebar filters on, applied in SQL before any row is materialized.
public struct SessionListFilter: Hashable, Sendable {
    public var hostDeviceId: String?
    public var projectId: String
    public var includeArchived: Bool
    public var searchText: String?
    public var phase: PhaseFilter
    public var metaAgentEnabled: Bool

    public init(
        projectId: String,
        includeArchived: Bool = false,
        searchText: String? = nil,
        phase: PhaseFilter = .all,
        metaAgentEnabled: Bool = true,
        hostDeviceId: String? = nil
    ) {
        self.hostDeviceId = hostDeviceId
        self.projectId = projectId
        self.includeArchived = includeArchived
        self.searchText = searchText
        self.phase = phase
        self.metaAgentEnabled = metaAgentEnabled
    }

    /// Filter used to locate a session for a notification, voice action or deep link.
    /// It ignores the user's current view filters: an off-page, archived or
    /// filtered-out session must still be reachable by id.
    public static func locating(projectId: String, metaAgentEnabled: Bool = true) -> SessionListFilter {
        SessionListFilter(
            projectId: projectId,
            includeArchived: true,
            searchText: nil,
            phase: .all,
            metaAgentEnabled: metaAgentEnabled
        )
    }

    /// `nil` when there is nothing to match, otherwise a LIKE pattern with the
    /// wildcards the user typed escaped so they match literally.
    var likePattern: String? {
        guard let text = searchText?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else { return nil }
        let escaped = text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
        return "%\(escaped)%"
    }

    var arguments: [String: (any DatabaseValueConvertible)?] {
        [
            "projectId": projectId,
            "hostDeviceId": hostDeviceId,
            "includeArchived": includeArchived ? 1 : 0,
            "search": likePattern,
            "phase": phase.sqlKey,
            "metaEnabled": metaAgentEnabled ? 1 : 0
        ]
    }
}

// MARK: - SQL

/// The window queries. One CTE body serves the page, the pinned/running exceptions,
/// deep-link resolution and child paging, so all four agree on group membership by
/// construction rather than by four copies of the same rules.
enum SessionListSQL {

    /// Predicates that decide which sessions exist at all for this view. Repeated
    /// inside the parent lookups so a parent hidden by the current filter cannot
    /// silently claim its children (this is what makes search decompose groups the
    /// same way the in-memory grouping did).
    private static func visible(_ alias: String) -> String {
        """
        \(alias).projectId = :projectId
        AND (:hostDeviceId IS NULL OR \(alias).hostDeviceId = :hostDeviceId)
        AND (:includeArchived = 1 OR \(alias).isArchived = 0)
        AND (:search IS NULL OR \(alias).titleDecrypted LIKE :search ESCAPE '\\')
        """
    }

    /// Resolves a parent link (`createdBySessionId` / `parentSessionId`) through the
    /// sessions primary key, so grouping stays a per-row index lookup instead of a
    /// self-join against the whole filtered set.
    private static func parentExists(_ alias: String, matching column: String, predicate: String) -> String {
        """
        EXISTS (
            SELECT 1 FROM sessions \(alias)
            WHERE \(alias).id = b.\(column)
              AND \(predicate)
              AND \(visible(alias))
        )
        """
    }

    /// Assigns a session to exactly one display group. Precedence matches the desktop
    /// list: meta-agent, then workstream, then worktree, then standalone. A session can
    /// only ever belong to one group, so it can never render twice.
    static let groupKeyCase = """
    CASE
        WHEN :metaEnabled = 1 AND b.agentRole = 'meta-agent'
            THEN 'meta:' || b.id
        WHEN :metaEnabled = 1
            AND b.createdBySessionId IS NOT NULL
            AND COALESCE(b.agentRole, '') <> 'meta-agent'
            AND \(parentExists("mp", matching: "createdBySessionId", predicate: "mp.agentRole = 'meta-agent'"))
            THEN 'meta:' || b.createdBySessionId
        WHEN b.sessionType = 'workstream'
            THEN 'ws:' || b.id
        WHEN b.parentSessionId IS NOT NULL
            AND \(parentExists("wp", matching: "parentSessionId", predicate: "wp.sessionType = 'workstream'"))
            THEN 'ws:' || b.parentSessionId
        WHEN b.worktreeId IS NOT NULL
            THEN 'wt:' || b.worktreeId
        ELSE 's:' || b.id
    END
    """

    private static let memberColumns = """
        b.id, b.projectId, b.sessionType, b.agentRole, b.parentSessionId,
        b.createdBySessionId, b.worktreeId, b.isArchived, b.isPinned,
        b.isExecuting, b.hasQueuedPrompts, b.phase, b.createdAt, b.updatedAt,
        b.lastReadAt, b.lastMessageAt
        """

    /// Splits a group key into its kind and anchor (`ws:<parentId>` -> `ws`, `<parentId>`).
    private static func keyParts(_ expression: String) -> String {
        """
        \(expression) AS groupKey,
        substr(\(expression), 1, instr(\(expression), ':') - 1) AS groupKind,
        substr(\(expression), instr(\(expression), ':') + 1) AS anchor
        """
    }

    /// Which groups this query is about. Everything downstream is driven by this set,
    /// so the cost of grouping is a function of the page — not of total history.
    enum KeySource {
        /// The newest rows the filter allows, capped. A group whose ordering timestamp
        /// is at or above the cap boundary always has a member in here, because that
        /// timestamp IS one of its members' `updatedAt`.
        case recent
        /// Rows needing attention (running, queued, pinned) anywhere in history.
        case attention
        /// The group containing one specific session, for deep links.
        case session
        /// One known group key, for child paging and bulk actions.
        case explicit
    }

    private static func keysCTE(_ source: KeySource, keysetPrefilter: Bool) -> String {
        switch source {
        case .recent, .attention:
            let attention = source == .attention
                ? "AND (b.isExecuting = 1 OR b.hasQueuedPrompts = 1 OR b.isPinned = 1)"
                : ""
            let keyset = keysetPrefilter ? "AND b.updatedAt <= :cursorTs" : ""
            return """
            candidate AS (
                SELECT \(groupKeyCase) AS groupKey
                FROM sessions b
                WHERE \(visible("b")) \(attention) \(keyset)
                ORDER BY b.updatedAt DESC, b.id DESC
                LIMIT :candidateLimit
            ),
            keys AS (
                SELECT DISTINCT \(keyParts("groupKey")) FROM candidate
            )
            """
        case .session:
            return """
            keys AS (
                SELECT \(keyParts("groupKey")) FROM (
                    SELECT \(groupKeyCase) AS groupKey FROM sessions b
                    WHERE b.id = :focusId AND \(visible("b"))
                )
            )
            """
        case .explicit:
            return """
            keys AS (
                SELECT \(keyParts("groupKey")) FROM (SELECT :groupKey AS groupKey)
            )
            """
        }
    }

    /// Full membership of the chosen groups, reached through indexed links rather than
    /// by classifying every session in the project. Each branch drives from the small
    /// `keys` set into `sessions` on an indexed column.
    private static let memberCTE = """
    member AS (
        SELECT
            x.*,
            substr(x.groupKey, 1, instr(x.groupKey, ':') - 1) AS groupKind,
            CASE
                WHEN substr(x.groupKey, 1, instr(x.groupKey, ':') - 1) = 'wt' THEN NULL
                ELSE substr(x.groupKey, instr(x.groupKey, ':') + 1)
            END AS anchorId
        FROM (
            SELECT \(memberColumns), \(groupKeyCase) AS groupKey FROM sessions b
            WHERE \(visible("b")) AND b.id IN (SELECT anchor FROM keys WHERE groupKind <> 'wt')
            UNION
            SELECT \(memberColumns), \(groupKeyCase) AS groupKey FROM sessions b
            WHERE \(visible("b")) AND b.parentSessionId IN (SELECT anchor FROM keys WHERE groupKind = 'ws')
            UNION
            SELECT \(memberColumns), \(groupKeyCase) AS groupKey FROM sessions b
            WHERE \(visible("b")) AND b.createdBySessionId IN (SELECT anchor FROM keys WHERE groupKind = 'meta')
            UNION
            SELECT \(memberColumns), \(groupKeyCase) AS groupKey FROM sessions b
            WHERE \(visible("b")) AND b.worktreeId IN (SELECT anchor FROM keys WHERE groupKind = 'wt')
        ) x
        -- A row reached through a link may resolve to a DIFFERENT group (a workstream
        -- child that is itself a meta-agent sub-agent, say). Only rows that actually
        -- resolve to one of the requested keys are members of it.
        WHERE x.groupKey IN (SELECT groupKey FROM keys)
    )
    """

    /// Per-member derived flags, kept out of the aggregate so each expression is written once.
    private static let memberFlags = """
        CASE WHEN groupKind IN ('ws', 'meta') AND id <> anchorId THEN 1
             WHEN groupKind = 'wt' THEN 1
             ELSE 0 END AS isDisplayChild,
        CASE WHEN groupKind = 'ws' AND id = anchorId THEN 1 ELSE 0 END AS isWorkstreamParent,
        CASE WHEN lastMessageAt IS NOT NULL AND lastMessageAt > 0
                  AND (lastReadAt IS NULL OR lastMessageAt > lastReadAt)
             THEN 1 ELSE 0 END AS isUnread,
        CASE :phase
            WHEN 'all' THEN 1
            WHEN 'active' THEN CASE WHEN phase IN ('implementing', 'validating') THEN 1 ELSE 0 END
            WHEN 'planning' THEN CASE WHEN phase IN ('planning', 'backlog') THEN 1 ELSE 0 END
            WHEN 'complete' THEN CASE WHEN phase = 'complete' THEN 1 ELSE 0 END
            ELSE 1
        END AS phaseMatch
        """

    /// Group-level aggregates over the COMPLETE cached group.
    ///
    /// `orderTs` deliberately ignores a workstream parent's own `updatedAt` when the
    /// workstream has children, because a container row's timestamp is not activity —
    /// this reproduces `WorkstreamGroup.latestUpdate`.
    ///
    /// `parentId` for a worktree is the oldest member (createdAt, then id), so the
    /// header identity does not depend on which member synced first.
    private static let groupedCTE = """
    grouped AS (
        SELECT
            groupKey,
            groupKind,
            COALESCE(
                MAX(CASE WHEN isWorkstreamParent = 0 THEN updatedAt END),
                MAX(updatedAt)
            ) AS orderTs,
            COALESCE(
                MIN(anchorId),
                substr(MIN(printf('%020d|%s', createdAt, id)), 22)
            ) AS parentId,
            COUNT(*) AS memberCount,
            SUM(isDisplayChild) AS displayChildCount,
            MAX(isExecuting) AS allExecuting,
            MAX(hasQueuedPrompts) AS allQueued,
            MAX(CASE WHEN isExecuting = 1 AND hasQueuedPrompts = 1 THEN 1 ELSE 0 END) AS allWaiting,
            MAX(isUnread) AS allUnread,
            MAX(isPinned) AS anyPinned,
            MAX(phaseMatch) AS anyPhaseMatch,
            MAX(CASE WHEN isDisplayChild = 1 THEN isExecuting END) AS childExecuting,
            MAX(CASE WHEN isDisplayChild = 1 THEN hasQueuedPrompts END) AS childQueued,
            MAX(CASE WHEN isDisplayChild = 1 AND isExecuting = 1 AND hasQueuedPrompts = 1 THEN 1
                     WHEN isDisplayChild = 1 THEN 0 END) AS childWaiting,
            MAX(CASE WHEN isDisplayChild = 1 THEN isUnread END) AS childUnread,
            MAX(CASE WHEN isDisplayChild = 1 THEN phaseMatch END) AS childPhaseMatch
        FROM (SELECT *, \(memberFlags) FROM member)
        GROUP BY groupKey, groupKind
    )
    """

    /// Child count as the list displays it: a single-session worktree renders as one
    /// plain row (no children), every other worktree lists all of its members.
    private static let childCountExpr = """
    CASE g.groupKind
        WHEN 'wt' THEN CASE WHEN g.memberCount > 1 THEN g.memberCount ELSE 0 END
        ELSE g.displayChildCount
    END
    """

    /// Aggregate status set: a workstream WITH children reports its children's status
    /// (the container row itself is never executing); everything else reports across
    /// all of its members, matching `computeAggregatedStatus` at each call site.
    private static func statusExpr(_ all: String, _ child: String) -> String {
        "CASE WHEN g.groupKind = 'ws' AND g.displayChildCount > 0 THEN COALESCE(g.\(child), 0) ELSE COALESCE(g.\(all), 0) END"
    }

    /// A group passes the phase filter when one of its displayed children matches
    /// (`PhaseFilter.matchesGroup`); meta-agent groups are never phase-filtered, and a
    /// standalone row matches on its own phase.
    private static let phasePassExpr = """
    CASE
        WHEN :phase = 'all' THEN 1
        WHEN g.groupKind = 'meta' THEN 1
        WHEN g.groupKind = 's' THEN COALESCE(g.anyPhaseMatch, 0)
        WHEN g.groupKind = 'wt' THEN CASE WHEN g.memberCount > 1 THEN COALESCE(g.childPhaseMatch, 0) ELSE 0 END
        ELSE COALESCE(g.childPhaseMatch, 0)
    END
    """

    /// Shared shape for the page / exceptions / deep-link queries: one key source, the
    /// same grouping, keyset pagination and a hard LIMIT.
    static func groupQuery(source: KeySource, keyset: Bool) -> String {
        var predicates = ["(\(phasePassExpr)) = 1"]
        if source == .attention {
            predicates.append("(COALESCE(g.allExecuting, 0) = 1 OR COALESCE(g.allQueued, 0) = 1 OR COALESCE(g.anyPinned, 0) = 1)")
        }
        if keyset {
            predicates.append("(g.orderTs < :cursorTs OR (g.orderTs = :cursorTs AND g.groupKey < :cursorKey))")
        }
        return """
        WITH \(keysCTE(source, keysetPrefilter: keyset)),
        \(memberCTE),
        \(groupedCTE)
        SELECT
            g.groupKey, g.groupKind, g.orderTs,
            \(childCountExpr) AS childCount,
            \(statusExpr("allExecuting", "childExecuting")) AS statusExecuting,
            \(statusExpr("allQueued", "childQueued")) AS statusQueued,
            \(statusExpr("allWaiting", "childWaiting")) AS statusWaiting,
            \(statusExpr("allUnread", "childUnread")) AS statusUnread,
            \(SessionListRow.selectList(alias: "p", prefix: "p_"))
        FROM grouped g
        JOIN sessions p ON p.id = g.parentId
        WHERE \(predicates.joined(separator: " AND "))
        ORDER BY g.orderTs DESC, g.groupKey DESC
        LIMIT :limit
        """
    }

    /// The `updatedAt` of the last row the candidate cap would admit, or NULL when the
    /// cap covers everything the filter matches. Any group missing from a capped page
    /// has an ordering timestamp strictly below this, which is what makes a capped page
    /// provably exact (see `SessionListQueryRunner.fetchGroups`).
    static func candidateBoundaryQuery(attention: Bool, keyset: Bool) -> String {
        """
        SELECT b.updatedAt FROM sessions b
        WHERE \(visible("b"))
          \(attention ? "AND (b.isExecuting = 1 OR b.hasQueuedPrompts = 1 OR b.isPinned = 1)" : "")
          \(keyset ? "AND b.updatedAt <= :cursorTs" : "")
        ORDER BY b.updatedAt DESC, b.id DESC
        LIMIT 1 OFFSET :candidateOffset
        """
    }

    /// Children of one group, newest first, keyset-paged. Reuses the same membership
    /// rules so an expanded group can never disagree with the collapsed header.
    static func childrenQuery(keyset: Bool) -> String {
        var predicates = [
            "(m.groupKind = 'wt' OR m.id <> m.anchorId)"
        ]
        if keyset {
            predicates.append("(m.updatedAt < :cursorUpdatedAt OR (m.updatedAt = :cursorUpdatedAt AND m.id < :cursorId))")
        }
        return """
        WITH \(keysCTE(.explicit, keysetPrefilter: false)),
        \(memberCTE)
        SELECT \(SessionListRow.selectList(alias: "s"))
        FROM member m
        JOIN sessions s ON s.id = m.id
        WHERE \(predicates.joined(separator: " AND "))
        ORDER BY m.updatedAt DESC, m.id DESC
        LIMIT :limit
        """
    }

    static let memberIdsQuery = """
    WITH \(keysCTE(.explicit, keysetPrefilter: false)),
    \(memberCTE)
    SELECT m.id FROM member m
    """
}

// MARK: - Queries

public extension DatabaseManager {

    /// One bounded page of sidebar rows, newest first, from the persisted group
    /// projection when it covers the filter.
    func sessionListPage(
        filter: SessionListFilter,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        try writer.read { db in
            try SessionListQueryRunner.page(db, filter: filter, after: cursor, limit: limit)
        }
    }

    /// The same page computed by re-deriving grouping from `sessions`, bypassing the
    /// projection. This is the fallback path for search and archives, and the reference
    /// the projection is asserted against in `SessionListProjectionTests`.
    func sessionListPageLive(
        filter: SessionListFilter,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        try writer.read { db in
            try SessionListQueryRunner.liveGroups(db, filter: filter, source: .recent, after: cursor, limit: limit)
        }
    }

    /// Running, waiting and pinned rows, which stay reachable no matter how far the
    /// user has (or has not) paged. Bounded and paged in its own right.
    func sessionListExceptions(
        filter: SessionListFilter,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        try writer.read { db in
            try SessionListQueryRunner.exceptions(db, filter: filter, after: cursor, limit: limit)
        }
    }

    /// The display row that contains `sessionId` — the session itself when it is
    /// standalone, otherwise its group header. Used for notifications and deep links.
    func sessionListItem(containing sessionId: String, filter: SessionListFilter) throws -> SessionListPageItem? {
        try writer.read { db in
            try SessionListQueryRunner.item(db, containing: sessionId, filter: filter)
        }
    }

    func sessionListChildren(
        filter: SessionListFilter,
        groupKey: String,
        after cursor: SessionListChildCursor?,
        limit: Int
    ) throws -> SessionListChildPage {
        try writer.read { db in
            try SessionListQueryRunner.children(db, filter: filter, groupKey: groupKey, after: cursor, limit: limit)
        }
    }

    /// Every member of a group, for bulk archive/delete. Bounded by group size, which
    /// is inherent to the action rather than to how much history exists.
    func sessionListGroupMemberIds(filter: SessionListFilter, groupKey: String) throws -> [String] {
        try writer.read { db in
            try SessionListQueryRunner.memberIds(db, filter: filter, groupKey: groupKey)
        }
    }

    /// Existence of archives and phase data, queried independently of the page so the
    /// toolbar toggles do not depend on how far the user has scrolled.
    func sessionListFacets(projectId: String) throws -> SessionListFacets {
        try writer.read { db in
            try SessionListQueryRunner.facets(db, projectId: projectId)
        }
    }

    /// Workstream parents for the "Move to Workstream" menu, newest first and capped.
    func workstreamParents(projectId: String, limit: Int, after cursor: SessionListChildCursor? = nil) throws -> [SessionListRow] {
        try writer.read { db in
            try SessionListQueryRunner.workstreamParents(db, projectId: projectId, limit: limit, after: cursor)
        }
    }

    /// `EXPLAIN QUERY PLAN` for the page query actually used for this filter.
    func sessionListPageQueryPlan(filter: SessionListFilter, limit: Int) throws -> String {
        guard try writer.read({ try SessionListQueryRunner.usesProjection($0, filter) }) else {
            return try sessionListQueryPlan(filter: filter, limit: limit)
        }
        return try writer.read { db in
            try Row.fetchAll(db, sql: """
                EXPLAIN QUERY PLAN
                SELECT g.groupKey, \(SessionListRow.selectList(alias: "p", prefix: "p_"))
                FROM sessionListGroups g
                JOIN sessions p ON p.id = g.parentId
                WHERE g.projectId = :projectId
                ORDER BY g.orderTimestamp DESC, g.groupKey DESC
                LIMIT :limit
                """, arguments: ["projectId": filter.projectId, "limit": limit])
                .map { ($0["detail"] as String?) ?? "" }
                .joined(separator: "\n")
        }
    }

    /// `EXPLAIN QUERY PLAN` for the live fallback query, so its index coverage is testable.
    func sessionListQueryPlan(filter: SessionListFilter, limit: Int) throws -> String {
        try writer.read { db in
            let sql = SessionListSQL.groupQuery(source: .recent, keyset: false)
            var arguments = filter.arguments
            arguments["limit"] = limit
            arguments["candidateLimit"] = max(limit * SessionListQueryRunner.candidateFanout,
                                              SessionListQueryRunner.minimumCandidates)
            let rows = try Row.fetchAll(db, sql: "EXPLAIN QUERY PLAN \(sql)",
                                        arguments: StatementArguments(arguments))
            return rows.map { ($0["detail"] as String?) ?? "" }.joined(separator: "\n")
        }
    }
}

/// The statement bodies, split out so `ValueObservation` can run the whole window in
/// one read without going back through `DatabaseManager`.
enum SessionListQueryRunner {

    /// Whether the persisted group projection can answer this filter. The projected
    /// path is `LIMIT n` off an ordered index; the live path re-derives grouping and is
    /// bounded by the size of the groups on the page.
    static func usesProjection(_ db: Database, _ filter: SessionListFilter) throws -> Bool {
        try SessionListProjection.covers(
            filter,
            builtForMetaAgentEnabled: SessionListProjection.builtForMetaAgentEnabled(db, projectId: filter.projectId)
        )
    }

    static func page(
        _ db: Database,
        filter: SessionListFilter,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        if try usesProjection(db, filter) {
            return try SessionListProjection.page(db, filter: filter, attentionOnly: false,
                                                  after: cursor, limit: limit)
        }
        return try fetchGroups(db, filter: filter, source: .recent, after: cursor, limit: limit)
    }

    static func exceptions(
        _ db: Database,
        filter: SessionListFilter,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        if try usesProjection(db, filter) {
            return try SessionListProjection.page(db, filter: filter, attentionOnly: true,
                                                  after: cursor, limit: limit)
        }
        return try fetchGroups(db, filter: filter, source: .attention, after: cursor, limit: limit)
    }

    static func item(_ db: Database, containing sessionId: String, filter: SessionListFilter) throws -> SessionListPageItem? {
        if try usesProjection(db, filter) {
            return try SessionListProjection.item(db, containing: sessionId, filter: filter)
        }
        let sql = SessionListSQL.groupQuery(source: .session, keyset: false)
        var arguments = filter.arguments
        arguments["focusId"] = sessionId
        arguments["limit"] = 1
        let rows = try Row.fetchAll(db, sql: sql, arguments: StatementArguments(arguments))
        return rows.first.map(makeItem)
    }

    static func children(
        _ db: Database,
        filter: SessionListFilter,
        groupKey: String,
        after cursor: SessionListChildCursor?,
        limit: Int
    ) throws -> SessionListChildPage {
        if try usesProjection(db, filter) {
            return try SessionListProjection.children(db, filter: filter, groupKey: groupKey,
                                                      after: cursor, limit: limit)
        }
        let sql = SessionListSQL.childrenQuery(keyset: cursor != nil)
        var arguments = filter.arguments
        arguments["groupKey"] = groupKey
        arguments["limit"] = limit + 1
        if let cursor {
            arguments["cursorUpdatedAt"] = cursor.updatedAt
            arguments["cursorId"] = cursor.id
        }
        let rows = try Row.fetchAll(db, sql: sql, arguments: StatementArguments(arguments))
            .map { SessionListRow(row: $0) }
        let page = Array(rows.prefix(limit))
        return SessionListChildPage(
            rows: page,
            nextCursor: rows.count > limit
                ? page.last.map { SessionListChildCursor(updatedAt: $0.updatedAt, id: $0.id) }
                : nil
        )
    }

    static func memberIds(_ db: Database, filter: SessionListFilter, groupKey: String) throws -> [String] {
        if try usesProjection(db, filter) {
            return try SessionListProjection.memberIds(db, projectId: filter.projectId, groupKey: groupKey)
        }
        // Bulk archive/delete uses the locating filter, which includes archives and so
        // always lands here: the projection deliberately does not cover archived rows,
        // and an action on a group must reach every member of it.
        var arguments = filter.arguments
        arguments["groupKey"] = groupKey
        return try String.fetchAll(db, sql: SessionListSQL.memberIdsQuery,
                                   arguments: StatementArguments(arguments))
    }

    static func facets(_ db: Database, projectId: String) throws -> SessionListFacets {
        let row = try Row.fetchOne(db, sql: """
            SELECT
                EXISTS (SELECT 1 FROM sessions WHERE projectId = :projectId AND isArchived = 1) AS hasArchived,
                EXISTS (SELECT 1 FROM sessions WHERE projectId = :projectId AND phase IS NOT NULL AND phase <> '') AS hasPhaseData
            """, arguments: ["projectId": projectId])
        return SessionListFacets(
            hasArchived: (row?["hasArchived"] as Bool?) ?? false,
            hasPhaseData: (row?["hasPhaseData"] as Bool?) ?? false
        )
    }

    static func workstreamParents(_ db: Database, projectId: String, limit: Int, after cursor: SessionListChildCursor? = nil) throws -> [SessionListRow] {
        let keyset = cursor == nil ? "" : "AND (s.updatedAt < :afterTime OR (s.updatedAt = :afterTime AND s.id < :afterId))"
        var arguments: [String: (any DatabaseValueConvertible)?] = ["projectId": projectId, "limit": limit]
        if let cursor {
            arguments["afterTime"] = cursor.updatedAt
            arguments["afterId"] = cursor.id
        }
        return try Row.fetchAll(db, sql: """
            SELECT \(SessionListRow.selectList(alias: "s"))
            FROM sessions s
            WHERE s.projectId = :projectId AND s.sessionType = 'workstream' \(keyset)
            ORDER BY s.updatedAt DESC, s.id DESC
            LIMIT :limit
            """, arguments: StatementArguments(arguments))
            .map { SessionListRow(row: $0) }
    }

    // MARK: - Shared

    /// How many of the newest rows a page is allowed to classify before it is
    /// considered inconclusive. `pageLimit * fanout` assumes an average group is
    /// smaller than `fanout` rows; when it is not, `fetchGroups` widens and retries
    /// instead of returning a short page.
    static let candidateFanout = 8
    static let minimumCandidates = 200
    private static let maximumWidenAttempts = 3

    static func liveGroups(
        _ db: Database,
        filter: SessionListFilter,
        source: SessionListSQL.KeySource,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        try fetchGroups(db, filter: filter, source: source, after: cursor, limit: limit)
    }

    private static func fetchGroups(
        _ db: Database,
        filter: SessionListFilter,
        source: SessionListSQL.KeySource,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        let sql = SessionListSQL.groupQuery(source: source, keyset: cursor != nil)
        var candidateLimit = max(limit * candidateFanout, minimumCandidates)

        for attempt in 0...maximumWidenAttempts {
            // Last attempt: classify everything the filter matches. Slower, but it can
            // never return a short page, so widening always terminates in a correct result.
            let uncapped = attempt == maximumWidenAttempts
            var arguments = filter.arguments
            // One extra row tells us whether another page exists without a COUNT(*).
            arguments["limit"] = limit + 1
            arguments["candidateLimit"] = uncapped ? -1 : candidateLimit
            if let cursor {
                arguments["cursorTs"] = cursor.orderTimestamp
                arguments["cursorKey"] = cursor.groupKey
            }
            let items = try Row.fetchAll(db, sql: sql, arguments: StatementArguments(arguments)).map(makeItem)

            // A group that the cap missed has every member older than the boundary row,
            // so its ordering timestamp is below it too. Once we hold a full page of
            // groups at or above the boundary, no missed group can belong in that page.
            if !uncapped, items.count <= limit,
               let boundary = try candidateBoundary(db, filter: filter, source: source,
                                                    cursor: cursor, candidateLimit: candidateLimit),
               items.filter({ $0.group.orderTimestamp >= boundary }).count < limit {
                candidateLimit *= 4
                continue
            }

            let page = Array(items.prefix(limit))
            return SessionListPage(
                items: page,
                nextCursor: items.count > limit
                    ? page.last.map { SessionListCursor(orderTimestamp: $0.group.orderTimestamp, groupKey: $0.group.key) }
                    : nil
            )
        }
        return SessionListPage(items: [], nextCursor: nil)
    }

    /// `updatedAt` of the last row inside the candidate cap, or nil when the cap is
    /// wider than the filtered history (in which case the page is already exact).
    private static func candidateBoundary(
        _ db: Database,
        filter: SessionListFilter,
        source: SessionListSQL.KeySource,
        cursor: SessionListCursor?,
        candidateLimit: Int
    ) throws -> Int? {
        var arguments = filter.arguments
        arguments["candidateOffset"] = candidateLimit - 1
        if let cursor { arguments["cursorTs"] = cursor.orderTimestamp }
        return try Int.fetchOne(
            db,
            sql: SessionListSQL.candidateBoundaryQuery(attention: source == .attention, keyset: cursor != nil),
            arguments: StatementArguments(arguments)
        )
    }

    static func makeItem(_ row: Row) -> SessionListPageItem {
        let kind: SessionListGroupKind = switch (row["groupKind"] as String?) ?? "s" {
        case "ws": .workstream
        case "wt": .worktree
        case "meta": .metaAgent
        default: .standalone
        }
        let group = SessionListGroup(
            key: row["groupKey"],
            kind: kind,
            childCount: (row["childCount"] as Int?) ?? 0,
            status: status(
                executing: (row["statusExecuting"] as Bool?) ?? false,
                queued: (row["statusQueued"] as Bool?) ?? false,
                waiting: (row["statusWaiting"] as Bool?) ?? false,
                unread: (row["statusUnread"] as Bool?) ?? false
            ),
            orderTimestamp: (row["orderTs"] as Int?) ?? 0
        )
        return SessionListPageItem(group: group, parent: SessionListRow(row: row, prefix: "p_"))
    }

    /// Same precedence as `computeAggregatedStatus`, applied to SQL aggregates.
    private static func status(executing: Bool, queued: Bool, waiting: Bool, unread: Bool) -> AggregatedStatus {
        if waiting { return .waitingForInput }
        if executing { return .processing }
        if queued { return .pendingPrompt }
        if unread { return .unread }
        return .idle
    }
}
