import Foundation
import GRDB

/// One ordered mutation from the index stream.
///
/// `revision` is present only for versioned (v2) entries. Legacy bulk and
/// broadcast entries carry nil, and a nil revision never writes replication
/// bookkeeping -- an unversioned entry cannot claim to be newer than a
/// versioned one.
enum IndexWriteOperation: Sendable {
    case session(DecryptedSessionEntry, revision: Int?)
    case project(DecryptedProjectEntry, revision: Int?)
    case delete(key: IndexEntityKey, revision: Int?)
    case file(IndexReplicationStore.IndexFileMetadata, revision: Int?)
}

/// How one entity is identified on the wire versus locally.
///
/// They differ for projects: the server keys a project by its ENCRYPTED id,
/// while the local `projects` row is keyed by the decrypted workspace path.
/// Revisions and tombstones must use the wire id or a project's history would be
/// keyed differently on every device.
struct IndexEntityKey: Sendable, Equatable {
    let entity: IndexReplicationEntity
    let wireId: String
    let localId: String

    static func session(_ id: String) -> IndexEntityKey {
        IndexEntityKey(entity: .session, wireId: id, localId: id)
    }
    static func file(_ docId: String) -> IndexEntityKey {
        IndexEntityKey(entity: .file, wireId: docId, localId: docId)
    }
}

/// Everything a batch commits alongside its rows.
struct IndexApplyContext: Sendable {
    /// Legacy `syncState("index")` watermark. Advanced only for a response that
    /// applied cleanly; nil leaves it untouched.
    var legacyWatermark: Int?
    /// Versioned bookkeeping. Present whenever any operation carries a revision.
    var store: IndexReplicationStore?
    /// Proven-contiguous cursor for this commit. nil leaves the cursor where it
    /// was, which is what a partial page, a recent feed, or a lookup must do.
    var cursor: Int?
    /// Set true only by a bootstrap terminal that proved complete coverage.
    var historyComplete: Bool?
    /// When set, `seen` identities are recorded against this enumeration run so
    /// coverage is provable from SQLite rather than from an in-memory set.
    var bootstrapRunId: String?
    /// Every identity the page carried, including entries rejected as stale.
    /// A row the server listed is covered even when we already had it -- leaving
    /// it out would make reconciliation read it as absent and delete it.
    var seen: [IndexReplicationSeenKey] = []
    /// Records, in the same transaction as the rows, that a bootstrap terminal
    /// landed and now owes reconciliation before its cursor may be claimed.
    var beginFinalization: IndexReplicationStore.PendingFinalization?
    /// Checked inside the transaction. A retired generation stops writing where
    /// it is and the transaction rolls back, so nothing partial is committed and
    /// the cursor stays where it was.
    var cancellation: IndexIngestionCancellation?

    init(
        legacyWatermark: Int? = nil,
        store: IndexReplicationStore? = nil,
        cursor: Int? = nil,
        historyComplete: Bool? = nil,
        bootstrapRunId: String? = nil,
        seen: [IndexReplicationSeenKey] = [],
        beginFinalization: IndexReplicationStore.PendingFinalization? = nil,
        cancellation: IndexIngestionCancellation? = nil
    ) {
        self.legacyWatermark = legacyWatermark
        self.store = store
        self.cursor = cursor
        self.historyComplete = historyComplete
        self.bootstrapRunId = bootstrapRunId
        self.seen = seen
        self.beginFinalization = beginFinalization
        self.cancellation = cancellation
    }
}

