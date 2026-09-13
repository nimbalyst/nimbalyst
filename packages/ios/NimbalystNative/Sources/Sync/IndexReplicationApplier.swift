import Foundation
import GRDB
import os

/// Applies validated versioned index pages to the account database.
///
/// This is the API the replication client calls: hand it a page, it commits the
/// page's entries, per-row revisions, enumeration coverage and the cursor
/// together.
///
/// What it will not do:
/// - Advance the cursor for a `recent` or `lookup` page. Those serve the screen;
///   a feed cannot establish global coverage.
/// - Advance the cursor for a non-terminal page. Receiving bytes, or applying
///   the first of five pages, proves nothing about the range as a whole.
/// - Advance the cursor when any batch threw. The rows in that batch never
///   landed, so the next request must ask for the same range again.
/// - Claim complete history before reconciliation has actually run. A bootstrap
///   terminal records a durable finalization marker instead, and the cursor plus
///   `historyComplete` are committed by `finalizeBootstrap` once reconciliation
///   succeeds.
enum IndexReplicationApplier {
    /// Entries per transaction, matching the bounded batches used for legacy
    /// bulk responses.
    static let maxEntriesPerBatch = IndexIngestion.maxEntriesPerBatch
    /// Absent rows removed per reconciliation transaction.
    static let maxReconcileBatch = 200

    private static let logger = Logger(subsystem: "com.nimbalyst.app", category: "IndexReplication")

    struct Result: Sendable {
        var outcome = IndexBatchWriter.Outcome()
        /// The cursor actually committed, or nil when nothing advanced.
        var committedCursor: Int?
        /// A bootstrap terminal landed and reconciliation is now owed.
        var awaitingFinalization: IndexReplicationStore.PendingFinalization?
        var batches = 0
    }

    static func apply(
        _ page: ValidatedIndexPage,
        store: IndexReplicationStore,
        database: DatabaseManager,
        bootstrapRunId: String? = nil,
        cancellation: IndexIngestionCancellation? = nil
    ) throws -> Result {
        var result = Result()
        guard !page.resetRequired else { return result }

        let runId = page.mode == .bootstrap ? bootstrapRunId : nil
        let isBootstrapTerminal = page.mode == .bootstrap && page.complete && runId != nil
        let cursor = page.committableCursor

        let chunks = stride(from: 0, to: max(page.operations.count, 1), by: maxEntriesPerBatch).map { start in
            Array(page.operations[start..<min(start + maxEntriesPerBatch, page.operations.count)])
        }

        for (index, chunk) in chunks.enumerated() {
            let isFinal = index == chunks.count - 1
            // A bootstrap terminal commits its rows now and its cursor later:
            // reconciliation has to succeed before we can claim the coverage
            // that lets absence mean deletion.
            let context = IndexApplyContext(
                store: store,
                cursor: isFinal && !isBootstrapTerminal ? cursor : nil,
                bootstrapRunId: runId,
                // Coverage is recorded once, with the first chunk, so a page
                // that is entirely stale still counts as covered.
                seen: index == 0 ? page.seen : [],
                beginFinalization: isFinal && isBootstrapTerminal
                    ? .init(runId: runId ?? "", cursor: cursor ?? 0)
                    : nil,
                cancellation: cancellation
            )
            let outcome = try IndexBatchWriter.apply(chunk, context: context, database: database)
            result.batches += 1
            result.outcome.applied += outcome.applied
            result.outcome.unchanged += outcome.unchanged
            result.outcome.coalesced += outcome.coalesced
            result.outcome.deletes += outcome.deletes
            result.outcome.staleRejected += outcome.staleRejected
            result.outcome.retainedTombstones += outcome.retainedTombstones
            result.outcome.transactionMs += outcome.transactionMs
            result.outcome.affectedProjects = max(result.outcome.affectedProjects, outcome.affectedProjects)
            if isFinal {
                if isBootstrapTerminal, let runId {
                    result.awaitingFinalization = .init(runId: runId, cursor: cursor ?? 0)
                } else {
                    result.committedCursor = cursor
                }
            }
        }
        return result
    }

