import Foundation

/// One unit of index work, applied in arrival order.
///
/// Bulk responses and live broadcasts travel through the same queue so an older
/// bulk import can never land on top of a newer live update.
/// `@unchecked` because the wire types it carries are immutable `let`-only
/// Codable structs that predate the concurrency annotations, matching how
/// `IndexSyncResponse` already declares itself.
enum IndexIngestionWork: @unchecked Sendable {
    /// A full or incremental `indexSyncResponse`. `id` correlates the outcome
    /// back to the request that is currently driving `indexLoadState`, and
    /// `decodeMs` carries the one step that still runs on the main actor so it
    /// shows up in the same measurement as the rest of the pipeline.
    case syncResponse(IndexSyncResponse, id: Int, decodeMs: Double)
    case session(ServerSessionEntry)
    case project(ServerProjectEntry)
    case delete(sessionId: String)
    /// A versioned replication page, applied through the same ordered pipeline
    /// so it cannot race the legacy entries around it.
    case page(IndexPageResponse, request: IndexPageWork)
    /// Replication bookkeeping that touches the database: reading committed
    /// coverage, resuming an interrupted bootstrap, resetting the cursor. It
    /// goes through this queue for the same two reasons pages do -- it must not
    /// run on the main actor, and it must be ordered against the pages around it.
    case maintenance(IndexReplicationMaintenance, id: Int)

    /// Entries carried by this item, used to size batches and the pending budget.
    var entryCount: Int {
        switch self {
        case .syncResponse(let response, _, _): return max(1, response.sessions.count + response.projects.count)
        case .page(let response, _): return max(1, response.entries.count)
        case .session, .project, .delete, .maintenance: return 1
        }
    }
}

/// What one response contributed, aggregated across every batch it was split into.
///
/// The pairing-mismatch inference reads these counts, so they keep the meaning
/// they had when a response was applied as a single unit: an entry that
/// authenticated under this manager's key counts as decrypted even when its row
/// turned out to be unchanged or its transaction later failed.
struct IndexImportSummary: Sendable {
    var decryptedEntryCount = 0
    var failedSessionDecryptCount = 0
    var storageFailureCount = 0
    var failed = false
    var shouldSuggestRepair = false
}

/// Aggregate ingestion counters. Counts and durations only -- never session
/// content, titles, prompts, keys, or tokens.
struct IndexIngestionMetrics: Sendable {
    /// Serialized wire bytes received for this work, before decode.
    var bytes = 0
    var entries = 0
    var applied = 0
    var unchanged = 0
    var coalesced = 0
    var decryptFailures = 0
    var storageFailures = 0
    var deletes = 0
    var batches = 0
    var largestBatch = 0
    /// JSON decode, the one step still on the main actor.
    var decodeMs = 0.0
    var decryptMs = 0.0
    /// Time inside the write transaction, measured by the writer itself.
    var transactionMs = 0.0
    /// Time spent waiting for the database writer, which is contention rather
    /// than work. Kept separate so a slow batch can be attributed correctly.
    var writerWaitMs = 0.0
    /// Wall time from submission of the oldest item in a batch to the start of
    /// its transaction: the queue's own latency, separate from execution.
    var queueWaitMs = 0.0

    mutating func merge(_ other: IndexIngestionMetrics) {
        bytes += other.bytes
        entries += other.entries
        applied += other.applied
        unchanged += other.unchanged
        coalesced += other.coalesced
        decryptFailures += other.decryptFailures
        storageFailures += other.storageFailures
        deletes += other.deletes
        batches += other.batches
        largestBatch = max(largestBatch, other.largestBatch)
        decodeMs += other.decodeMs
        decryptMs += other.decryptMs
        transactionMs += other.transactionMs
        writerWaitMs += other.writerWaitMs
        queueWaitMs += other.queueWaitMs
    }

    var summaryLine: String {
        String(
            format: "bytes=%d entries=%d applied=%d unchanged=%d coalesced=%d deletes=%d batches=%d maxBatch=%d decryptFail=%d storageFail=%d decode=%.1fms decrypt=%.1fms txn=%.1fms writerWait=%.1fms queueWait=%.1fms",
            bytes, entries, applied, unchanged, coalesced, deletes, batches, largestBatch,
            decryptFailures, storageFailures, decodeMs, decryptMs, transactionMs, writerWaitMs, queueWaitMs
        )
    }
}

/// Database-touching replication bookkeeping, run on the ingestion owner.
enum IndexReplicationMaintenance: Sendable, Equatable {
    /// Read what the account has actually committed, plus any bootstrap whose
    /// reconciliation was interrupted.
    case loadCoverage
    /// Finish an interrupted bootstrap: reconcile, then commit its cursor.
    case resumeFinalization(runId: String)
    /// The server refused our cursor. Clears it without touching cached rows.
    case resetCursor
    /// Which of these sessions' ancestors are not cached locally, so a lookup
    /// can fetch exactly those. Reading the rows is a database touch, so it
    /// belongs here rather than on the main actor.
    case missingAncestors(of: [String])
}

/// The result of a maintenance operation, published back on the main actor.
struct IndexMaintenanceOutcome: Sendable {
    let generation: Int
    let id: Int
    let request: IndexReplicationMaintenance
    let cursorState: IndexReplicationCursorState
    /// A bootstrap owing reconciliation, discovered by `loadCoverage`.
    let pendingFinalizationRunId: String?
    /// Ancestor ids the local cache is missing, from `missingAncestors`.
    var missingAncestorIds: [String] = []
    /// False would mean recovery ran on the main actor, which is the bug this
    /// whole path exists to avoid.
    let ranOffMainActor: Bool
    let failure: String?
}

/// What the driver asked for, carried alongside the response so the consumer can
/// reject a page that answers a different request.
struct IndexPageWork: Sendable {
    let requestId: String
    let mode: IndexReplicationMode
    /// Enumeration run this page contributes coverage to. Bootstrap only.
    let bootstrapRunId: String?
}

/// What became of a versioned page, published back on the main actor.
struct IndexPageOutcome: Sendable {
    let generation: Int
    let requestId: String
    let mode: IndexReplicationMode
    let result: Result

    enum Result: Sendable {
        /// Applied. `complete` means this was the last page of the range.
        case applied(
            nextPageToken: String?,
            complete: Bool,
            committedCursor: Int?,
            historyComplete: Bool,
            entries: Int
        )
        /// The server refused the cursor. Cached rows are untouched; the driver
        /// resets and bootstraps again.
        case reset
        /// Validation, decryption or storage failed. Nothing advanced.
        case failed(String)
    }
}

/// The result of applying one response, published back on the main actor.
struct IndexIngestionOutcome: Sendable {
    let generation: Int
    let responseId: Int
    let isIncremental: Bool
    let summary: IndexImportSummary
    let metrics: IndexIngestionMetrics
}
