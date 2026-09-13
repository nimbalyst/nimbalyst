import Foundation
import GRDB

/// A persisted, derived projection of the sidebar's display groups.
///
/// Why it exists: resolving hierarchy in SQL bounds the *result* to one page, but not
/// the *work*. A group's ordering timestamp, child count and aggregate status are
/// defined over its complete membership, so a project whose history sits inside a
/// handful of large groups made every read re-aggregate most of the table (measured:
/// 93.8 ms at 10,000 sessions, against 6.8 ms at 1,000 — superlinear, and paid on
/// every database change).
///
/// The projection moves that aggregation to write time and keeps it incremental:
///
/// - `sessionListGroupMembers` holds one row per session with the facts grouping needs,
///   already resolved to a group key.
/// - `sessionListGroups` holds one row per display group — exactly what the sidebar
///   renders — so a page is `LIMIT 100` off an ordered index.
/// - `sessionListGroupDirty` is filled by triggers on `sessions`. **Any** writer
///   (index ingestion, live broadcasts, the UI) invalidates the projection without
///   knowing it exists, so no other slice has to call anything.
///
/// Scope: the projection covers the default view only — unarchived sessions, at the
/// current meta-agent flag. Browsing archives, searching, or flipping that flag falls
/// back to the live query in `SessionListSQL`, which is correct but unbounded. Those
/// are user-initiated and rare; the projected path is the one that runs on every
/// database change.
///
/// It is derived data: `rebuild` recreates it from `sessions` at any time, and a
/// mismatched marker forces exactly that. Nothing here is a source of truth.
enum SessionListProjection {

    static let liveScopeMarker = "live"

    // MARK: - Schema

    /// Bump whenever a projection table, index, or trigger changes shape. The migrator
    /// only records that the projection migration ran, and every statement below is
    /// `IF NOT EXISTS`, so an install that ran an earlier shape would otherwise keep
    /// its old triggers forever with nothing to detect it. Release builds have no
    /// erase-on-change rescue.
    static let schemaVersion = 1