    struct FinalizationResult: Sendable {
        /// Counts, plus a capped sample for logs. The full list of removed ids
        /// is unbounded in history size and nothing consumes it.
        var removedCount = 0
        var removedSampleIds: [String] = []
        var purgedTombstoneCount = 0
        var cursor: Int = 0
        var cancelled = false
    }

    /// Ids kept for logging. Enough to recognise a pattern, not enough to grow
    /// with the account.
    static let removedSampleLimit = 20

    /// Finish a bootstrap: reconcile rows the proven-complete enumeration never
    /// listed, then commit the cursor and `historyComplete` in the same
    /// transaction that clears the finalization marker.
    ///
    /// Reconciliation runs in bounded transactions. If the process dies partway,
    /// the marker survives and the next connection resumes here instead of
    /// re-enumerating the whole account -- and, crucially, without ever having
    /// claimed complete coverage it did not finish proving.
    ///
    /// Rows carrying local state the server has not seen -- an unsent draft, an
    /// undelivered queued prompt -- are never removed. Reconciliation deletes
    /// what the server can account for, not what only this device knows.
    @discardableResult
    static func finalizeBootstrap(
        runId: String,
        store: IndexReplicationStore,
        database: DatabaseManager,
        cancellation: IndexIngestionCancellation? = nil
    ) throws -> FinalizationResult {
        var result = FinalizationResult()

        while true {
            // Reconciliation can span an entire history, so a retired generation
            // stops between transactions rather than finishing for an account
            // that is gone. The finalization marker survives, so the next
            // connection resumes instead of re-enumerating.
            if cancellation?.isCancelled == true {
                result.cancelled = true
                return result
            }
            let removed: [String] = try database.writer.write { db in
                try store.ensureSchema(db)
                let absent = try store.sessionIdsAbsentFromRun(db, runId: runId, limit: maxReconcileBatch)
                guard !absent.isEmpty else { return [] }
                var affectedProjects: Set<String> = []
                for sessionId in absent {
                    if let projectId = try Session.fetchOne(db, id: sessionId)?.projectId {
                        affectedProjects.insert(projectId)
                    }
                    _ = try Session.deleteOne(db, id: sessionId)
                }
                for projectId in affectedProjects {
                    try db.execute(sql: """
                        UPDATE projects SET
                            sessionCount = (
                                SELECT COUNT(*) FROM sessions
                                WHERE sessions.projectId = projects.id
                                  AND COALESCE(sessions.sessionType, 'session') NOT IN ('workstream', 'blitz')
                                  AND sessions.isArchived = 0
                            )
                        WHERE id = ?
                    """, arguments: [projectId])
                }
                return absent
            }
            if removed.isEmpty { break }
            result.removedCount += removed.count
            if result.removedSampleIds.count < removedSampleLimit {
                result.removedSampleIds.append(
                    contentsOf: removed.prefix(removedSampleLimit - result.removedSampleIds.count)
                )
            }
        }

        if cancellation?.isCancelled == true {
            result.cancelled = true
            return result
        }

        try database.writer.write { db in
            try store.ensureSchema(db)
            guard let pending = try store.pendingFinalization(db), pending.runId == runId else { return }
            result.purgedTombstoneCount = try store.purgeRetainedTombstones(db).count
            result.cursor = pending.cursor
            try store.commitCursor(db, cursor: pending.cursor, historyComplete: true)
            try store.clearSeen(db, runId: runId)
            try store.clearFinalization(db, runId: runId)
        }

        if result.removedCount > 0 {
            logger.info("Index bootstrap reconciliation removed \(result.removedCount) cached sessions absent from proven coverage")
        }
        return result
    }

}
