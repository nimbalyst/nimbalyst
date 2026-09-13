import Foundation
import GRDB

/// Entity classes carried by the versioned index stream.
enum IndexReplicationEntity: String, Sendable, CaseIterable {
    case session
    case project
    case file
}

/// What the account has actually committed of the versioned index.
struct IndexReplicationCursorState: Equatable, Sendable {
    /// Last contiguous committed revision. Receiving bytes, or applying part of
    /// a page, never moves this.
    var cursor: Int = 0
    /// A bootstrap baseline plus its replay have committed, so absence from the
    /// local cache is meaningful.
    var historyComplete: Bool = false
}

/// Durable bookkeeping for versioned index replication: per-row revisions,
/// tombstones, the applied cursor, bootstrap enumeration progress, and index
/// file metadata.
///
/// The schema is created lazily with `CREATE TABLE IF NOT EXISTS` inside the
/// caller's transaction. `createSchema` is the same DDL, ready for central
/// registration in `DatabaseManager`'s migrator under `migrationIdentifier`;
/// registering it does not require removing the lazy path, which then costs one
/// count query and creates nothing.
///
/// Three rules the rest of the client depends on:
/// - A row's stored revision, including a tombstone's, rejects anything at or
///   below it. An older page cannot resurrect a deleted row or overwrite a
///   newer one.
/// - Rows and the cursor commit in one transaction, and only the caller's
///   proven-contiguous cursor is ever written.
/// - Bootstrap enumeration progress lives here, not in an in-memory set that
///   grows with history and dies with the process.
final class IndexReplicationStore: Sendable {
    /// The unified cursor scope. Separate scopes exist so a future
    /// per-entity-class cursor cannot be advanced by an unrelated stream.
    static let unifiedScope = "index"

    init() {}

    // MARK: - Schema

    static let tableNames = [
        "index_row_revision",
        "index_replication_cursor",
        "index_bootstrap_seen",
        "index_bootstrap_finalization",
        "index_file_metadata",
    ]

    /// Identifier for central registration in `DatabaseManager`'s migrator.
    static let migrationIdentifier = "v2IndexReplication"

    /// Guarded by live `sqlite_master` state, deliberately not by an in-memory
    /// flag and not by `Database.tableExists`. Both of those survive a rolled
    /// back transaction that created these tables, after which every read fails
    /// with "no such table" for the life of the connection. Counting the tables
    /// rather than probing one means adding a table later still creates it on
    /// installs that already have the others.
    ///
    /// Once `createSchema` is registered as a migration this becomes a single
    /// count query per transaction and creates nothing.
    func ensureSchema(_ db: Database) throws {
        let present = try Int.fetchOne(db, sql: """
            SELECT COUNT(*) FROM sqlite_master
            WHERE type = 'table' AND name IN (\(Self.tableNames.map { "'\($0)'" }.joined(separator: ", ")))
        """) ?? 0
        if present == Self.tableNames.count { return }
        try Self.createSchema(db)
    }