    /// Registered from `DatabaseManager.migrate` and run again on every open. Creates
    /// the projection objects, or drops and recreates them when the recorded shape
    /// differs. Only derived data is touched; every cached session row is kept.
    static func ensureSchema(_ db: Database) throws {
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS sessionListProjectionSchema (
                version INTEGER NOT NULL
            )
            """)
        let recorded = try Int.fetchOne(db, sql: "SELECT version FROM sessionListProjectionSchema")
        if recorded == schemaVersion { return }
        try dropObjects(db)
        try createObjects(db)
        try db.execute(sql: "DELETE FROM sessionListProjectionSchema")
        try db.execute(sql: "INSERT INTO sessionListProjectionSchema(version) VALUES (?)",
                       arguments: [schemaVersion])
    }

    /// Removes every projection object regardless of which shape created it, so a
    /// trigger from an earlier build cannot survive by name. Indexes go with their
    /// tables, and dropping `sessionListGroupState` makes the next refresh a rebuild.
    private static func dropObjects(_ db: Database) throws {
        let triggers = try String.fetchAll(
            db, sql: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg\\_slg\\_%' ESCAPE '\\'")
        for trigger in triggers {
            try db.execute(sql: "DROP TRIGGER IF EXISTS \"\(trigger)\"")
        }
        let tables = try String.fetchAll(
            db, sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sessionListGroup%'")
        for table in tables {
            try db.execute(sql: "DROP TABLE IF EXISTS \"\(table)\"")
        }
    }

    private static func createObjects(_ db: Database) throws {
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS sessionListGroupMembers (
                sessionId TEXT NOT NULL,
                projectId TEXT NOT NULL,
                groupKey TEXT NOT NULL,
                groupKind TEXT NOT NULL,
                anchorId TEXT,
                isDisplayChild INTEGER NOT NULL,
                isWorkstreamParent INTEGER NOT NULL,
                createdAt INTEGER NOT NULL,
                updatedAt INTEGER NOT NULL,
                isExecuting INTEGER NOT NULL,
                hasQueuedPrompts INTEGER NOT NULL,
                isUnread INTEGER NOT NULL,
                isPinned INTEGER NOT NULL,
                phaseActive INTEGER NOT NULL,
                phasePlanning INTEGER NOT NULL,
                phaseComplete INTEGER NOT NULL,
                PRIMARY KEY (projectId, groupKey, sessionId)
            )
            """)
        // These tables need rowids: SQLite update hooks do not report writes to
        // WITHOUT ROWID tables, so GRDB would miss projection refreshes and leave
        // an observed sidebar stale even after the database has converged.
        try db.execute(sql: """
            CREATE INDEX IF NOT EXISTS idx_slgm_session
            ON sessionListGroupMembers(projectId, sessionId)
            """)
        try db.execute(sql: """
            CREATE INDEX IF NOT EXISTS idx_slgm_children
            ON sessionListGroupMembers(projectId, groupKey, updatedAt DESC, sessionId DESC)
            """)

        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS sessionListGroups (
                groupKey TEXT NOT NULL,
                projectId TEXT NOT NULL,
                groupKind TEXT NOT NULL,
                parentId TEXT NOT NULL,
                orderTimestamp INTEGER NOT NULL,
                childCount INTEGER NOT NULL,
                memberCount INTEGER NOT NULL,
                statusExecuting INTEGER NOT NULL,
                statusQueued INTEGER NOT NULL,
                statusWaiting INTEGER NOT NULL,
                statusUnread INTEGER NOT NULL,
                anyPinned INTEGER NOT NULL,
                needsAttention INTEGER NOT NULL,
                passActive INTEGER NOT NULL,
                passPlanning INTEGER NOT NULL,
                passComplete INTEGER NOT NULL,
                -- Scoped by project: a worktree id is only unique within a project, so
                -- a bare group key could merge two projects' worktree groups.
                PRIMARY KEY (projectId, groupKey)
            )
            """)
        try db.execute(sql: """
            CREATE INDEX IF NOT EXISTS idx_slg_order
            ON sessionListGroups(projectId, orderTimestamp DESC, groupKey DESC)
            """)
        // Running / queued / pinned groups are reachable from anywhere in history, so
        // they get their own partial index instead of scanning the ordered one.
        try db.execute(sql: """
            CREATE INDEX IF NOT EXISTS idx_slg_attention
            ON sessionListGroups(projectId, orderTimestamp DESC, groupKey DESC)
            WHERE needsAttention = 1
            """)

        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS sessionListGroupDirty (
                sessionId TEXT NOT NULL,
                projectId TEXT NOT NULL,
                PRIMARY KEY (projectId, sessionId)
            )
            """)
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS sessionListGroupTouched (
                groupKey TEXT PRIMARY KEY
            )
            """)
        // One marker row per project, recording which grouping the projection was
        // built for. A mismatch is a rebuild, never a silently wrong list.
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS sessionListGroupState (
                projectId TEXT PRIMARY KEY,
                metaAgentEnabled INTEGER NOT NULL
            )
            """)

        try createTriggers(db)
    }

    /// Triggers only record *which* sessions changed — they never aggregate. That keeps
    /// the cost inside a bulk index-ingestion transaction to one small insert per row,
    /// while still guaranteeing no writer can leave the projection silently stale.
    private static func createTriggers(_ db: Database) throws {
        let groupingFields = ["projectId", "parentSessionId", "createdBySessionId", "worktreeId",
                              "agentRole", "sessionType", "isArchived", "phase", "isPinned",
                              "isExecuting", "hasQueuedPrompts", "createdAt", "updatedAt",
                              "lastReadAt", "lastMessageAt"]
        let changed = groupingFields.map { "old.\($0) IS NOT new.\($0)" }.joined(separator: " OR ")
        try db.execute(sql: """
            CREATE TRIGGER IF NOT EXISTS trg_slg_dirty_insert AFTER INSERT ON sessions BEGIN
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                VALUES (new.id, new.projectId);
                -- A parent arriving after its children re-homes them.
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                    SELECT id, projectId FROM sessions
                    WHERE parentSessionId = new.id;
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                    SELECT id, projectId FROM sessions WHERE createdBySessionId = new.id;
            END
            """)
        try db.execute(sql: """
            CREATE TRIGGER IF NOT EXISTS trg_slg_dirty_delete AFTER DELETE ON sessions BEGIN
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                VALUES (old.id, old.projectId);
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                    SELECT id, projectId FROM sessions
                    WHERE parentSessionId = old.id;
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                    SELECT id, projectId FROM sessions WHERE createdBySessionId = old.id;
            END
            """)
        try db.execute(sql: """
            CREATE TRIGGER IF NOT EXISTS trg_slg_dirty_update AFTER UPDATE ON sessions
            WHEN \(changed) BEGIN
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                VALUES (new.id, new.projectId);
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                    SELECT old.id, old.projectId WHERE old.projectId IS NOT new.projectId;
            END
            """)
        // Only the fields that decide whether a parent can claim children re-home the
        // children; ordinary activity updates do not drag a whole group in with them.
        try db.execute(sql: """
            CREATE TRIGGER IF NOT EXISTS trg_slg_dirty_reparent
            AFTER UPDATE OF isArchived, sessionType, agentRole, projectId ON sessions
            WHEN old.isArchived IS NOT new.isArchived OR old.sessionType IS NOT new.sessionType
                OR old.agentRole IS NOT new.agentRole OR old.projectId IS NOT new.projectId BEGIN
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                    SELECT id, projectId FROM sessions
                    WHERE parentSessionId = new.id;
                INSERT OR REPLACE INTO sessionListGroupDirty(sessionId, projectId)
                    SELECT id, projectId FROM sessions WHERE createdBySessionId = new.id;
            END
            """)
    }

    // MARK: - Member facts

    /// Visibility for the projected scope: unarchived sessions in this project.
    private static func visible(_ alias: String) -> String {
        "\(alias).projectId = :projectId AND \(alias).isArchived = 0"
    }

    private static func parentExists(_ alias: String, matching column: String, predicate: String) -> String {
        """
        EXISTS (
            SELECT 1 FROM sessions \(alias)
            WHERE \(alias).id = b.\(column) AND \(predicate) AND \(visible(alias))
        )
        """
    }

    /// Same precedence as `SessionListSQL.groupKeyCase`, specialised to the projected
    /// scope. `SessionListProjectionParityTests` asserts the two agree.
    private static var groupKeyCase: String {
        """
        CASE
            WHEN :metaEnabled = 1 AND b.agentRole = 'meta-agent' THEN 'meta:' || b.id
            WHEN :metaEnabled = 1
                AND b.createdBySessionId IS NOT NULL
                AND COALESCE(b.agentRole, '') <> 'meta-agent'
                AND \(parentExists("mp", matching: "createdBySessionId", predicate: "mp.agentRole = 'meta-agent'"))
                THEN 'meta:' || b.createdBySessionId
            WHEN b.sessionType = 'workstream' THEN 'ws:' || b.id
            WHEN b.parentSessionId IS NOT NULL
                AND \(parentExists("wp", matching: "parentSessionId", predicate: "wp.sessionType = 'workstream'"))
                THEN 'ws:' || b.parentSessionId
            WHEN b.worktreeId IS NOT NULL THEN 'wt:' || b.worktreeId
            ELSE 's:' || b.id
        END
        """
    }

    /// Resolve member facts for a set of sessions. `restriction` narrows it to the
    /// dirty batch for an incremental refresh, or to everything for a rebuild.
    private static func memberInsert(restriction: String) -> String {
        """
        INSERT INTO sessionListGroupMembers (
            sessionId, projectId, groupKey, groupKind, anchorId,
            isDisplayChild, isWorkstreamParent, createdAt, updatedAt,
            isExecuting, hasQueuedPrompts, isUnread, isPinned,
            phaseActive, phasePlanning, phaseComplete
        )
        SELECT
            k.id, k.projectId, k.groupKey,
            substr(k.groupKey, 1, instr(k.groupKey, ':') - 1),
            CASE WHEN substr(k.groupKey, 1, instr(k.groupKey, ':') - 1) = 'wt' THEN NULL
                 ELSE substr(k.groupKey, instr(k.groupKey, ':') + 1) END,
            CASE
                WHEN substr(k.groupKey, 1, instr(k.groupKey, ':') - 1) = 'wt' THEN 1
                WHEN substr(k.groupKey, 1, instr(k.groupKey, ':') - 1) IN ('ws', 'meta')
                     AND k.id <> substr(k.groupKey, instr(k.groupKey, ':') + 1) THEN 1
                ELSE 0
            END,
            CASE WHEN substr(k.groupKey, 1, instr(k.groupKey, ':') - 1) = 'ws'
                      AND k.id = substr(k.groupKey, instr(k.groupKey, ':') + 1) THEN 1 ELSE 0 END,
            k.createdAt, k.updatedAt,
            k.isExecuting, k.hasQueuedPrompts,
            CASE WHEN k.lastMessageAt IS NOT NULL AND k.lastMessageAt > 0
                      AND (k.lastReadAt IS NULL OR k.lastMessageAt > k.lastReadAt)
                 THEN 1 ELSE 0 END,
            k.isPinned,
            CASE WHEN k.phase IN ('implementing', 'validating') THEN 1 ELSE 0 END,
            CASE WHEN k.phase IN ('planning', 'backlog') THEN 1 ELSE 0 END,
            CASE WHEN k.phase = 'complete' THEN 1 ELSE 0 END
        FROM (
            SELECT b.id, b.projectId, b.createdAt, b.updatedAt, b.isExecuting,
                   b.hasQueuedPrompts, b.isPinned, b.phase, b.lastMessageAt, b.lastReadAt,
                   \(groupKeyCase) AS groupKey
            FROM sessions b
            WHERE \(visible("b")) AND \(restriction)
        ) k
        """
    }

    // MARK: - Group aggregates

    /// A workstream WITH children reports its children's status; everything else
    /// reports across all members. Mirrors `computeAggregatedStatus` at each call site.
    private static func statusExpr(_ column: String) -> String {
        """
        CASE WHEN groupKind = 'ws' AND SUM(isDisplayChild) > 0
             THEN COALESCE(MAX(CASE WHEN isDisplayChild = 1 THEN \(column) END), 0)
             ELSE COALESCE(MAX(\(column)), 0) END
        """
    }

    /// A group passes a phase filter when one of its displayed children matches;
    /// meta-agent groups are never phase-filtered and standalone rows match on
    /// themselves. Reproduces `PhaseFilter.matchesGroup`, including its existing
    /// behaviour that a childless group matches nothing.
    private static func phasePassExpr(_ column: String) -> String {
        """
        CASE
            WHEN groupKind = 'meta' THEN 1
            WHEN groupKind = 's' THEN COALESCE(MAX(\(column)), 0)
            WHEN groupKind = 'wt' THEN CASE WHEN COUNT(*) > 1
                THEN COALESCE(MAX(CASE WHEN isDisplayChild = 1 THEN \(column) END), 0) ELSE 0 END
            ELSE COALESCE(MAX(CASE WHEN isDisplayChild = 1 THEN \(column) END), 0)
        END
        """
    }

    private static func groupInsert(restriction: String) -> String {
        """
        INSERT OR REPLACE INTO sessionListGroups (
            groupKey, projectId, groupKind, parentId, orderTimestamp,
            childCount, memberCount,
            statusExecuting, statusQueued, statusWaiting, statusUnread, anyPinned, needsAttention,
            passActive, passPlanning, passComplete
        )
        SELECT
            groupKey,
            projectId,
            groupKind,
            COALESCE(MIN(anchorId), substr(MIN(printf('%020d|%s', createdAt, sessionId)), 22)),
            COALESCE(MAX(CASE WHEN isWorkstreamParent = 0 THEN updatedAt END), MAX(updatedAt)),
            CASE groupKind
                WHEN 'wt' THEN CASE WHEN COUNT(*) > 1 THEN COUNT(*) ELSE 0 END
                ELSE SUM(isDisplayChild)
            END,
            COUNT(*),
            \(statusExpr("isExecuting")),
            \(statusExpr("hasQueuedPrompts")),
            \(statusExpr("CASE WHEN isExecuting = 1 AND hasQueuedPrompts = 1 THEN 1 ELSE 0 END")),
            \(statusExpr("isUnread")),
            COALESCE(MAX(isPinned), 0),
            COALESCE(MAX(isExecuting OR hasQueuedPrompts OR isPinned), 0),
            \(phasePassExpr("phaseActive")),
            \(phasePassExpr("phasePlanning")),
            \(phasePassExpr("phaseComplete"))
        FROM sessionListGroupMembers
        WHERE projectId = :projectId AND \(restriction)
        GROUP BY projectId, groupKey, groupKind
        """
    }

    // MARK: - Maintenance

    /// Bring the projection up to date for one project. Incremental when possible: the
    /// work is proportional to what changed plus the size of the groups those changes
    /// touched, not to history.
    ///
    /// Returns the number of session changes applied.
    @discardableResult
    static func refresh(_ db: Database, projectId: String, metaAgentEnabled: Bool) throws -> Int {
        let builtFor = try Bool.fetchOne(
            db,
            sql: "SELECT metaAgentEnabled FROM sessionListGroupState WHERE projectId = ?",
            arguments: [projectId]
        )
        // No marker, or the meta-agent gate flipped: the stored grouping is for a
        // different set of rules, so rebuild rather than patch it.
        guard builtFor == metaAgentEnabled else {
            return try rebuild(db, projectId: projectId, metaAgentEnabled: metaAgentEnabled)
        }

        let dirtyCount = try Int.fetchOne(
            db,
            sql: "SELECT COUNT(*) FROM sessionListGroupDirty WHERE projectId = ?",
            arguments: [projectId]
        ) ?? 0
        guard dirtyCount > 0 else { return 0 }

        let arguments: StatementArguments = ["projectId": projectId, "metaEnabled": metaAgentEnabled ? 1 : 0]
        let dirtyIds = "SELECT sessionId FROM sessionListGroupDirty WHERE projectId = :projectId"

        try db.execute(sql: "DELETE FROM sessionListGroupTouched")
        // Groups the changed rows used to belong to...
        try db.execute(sql: """
            INSERT OR IGNORE INTO sessionListGroupTouched(groupKey)
            SELECT groupKey FROM sessionListGroupMembers
            WHERE projectId = :projectId AND sessionId IN (\(dirtyIds))
            """, arguments: arguments)
        try db.execute(sql: """
            DELETE FROM sessionListGroupMembers
            WHERE projectId = :projectId AND sessionId IN (\(dirtyIds))
            """, arguments: arguments)
        try db.execute(sql: memberInsert(restriction: "b.id IN (\(dirtyIds))"), arguments: arguments)
        // ...and the groups they belong to now.
        try db.execute(sql: """
            INSERT OR IGNORE INTO sessionListGroupTouched(groupKey)
            SELECT groupKey FROM sessionListGroupMembers
            WHERE projectId = :projectId AND sessionId IN (\(dirtyIds))
            """, arguments: arguments)

        let touched = "SELECT groupKey FROM sessionListGroupTouched"
        try db.execute(sql: """
            DELETE FROM sessionListGroups
            WHERE projectId = :projectId AND groupKey IN (\(touched))
            """, arguments: arguments)
        try db.execute(sql: groupInsert(restriction: "groupKey IN (\(touched))"), arguments: arguments)

        try db.execute(sql: "DELETE FROM sessionListGroupDirty WHERE projectId = :projectId",
                       arguments: arguments)
        try db.execute(sql: "DELETE FROM sessionListGroupTouched")
        return dirtyCount
    }

    /// Recreate the projection for a project from `sessions`. Used on first build, on a
    /// grouping-rule change, and available as a repair.
    @discardableResult
    static func rebuild(_ db: Database, projectId: String, metaAgentEnabled: Bool) throws -> Int {
        let arguments: StatementArguments = ["projectId": projectId, "metaEnabled": metaAgentEnabled ? 1 : 0]
        try db.execute(sql: """
            DELETE FROM sessionListGroups WHERE projectId = :projectId
            """, arguments: arguments)
        try db.execute(sql: """
            DELETE FROM sessionListGroupMembers WHERE projectId = :projectId
            """, arguments: arguments)
        try db.execute(sql: memberInsert(restriction: "1 = 1"), arguments: arguments)
        try db.execute(sql: groupInsert(restriction: "1 = 1"), arguments: arguments)
        try db.execute(sql: """
            INSERT OR REPLACE INTO sessionListGroupState(projectId, metaAgentEnabled)
            VALUES (:projectId, :metaEnabled)
            """, arguments: arguments)
        try db.execute(sql: "DELETE FROM sessionListGroupDirty WHERE projectId = :projectId",
                       arguments: arguments)
        return try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sessionListGroups WHERE projectId = ?",
                                arguments: [projectId]) ?? 0
    }

    /// Sessions whose changes have not been folded in yet. The window reports this so
    /// the model can schedule a refresh; a non-zero value means the list may be a few
    /// milliseconds stale, never that it is wrong forever.
    static func pendingCount(_ db: Database, projectId: String) throws -> Int {
        try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sessionListGroupDirty WHERE projectId = ?",
                         arguments: [projectId]) ?? 0
    }

    // MARK: - Reads

    /// Whether this filter is one the projection covers. Search, archives, and a
    /// meta-agent gate the projection was not built for fall back to the live query.
    static func covers(_ filter: SessionListFilter, builtForMetaAgentEnabled: Bool?) -> Bool {
        filter.likePattern == nil
            && !filter.includeArchived
            && builtForMetaAgentEnabled == filter.metaAgentEnabled
    }

    static func builtForMetaAgentEnabled(_ db: Database, projectId: String) throws -> Bool? {
        try Bool.fetchOne(db, sql: "SELECT metaAgentEnabled FROM sessionListGroupState WHERE projectId = ?",
                          arguments: [projectId])
    }

    private static func phaseColumn(_ phase: PhaseFilter) -> String? {
        switch phase {
        case .all: return nil
        case .active: return "passActive"
        case .planning: return "passPlanning"
        case .complete: return "passComplete"
        }
    }

    /// One page of display groups, read straight off `idx_slg_order`. This is the query
    /// that runs on every database change, and it touches `limit` rows.
    static func page(
        _ db: Database,
        filter: SessionListFilter,
        attentionOnly: Bool,
        after cursor: SessionListCursor?,
        limit: Int
    ) throws -> SessionListPage {
        var predicates = ["g.projectId = :projectId"]
        if let phaseColumn = phaseColumn(filter.phase) { predicates.append("g.\(phaseColumn) = 1") }
        if attentionOnly {
            predicates.append("g.needsAttention = 1")
        }
        if cursor != nil {
            predicates.append("(g.orderTimestamp < :cursorTs OR (g.orderTimestamp = :cursorTs AND g.groupKey < :cursorKey))")
        }
        var arguments: [String: (any DatabaseValueConvertible)?] = [
            "projectId": filter.projectId,
            "limit": limit + 1
        ]
        if let cursor {
            arguments["cursorTs"] = cursor.orderTimestamp
            arguments["cursorKey"] = cursor.groupKey
        }
        let rows = try Row.fetchAll(db, sql: """
            SELECT
                g.groupKey, g.groupKind, g.orderTimestamp AS orderTs, g.childCount,
                g.statusExecuting, g.statusQueued, g.statusWaiting, g.statusUnread,
                \(SessionListRow.selectList(alias: "p", prefix: "p_"))
            FROM sessionListGroups g
            JOIN sessions p ON p.id = g.parentId
            WHERE \(predicates.joined(separator: " AND "))
            ORDER BY g.orderTimestamp DESC, g.groupKey DESC
            LIMIT :limit
            """, arguments: StatementArguments(arguments))
        let items = rows.map(SessionListQueryRunner.makeItem)
        let page = Array(items.prefix(limit))
        return SessionListPage(
            items: page,
            nextCursor: items.count > limit
                ? page.last.map { SessionListCursor(orderTimestamp: $0.group.orderTimestamp, groupKey: $0.group.key) }
                : nil
        )
    }

    /// The group containing one session, resolved by an indexed membership lookup.
    static func item(_ db: Database, containing sessionId: String, filter: SessionListFilter) throws -> SessionListPageItem? {
        let rows = try Row.fetchAll(db, sql: """
            SELECT
                g.groupKey, g.groupKind, g.orderTimestamp AS orderTs, g.childCount,
                g.statusExecuting, g.statusQueued, g.statusWaiting, g.statusUnread,
                \(SessionListRow.selectList(alias: "p", prefix: "p_"))
            FROM sessionListGroupMembers m
            JOIN sessionListGroups g ON g.projectId = m.projectId AND g.groupKey = m.groupKey
            JOIN sessions p ON p.id = g.parentId
            WHERE m.sessionId = :sessionId AND g.projectId = :projectId
            LIMIT 1
            """, arguments: ["sessionId": sessionId, "projectId": filter.projectId])
        return rows.first.map(SessionListQueryRunner.makeItem)
    }

    static func children(
        _ db: Database,
        filter: SessionListFilter,
        groupKey: String,
        after cursor: SessionListChildCursor?,
        limit: Int
    ) throws -> SessionListChildPage {
        var predicates = [
            "m.projectId = :projectId",
            "m.groupKey = :groupKey",
            "(m.groupKind = 'wt' OR m.sessionId <> m.anchorId)"
        ]
        var arguments: [String: (any DatabaseValueConvertible)?] = [
            "projectId": filter.projectId, "groupKey": groupKey, "limit": limit + 1
        ]
        if let cursor {
            predicates.append("(m.updatedAt < :cursorUpdatedAt OR (m.updatedAt = :cursorUpdatedAt AND m.sessionId < :cursorId))")
            arguments["cursorUpdatedAt"] = cursor.updatedAt
            arguments["cursorId"] = cursor.id
        }
        let rows = try Row.fetchAll(db, sql: """
            SELECT \(SessionListRow.selectList(alias: "s"))
            FROM sessionListGroupMembers m
            JOIN sessions s ON s.id = m.sessionId
            WHERE \(predicates.joined(separator: " AND "))
            ORDER BY m.updatedAt DESC, m.sessionId DESC
            LIMIT :limit
            """, arguments: StatementArguments(arguments)).map { SessionListRow(row: $0) }
        let page = Array(rows.prefix(limit))
        return SessionListChildPage(
            rows: page,
            nextCursor: rows.count > limit
                ? page.last.map { SessionListChildCursor(updatedAt: $0.updatedAt, id: $0.id) }
                : nil
        )
    }

    static func memberIds(_ db: Database, projectId: String, groupKey: String) throws -> [String] {
        try String.fetchAll(
            db,
            sql: "SELECT sessionId FROM sessionListGroupMembers WHERE projectId = ? AND groupKey = ?",
            arguments: [projectId, groupKey]
        )
    }
}

public extension DatabaseManager {
    /// Fold pending session changes into the sidebar's group projection. Safe to call
    /// often: it does nothing when nothing changed.
    @discardableResult
    func refreshSessionListProjection(projectId: String, metaAgentEnabled: Bool) throws -> Int {
        try writer.write { db in
            try SessionListProjection.refresh(db, projectId: projectId, metaAgentEnabled: metaAgentEnabled)
        }
    }

    /// Rebuild the projection from `sessions`. It is derived data, so this is always safe.
    @discardableResult
    func rebuildSessionListProjection(projectId: String, metaAgentEnabled: Bool) throws -> Int {
        try writer.write { db in
            try SessionListProjection.rebuild(db, projectId: projectId, metaAgentEnabled: metaAgentEnabled)
        }
    }
}