/// Applies a bounded batch of index mutations in a single transaction.
///
/// Rows, tombstones, queued prompts, project aggregates, per-row revisions and
/// the applied cursor commit together: a batch that throws leaves the cursor
/// where it was, so the next request asks for the same range again instead of
/// skipping it.
///
/// Costs this exists to bound. Project aggregates are recomputed once per
/// affected project rather than once per entry, and repeated updates to the
/// same session inside one batch merge in memory and write once -- while still
/// merging every entry's fields in arrival order, so a later entry that omits a
/// field does not discard what an earlier one supplied.
enum IndexBatchWriter {
    struct Outcome: Sendable {
        var applied = 0
        var unchanged = 0
        var coalesced = 0
        var deletes = 0
        /// Entries at or below the revision already committed for that row.
        /// Rejecting them is how an older page loses to a newer one.
        var staleRejected = 0
        var affectedProjects = 0
        /// Server deletions we recorded but did not carry out, because the row
        /// still holds work that exists only on this device.
        var retainedTombstones = 0
        /// Time inside the write transaction, excluding the wait for the writer.
        var transactionMs = 0.0
    }

    /// Recomputes what the session list actually shows: archived sessions and
    /// structural containers are excluded from the count, and `lastUpdatedAt`
    /// never regresses to NULL for a project whose sessions are not cached yet.
    private static let projectStatsSQL = """
        UPDATE projects SET
            lastUpdatedAt = COALESCE(
                (SELECT MAX(updatedAt) FROM sessions WHERE sessions.projectId = projects.id),
                lastUpdatedAt
            ),
            sessionCount = (
                SELECT COUNT(*) FROM sessions
                WHERE sessions.projectId = projects.id
                  AND COALESCE(sessions.sessionType, 'session') NOT IN ('workstream', 'blitz')
                  AND sessions.isArchived = 0
            )
        WHERE id = ?
    """