    /// The schema, for central registration:
    ///
    ///     migrator.registerMigration(IndexReplicationStore.migrationIdentifier) { db in
    ///         try IndexReplicationStore.createSchema(db)
    ///     }
    ///
    /// Idempotent by construction (every statement is IF NOT EXISTS), so
    /// registering it on an install that already ran the lazy path is safe.
    static func createSchema(_ db: Database) throws {
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS index_row_revision (
                entity TEXT NOT NULL,
                id TEXT NOT NULL,
                revision INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (entity, id)
            )
        """)
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS index_replication_cursor (
                scope TEXT NOT NULL PRIMARY KEY,
                cursor INTEGER NOT NULL DEFAULT 0,
                historyComplete INTEGER NOT NULL DEFAULT 0,
                updatedAt INTEGER NOT NULL DEFAULT 0
            )
        """)
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS index_bootstrap_seen (
                runId TEXT NOT NULL,
                entity TEXT NOT NULL,
                id TEXT NOT NULL,
                PRIMARY KEY (runId, entity, id)
            )
        """)
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS index_file_metadata (
                docId TEXT NOT NULL PRIMARY KEY,
                projectId TEXT NOT NULL,
                relativePath TEXT,
                title TEXT,
                lastModifiedAt INTEGER NOT NULL DEFAULT 0,
                syncedAt INTEGER NOT NULL DEFAULT 0
            )
        """)
        try db.execute(sql: """
            CREATE TABLE IF NOT EXISTS index_bootstrap_finalization (
                runId TEXT NOT NULL PRIMARY KEY,
                cursor INTEGER NOT NULL,
                startedAt INTEGER NOT NULL DEFAULT 0
            )
        """)
        try db.execute(sql: "CREATE INDEX IF NOT EXISTS index_file_metadata_project ON index_file_metadata(projectId)")
    }

    // MARK: - Row revisions

    struct RowRevision: Equatable, Sendable {
        var revision: Int
        var deleted: Bool
    }

    func revision(_ db: Database, entity: IndexReplicationEntity, id: String) throws -> RowRevision? {
        let row = try Row.fetchOne(
            db,
            sql: "SELECT revision, deleted FROM index_row_revision WHERE entity = ? AND id = ?",
            arguments: [entity.rawValue, id]
        )
        guard let row else { return nil }
        return RowRevision(revision: row["revision"], deleted: row["deleted"] != 0)
    }

    /// Revisions for a whole batch in one query, so applying 100 entries does
    /// not cost 100 lookups.
    func revisions(_ db: Database, keys: [(entity: IndexReplicationEntity, id: String)]) throws -> [String: RowRevision] {
        guard !keys.isEmpty else { return [:] }
        var result: [String: RowRevision] = [:]
        for chunk in stride(from: 0, to: keys.count, by: 400).map({ Array(keys[$0..<min($0 + 400, keys.count)]) }) {
            let placeholders = chunk.map { _ in "(?, ?)" }.joined(separator: ", ")
            var arguments: [DatabaseValueConvertible] = []
            for key in chunk {
                arguments.append(key.entity.rawValue)
                arguments.append(key.id)
            }
            let rows = try Row.fetchAll(
                db,
                sql: "SELECT entity, id, revision, deleted FROM index_row_revision WHERE (entity, id) IN (VALUES \(placeholders))",
                arguments: StatementArguments(arguments)
            )
            for row in rows {
                let entity: String = row["entity"]
                let id: String = row["id"]
                result[Self.key(entity, id)] = RowRevision(revision: row["revision"], deleted: row["deleted"] != 0)
            }
        }
        return result
    }

    func recordRevision(
        _ db: Database,
        entity: IndexReplicationEntity,
        id: String,
        revision: Int,
        deleted: Bool
    ) throws {
        try db.execute(
            sql: """
                INSERT INTO index_row_revision (entity, id, revision, deleted) VALUES (?, ?, ?, ?)
                ON CONFLICT(entity, id) DO UPDATE SET revision = excluded.revision, deleted = excluded.deleted
            """,
            arguments: [entity.rawValue, id, revision, deleted ? 1 : 0]
        )
    }

    static func key(_ entity: String, _ id: String) -> String { "\(entity)\u{1f}\(id)" }
    static func key(_ entity: IndexReplicationEntity, _ id: String) -> String { key(entity.rawValue, id) }

    // MARK: - Cursor

    func cursorState(_ db: Database, scope: String = IndexReplicationStore.unifiedScope) throws -> IndexReplicationCursorState {
        let row = try Row.fetchOne(
            db,
            sql: "SELECT cursor, historyComplete FROM index_replication_cursor WHERE scope = ?",
            arguments: [scope]
        )
        guard let row else { return IndexReplicationCursorState() }
        return IndexReplicationCursorState(cursor: row["cursor"], historyComplete: row["historyComplete"] != 0)
    }

    func cursorState(_ database: DatabaseManager, scope: String = IndexReplicationStore.unifiedScope) throws -> IndexReplicationCursorState {
        try database.writer.write { db in
            try ensureSchema(db)
            return try cursorState(db, scope: scope)
        }
    }

    /// Commit the applied cursor. `cursor` never moves backwards, and
    /// `historyComplete` is only ever set by a proven bootstrap terminal --
    /// pass nil to leave it as it was.
    func commitCursor(
        _ db: Database,
        scope: String = IndexReplicationStore.unifiedScope,
        cursor: Int?,
        historyComplete: Bool? = nil,
        now: Int = Int(Date().timeIntervalSince1970 * 1000)
    ) throws {
        let current = try cursorState(db, scope: scope)
        let next = max(current.cursor, cursor ?? current.cursor)
        let complete = historyComplete ?? current.historyComplete
        guard next != current.cursor || complete != current.historyComplete else { return }
        try db.execute(
            sql: """
                INSERT INTO index_replication_cursor (scope, cursor, historyComplete, updatedAt) VALUES (?, ?, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, historyComplete = excluded.historyComplete, updatedAt = excluded.updatedAt
            """,
            arguments: [scope, next, complete ? 1 : 0, now]
        )
    }

    /// An expired or rejected cursor resets replication without touching cached
    /// rows: the data stays usable and unproven, which is the whole point.
    ///
    /// Every piece of revision bookkeeping goes with it, in the same
    /// transaction. A reset can mean the server's room was restored and its head
    /// is now LOWER than what we cached -- a room at revision 100 rebuilt to
    /// revision 5. Keeping the old per-row revisions would make the entire fresh
    /// bootstrap look stale, every row would be rejected, and the terminal would
    /// still commit historyComplete: an account permanently frozen on metadata
    /// from before the reset, with nothing on screen to suggest it.
    ///
    /// What is deliberately NOT cleared: cached sessions, projects, file
    /// metadata and everything local (drafts, queued prompts). Absence is proven
    /// by the new bootstrap's reconciliation, never by a reset.
    func resetReplicationEpoch(_ db: Database, scope: String = IndexReplicationStore.unifiedScope) throws {
        try db.execute(
            sql: "UPDATE index_replication_cursor SET cursor = 0, historyComplete = 0 WHERE scope = ?",
            arguments: [scope]
        )
        // Old revisions and tombstones belong to a sequence the server no longer
        // has; they cannot be compared against the new one.
        try db.execute(sql: "DELETE FROM index_row_revision")
        // A half-finished enumeration of the old epoch proves nothing about the
        // new one.
        try db.execute(sql: "DELETE FROM index_bootstrap_seen")
        // And a finalization owed from before the reset must never commit its
        // old cursor -- that alone would restore the frozen state.
        try db.execute(sql: "DELETE FROM index_bootstrap_finalization")
    }

    // MARK: - Bootstrap enumeration

    func recordSeen(_ db: Database, runId: String, entity: IndexReplicationEntity, id: String) throws {
        try db.execute(
            sql: "INSERT OR IGNORE INTO index_bootstrap_seen (runId, entity, id) VALUES (?, ?, ?)",
            arguments: [runId, entity.rawValue, id]
        )
    }

    func seenCount(_ db: Database, runId: String) throws -> Int {
        try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM index_bootstrap_seen WHERE runId = ?", arguments: [runId]) ?? 0
    }

    func clearSeen(_ db: Database, runId: String) throws {
        try db.execute(sql: "DELETE FROM index_bootstrap_seen WHERE runId = ?", arguments: [runId])
    }

    /// Cached sessions the proven-complete enumeration never mentioned.
    ///
    /// Rows carrying local state the server has not seen are never returned: an
    /// unsent draft and a locally queued prompt live only on this device, and a
    /// reconciliation pass is not permission to discard them.
    func sessionIdsAbsentFromRun(_ db: Database, runId: String, limit: Int = 500) throws -> [String] {
        try String.fetchAll(db, sql: """
            SELECT s.id FROM sessions s
            WHERE NOT EXISTS (
                SELECT 1 FROM index_bootstrap_seen b
                WHERE b.runId = ? AND b.entity = 'session' AND b.id = s.id
            )
            AND (s.draftInput IS NULL OR s.draftInput = '')
            AND NOT EXISTS (
                SELECT 1 FROM queuedPrompts q
                WHERE q.sessionId = s.id AND q.source IS NULL AND q.sentAt IS NULL
            )
            LIMIT ?
        """, arguments: [runId, limit])
    }

    // MARK: - Local work protection

    /// Work that exists only on this device: an unsent draft, or a queued prompt
    /// this device created and has not delivered. Deleting the session row
    /// cascades both away, and neither is recoverable from the server.
    static func hasUndeliveredLocalWork(_ db: Database, sessionId: String) throws -> Bool {
        let hasDraft = try Bool.fetchOne(db, sql: """
            SELECT EXISTS(
                SELECT 1 FROM sessions
                WHERE id = ? AND draftInput IS NOT NULL AND draftInput <> ''
            )
        """, arguments: [sessionId]) ?? false
        if hasDraft { return true }
        return try Bool.fetchOne(db, sql: """
            SELECT EXISTS(
                SELECT 1 FROM queuedPrompts
                WHERE sessionId = ? AND source IS NULL AND sentAt IS NULL
            )
        """, arguments: [sessionId]) ?? false
    }

    /// Sessions the server has deleted that we are still holding because of
    /// local work. Exposed so the list can mark them rather than pretend the
    /// deletion did not happen.
    func retainedTombstonedSessionIds(_ db: Database) throws -> [String] {
        try String.fetchAll(db, sql: """
            SELECT s.id FROM sessions s
            JOIN index_row_revision r ON r.entity = 'session' AND r.id = s.id AND r.deleted = 1
        """)
    }

    /// Carry out deletions that were deferred once their local work is gone.
    ///
    /// Eligibility is filtered in SQL before the limit, not after. Fetching all
    /// tombstoned rows and then taking the first N would let a handful of
    /// permanently-protected rows starve every eligible row behind them.
    @discardableResult
    func purgeRetainedTombstones(_ db: Database, limit: Int = 100) throws -> [String] {
        let eligible = try String.fetchAll(db, sql: """
            SELECT s.id FROM sessions s
            JOIN index_row_revision r ON r.entity = 'session' AND r.id = s.id AND r.deleted = 1
            WHERE (s.draftInput IS NULL OR s.draftInput = '')
              AND NOT EXISTS (
                  SELECT 1 FROM queuedPrompts q
                  WHERE q.sessionId = s.id AND q.source IS NULL AND q.sentAt IS NULL
              )
            LIMIT ?
        """, arguments: [limit])
        var purged: [String] = []
        for sessionId in eligible where try Session.deleteOne(db, id: sessionId) {
            purged.append(sessionId)
        }
        return purged
    }

    // MARK: - Bootstrap finalization

    /// A bootstrap whose entries are committed but whose reconciliation has not
    /// finished yet.
    ///
    /// The cursor and `historyComplete` are written only after reconciliation
    /// succeeds, so a crash in between leaves this marker, not a claim of
    /// complete coverage we never actually proved.
    struct PendingFinalization: Equatable, Sendable {
        var runId: String
        var cursor: Int
    }

    func beginFinalization(
        _ db: Database,
        runId: String,
        cursor: Int,
        now: Int = Int(Date().timeIntervalSince1970 * 1000)
    ) throws {
        try db.execute(
            sql: """
                INSERT INTO index_bootstrap_finalization (runId, cursor, startedAt) VALUES (?, ?, ?)
                ON CONFLICT(runId) DO UPDATE SET cursor = excluded.cursor
            """,
            arguments: [runId, cursor, now]
        )
    }

    func pendingFinalization(_ db: Database) throws -> PendingFinalization? {
        let row = try Row.fetchOne(
            db,
            sql: "SELECT runId, cursor FROM index_bootstrap_finalization ORDER BY startedAt LIMIT 1"
        )
        guard let row else { return nil }
        return PendingFinalization(runId: row["runId"], cursor: row["cursor"])
    }

    func clearFinalization(_ db: Database, runId: String) throws {
        try db.execute(sql: "DELETE FROM index_bootstrap_finalization WHERE runId = ?", arguments: [runId])
    }

    // MARK: - Index file metadata

    /// Metadata about a synced document as the personal index sees it. This is
    /// replication bookkeeping, kept apart from the document bodies that
    /// document sync owns: a row disappearing here never deletes a body.
    struct IndexFileMetadata: Equatable, Sendable {
        var docId: String
        var projectId: String
        var relativePath: String?
        var title: String?
        var lastModifiedAt: Int
        var syncedAt: Int
    }

    func upsertFileMetadata(_ db: Database, _ metadata: IndexFileMetadata) throws {
        try db.execute(
            sql: """
                INSERT INTO index_file_metadata (docId, projectId, relativePath, title, lastModifiedAt, syncedAt)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(docId) DO UPDATE SET
                    projectId = excluded.projectId,
                    relativePath = excluded.relativePath,
                    title = excluded.title,
                    lastModifiedAt = excluded.lastModifiedAt,
                    syncedAt = excluded.syncedAt
            """,
            arguments: [
                metadata.docId, metadata.projectId, metadata.relativePath,
                metadata.title, metadata.lastModifiedAt, metadata.syncedAt,
            ]
        )
    }

    func deleteFileMetadata(_ db: Database, docId: String) throws {
        try db.execute(sql: "DELETE FROM index_file_metadata WHERE docId = ?", arguments: [docId])
    }

    func fileMetadata(_ db: Database, docId: String) throws -> IndexFileMetadata? {
        let row = try Row.fetchOne(
            db,
            sql: "SELECT docId, projectId, relativePath, title, lastModifiedAt, syncedAt FROM index_file_metadata WHERE docId = ?",
            arguments: [docId]
        )
        guard let row else { return nil }
        return IndexFileMetadata(
            docId: row["docId"], projectId: row["projectId"], relativePath: row["relativePath"],
            title: row["title"], lastModifiedAt: row["lastModifiedAt"], syncedAt: row["syncedAt"]
        )
    }
}