    static func apply(
        _ operations: [IndexWriteOperation],
        context: IndexApplyContext,
        database: DatabaseManager
    ) throws -> Outcome {
        let commitsBookkeeping = context.cursor != nil || context.historyComplete != nil
            || context.beginFinalization != nil
        guard !operations.isEmpty || context.legacyWatermark != nil || commitsBookkeeping else {
            return Outcome()
        }

        return try database.writer.write { db in
            // Measured here, inside the closure: time spent waiting for the
            // writer is queue pressure, not transaction cost, and the plan asks
            // for those two separated.
            let transactionStart = DispatchTime.now()
            // Task.isCancelled is meaningless here -- this closure runs on the
            // database queue, not in the task -- so cancellation is carried by an
            // explicit flag.
            let cancellation = context.cancellation
            func checkCancelled() throws {
                if cancellation?.isCancelled == true { throw CancellationError() }
            }
            try checkCancelled()
            var outcome = Outcome()
            var affectedProjects: Set<String> = []
            var knownProjects: Set<String> = []
            var sessionOperations = 0

            let store = context.store
            if store != nil || commitsBookkeeping {
                try store?.ensureSchema(db)
            }

            // One read for revisions, and one for rows, per batch.
            var revisions: [String: IndexReplicationStore.RowRevision] = [:]
            if let store {
                let keys: [(entity: IndexReplicationEntity, id: String)] = operations.compactMap { operation in
                    switch operation {
                    case .session(let decrypted, let revision):
                        return revision == nil ? nil : (.session, decrypted.sessionId)
                    case .project(let decrypted, let revision):
                        return revision == nil ? nil : (.project, decrypted.wireId)
                    case .delete(let key, let revision):
                        return revision == nil ? nil : (key.entity, key.wireId)
                    case .file(let metadata, let revision):
                        return revision == nil ? nil : (.file, metadata.docId)
                    }
                }
                revisions = try store.revisions(db, keys: keys)
            }

            /// A versioned entry loses to an equal or newer committed revision,
            /// including a tombstone's: absence proven at revision N is not
            /// undone by a page that predates it.
            func isStale(_ entity: IndexReplicationEntity, _ id: String, _ revision: Int?) -> Bool {
                guard let revision, let existing = revisions[IndexReplicationStore.key(entity, id)] else { return false }
                return revision <= existing.revision
            }

            func record(_ entity: IndexReplicationEntity, _ id: String, _ revision: Int?, deleted: Bool) throws {
                guard let revision, let store else { return }
                try store.recordRevision(db, entity: entity, id: id, revision: revision, deleted: deleted)
                revisions[IndexReplicationStore.key(entity, id)] = .init(revision: revision, deleted: deleted)
            }

            if let runId = context.bootstrapRunId, let store {
                for key in context.seen {
                    try store.recordSeen(db, runId: runId, entity: key.entity, id: key.id)
                }
            }

            let touchedIds = operations.compactMap { operation -> String? in
                switch operation {
                case .session(let decrypted, _): return decrypted.sessionId
                case .delete(let key, _): return key.entity == .session ? key.localId : nil
                case .project, .file: return nil
                }
            }
            var stored: [String: Session] = [:]
            if !touchedIds.isEmpty {
                for session in try Session.filter(ids: Set(touchedIds)).fetchAll(db) {
                    stored[session.id] = session
                }
            }

            // Merged-but-unwritten rows. Deletes flush immediately; everything
            // else is written once, after the batch's last entry for that row.
            var pending: [String: Session] = [:]
            var pendingOrder: [String] = []
            var pendingPrompts: [String: [QueuedPrompt]] = [:]
            var flushedRows = 0

            func flush() throws {
                flushedRows += pendingOrder.count
                for sessionId in pendingOrder {
                    guard let merged = pending[sessionId] else { continue }
                    if merged == stored[sessionId] {
                        outcome.unchanged += 1
                    } else {
                        try merged.save(db)
                        stored[sessionId] = merged
                        outcome.applied += 1
                    }
                    // queuedPrompts.sessionId references sessions, so the row has
                    // to exist first. Writing a first-ever session's remote queue
                    // before its row failed the whole transaction.
                    if let prompts = pendingPrompts.removeValue(forKey: sessionId) {
                        // Locally-created prompts have no source and are kept.
                        try QueuedPrompt
                            .filter(QueuedPrompt.Columns.sessionId == sessionId)
                            .filter(QueuedPrompt.Columns.source != nil)
                            .deleteAll(db)
                        for prompt in prompts {
                            try prompt.save(db)
                        }
                    }
                }
                pending.removeAll()
                pendingOrder.removeAll()
            }

            var operationIndex = 0
            for operation in operations {
                operationIndex += 1
                if operationIndex % 20 == 0 { try checkCancelled() }
                switch operation {
                case .project(let decrypted, let revision):
                    guard !isStale(.project, decrypted.wireId, revision) else {
                        outcome.staleRejected += 1
                        continue
                    }
                    try decrypted.project.save(db)
                    try record(.project, decrypted.wireId, revision, deleted: false)
                    knownProjects.insert(decrypted.projectId)
                    affectedProjects.insert(decrypted.projectId)

                case .session(let decrypted, let revision):
                    guard !isStale(.session, decrypted.sessionId, revision) else {
                        outcome.staleRejected += 1
                        continue
                    }
                    sessionOperations += 1
                    if !knownProjects.contains(decrypted.projectId) {
                        if try Project.fetchOne(db, id: decrypted.projectId) == nil {
                            try Project(
                                id: decrypted.projectId,
                                name: (decrypted.projectId as NSString).lastPathComponent,
                                lastUpdatedAt: decrypted.entry.updatedAt
                            ).save(db)
                        }
                        knownProjects.insert(decrypted.projectId)
                    }

                    let current = pending[decrypted.sessionId] ?? stored[decrypted.sessionId]
                    let merged = IndexEntryDecryptor.merge(decrypted, existing: current)
                    if pending[decrypted.sessionId] == nil { pendingOrder.append(decrypted.sessionId) }
                    pending[decrypted.sessionId] = merged
                    if let current, current.projectId != merged.projectId {
                        affectedProjects.insert(current.projectId)
                    }
                    affectedProjects.insert(merged.projectId)
                    try record(.session, decrypted.sessionId, revision, deleted: false)

                    if let prompts = decrypted.remoteQueuedPrompts {
                        // Written by flush(), after the session row exists.
                        pendingPrompts[decrypted.sessionId] = prompts
                    }

                case .file(let metadata, let revision):
                    guard !isStale(.file, metadata.docId, revision) else {
                        outcome.staleRejected += 1
                        continue
                    }
                    guard let store else { continue }
                    try store.upsertFileMetadata(db, metadata)
                    try record(.file, metadata.docId, revision, deleted: false)
                    outcome.applied += 1

                case .delete(let key, let revision):
                    let entity = key.entity
                    let id = key.localId
                    guard !isStale(entity, key.wireId, revision) else {
                        outcome.staleRejected += 1
                        continue
                    }
                    // A delete is an ordering barrier: everything merged before
                    // it must land first, and a later entry for the same id is a
                    // recreation rather than a merge onto the deleted row.
                    try flush()
                    switch entity {
                    case .session:
                        let projectId = try stored[id]?.projectId
                            ?? Session.fetchOne(db, id: id)?.projectId
                        // Deleting the row cascades its messages and queued
                        // prompts. An unsent draft or an undelivered local prompt
                        // exists nowhere else, so the tombstone is recorded and
                        // the row is kept until that work is gone -- see
                        // IndexReplicationStore.purgeRetainedTombstones.
                        if try IndexReplicationStore.hasUndeliveredLocalWork(db, sessionId: id) {
                            outcome.retainedTombstones += 1
                        } else {
                            if try Session.deleteOne(db, id: id) { outcome.deletes += 1 }
                            stored[id] = nil
                        }
                        if let projectId { affectedProjects.insert(projectId) }
                    case .project:
                        // sessions.projectId cascades, so removing a project row
                        // would silently take its sessions with it. Record the
                        // tombstone and leave the row until it is empty; a
                        // stranded empty project is not worth losing history.
                        let sessionCount = try Int.fetchOne(
                            db,
                            sql: "SELECT COUNT(*) FROM sessions WHERE projectId = ?",
                            arguments: [id]
                        ) ?? 0
                        if sessionCount == 0 {
                            if try Project.deleteOne(db, id: id) { outcome.deletes += 1 }
                        } else {
                            affectedProjects.insert(id)
                        }
                    case .file:
                        // Index bookkeeping only. The document body belongs to
                        // document sync and is never deleted from here.
                        try store?.deleteFileMetadata(db, docId: id)
                        outcome.deletes += 1
                    }
                    try record(entity, key.wireId, revision, deleted: true)
                }
            }
            try flush()
            outcome.coalesced = max(0, sessionOperations - flushedRows)

            for projectId in affectedProjects {
                try db.execute(sql: projectStatsSQL, arguments: [projectId])
            }
            outcome.affectedProjects = affectedProjects.count

            // Nothing may claim progress for a generation that is gone.
            try checkCancelled()

            if let watermark = context.legacyWatermark {
                let current = try SyncState.filter(Column("roomId") == "index").fetchOne(db)
                if watermark > (current?.lastSyncedAt ?? 0) {
                    try SyncState(
                        roomId: "index",
                        lastCursor: current?.lastCursor,
                        lastSequence: current?.lastSequence ?? 0,
                        lastSyncedAt: watermark
                    ).save(db)
                }
            }

            if let store {
                if context.cursor != nil || context.historyComplete != nil {
                    try store.commitCursor(db, cursor: context.cursor, historyComplete: context.historyComplete)
                }
                if let finalization = context.beginFinalization {
                    try store.beginFinalization(db, runId: finalization.runId, cursor: finalization.cursor)
                }
            }

            outcome.transactionMs = Double(
                DispatchTime.now().uptimeNanoseconds &- transactionStart.uptimeNanoseconds
            ) / 1_000_000
            return outcome
        }
    }
}
