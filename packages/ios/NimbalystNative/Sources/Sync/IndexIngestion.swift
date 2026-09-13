import Foundation
import os

/// The serial owner of index ingestion for one account/connection generation.
///
/// Everything that mutates the local index -- bulk responses, live session and
/// project broadcasts, deletes -- is submitted here in arrival order and applied
/// by a single background consumer. Decryption and every database write happen
/// off the main actor; the main actor only submits and receives outcomes.
///
/// A generation is a connection identity. `cancel()` drops the backlog and stops
/// the consumer, and outcomes carry their generation so a late publication from
/// a connection (or account) that is gone cannot move the current UI state.
@MainActor
final class IndexIngestion {
    /// Entries per transaction. The plan's starting budget; the metrics report
    /// transaction duration so it can be tuned against measurements.
    nonisolated static let maxEntriesPerBatch = 100

    let generation: Int
    private let queue = IndexIngestionQueue()
    private var consumer: Task<Void, Never>?

    /// Durable replication bookkeeping shared by this generation's work.
    let replicationStore = IndexReplicationStore()
    /// Set by `cancel()`. Read inside database transactions, where
    /// `Task.isCancelled` cannot see the task.
    private let cancellation = IndexIngestionCancellation()

    init(
        generation: Int,
        crypto: CryptoManager,
        database: DatabaseManager,
        onOutcome: @escaping @MainActor @Sendable (IndexIngestionOutcome) -> Void,
        onPageOutcome: @escaping @MainActor @Sendable (IndexPageOutcome) -> Void = { _ in },
        onMaintenanceOutcome: @escaping @MainActor @Sendable (IndexMaintenanceOutcome) -> Void = { _ in }
    ) {
        self.generation = generation
        let queue = self.queue
        let store = replicationStore
        let cancellation = self.cancellation
        consumer = Task.detached(priority: .utility) {
            await IndexIngestionConsumer(
                queue: queue,
                crypto: crypto,
                database: database,
                store: store,
                cancellation: cancellation,
                generation: generation,
                onOutcome: onOutcome,
                onPageOutcome: onPageOutcome,
                onMaintenanceOutcome: onMaintenanceOutcome
            ).run()
        }
    }

    /// Ordered, non-blocking handoff. Ordering must not depend on the caller
    /// awaiting, so this never suspends.
    func submit(_ work: IndexIngestionWork, byteCount: Int) {
        queue.submit(work, byteCount: byteCount)
    }

    /// Suspends only while the backlog is over its byte budget, which is how the
    /// socket read loop is throttled during a history burst.
    func awaitCapacity() async {
        await queue.capacity()
    }

    func cancel() {
        cancellation.cancel()
        queue.finish()
        consumer?.cancel()
        consumer = nil
    }

    var pendingCount: Int { queue.pendingCount }

    deinit {
        cancellation.cancel()
        queue.finish()
        consumer?.cancel()
    }
}

/// The background half of `IndexIngestion`. Not main-actor isolated: decrypt and
/// database work must never run on the main actor.
private struct IndexIngestionConsumer: Sendable {
    let queue: IndexIngestionQueue
    let crypto: CryptoManager
    let database: DatabaseManager
    let store: IndexReplicationStore
    let cancellation: IndexIngestionCancellation
    let generation: Int
    let onOutcome: @MainActor @Sendable (IndexIngestionOutcome) -> Void
    let onPageOutcome: @MainActor @Sendable (IndexPageOutcome) -> Void
    let onMaintenanceOutcome: @MainActor @Sendable (IndexMaintenanceOutcome) -> Void
    let logger = Logger(subsystem: "com.nimbalyst.app", category: "IndexIngestion")

    func run() async {
        while let batch = await queue.nextBatch(maxEntries: IndexIngestion.maxEntriesPerBatch) {
            if Task.isCancelled { return }
            await apply(batch)
        }
    }

    private func apply(_ batch: [IndexIngestionQueue.Item]) async {
        // A bulk response owns the load state, so its result is aggregated
        // across every transaction it was split into and published once.
        var responses: [Int: (summary: IndexImportSummary, isIncremental: Bool, metrics: IndexIngestionMetrics)] = [:]
        var responseOrder: [Int] = []
        var liveOperations: [IndexWriteOperation] = []
        var liveMetrics = IndexIngestionMetrics()
        let queuedAt = batch.first?.submittedAt ?? .now()
        // Queue latency is the wait before we picked the work up. Measuring it
        // after processing would fold this batch's own work into it.
        let queueWaitMs = elapsedMs(since: queuedAt)

        func flushLive() {
            guard !liveOperations.isEmpty else { return }
            // Live broadcasts do not advance the applied cursor: a reconnect
            // re-fetches them from the last bulk watermark, and re-applying is
            // idempotent.
            _ = write(liveOperations, watermark: nil, metrics: &liveMetrics)
            liveOperations = []
        }

        for item in batch {
            if Task.isCancelled { return }
            switch item.work {
            case .syncResponse(let response, let id, let decodeMs):
                // Live work submitted before this response must land first.
                flushLive()
                let result = applyResponse(
                    response,
                    queueWaitMs: queueWaitMs,
                    bytes: item.byteCount,
                    decodeMs: decodeMs
                )
                responses[id] = result
                responseOrder.append(id)
            case .session(let entry):
                var decryptMetrics = IndexIngestionMetrics()
                liveMetrics.bytes += item.byteCount
                if let decrypted = decrypt(entry, metrics: &decryptMetrics) {
                    liveOperations.append(.session(decrypted, revision: nil))
                } else {
                    liveMetrics.decryptFailures += 1
                }
                liveMetrics.merge(decryptMetrics)
                liveMetrics.entries += 1
            case .project(let entry):
                var decryptMetrics = IndexIngestionMetrics()
                liveMetrics.bytes += item.byteCount
                if let decrypted = decryptProject(entry, metrics: &decryptMetrics) {
                    liveOperations.append(.project(decrypted, revision: nil))
                } else {
                    liveMetrics.decryptFailures += 1
                }
                liveMetrics.merge(decryptMetrics)
                liveMetrics.entries += 1
            case .delete(let sessionId):
                liveOperations.append(.delete(key: .session(sessionId), revision: nil))
                liveMetrics.entries += 1
                liveMetrics.bytes += item.byteCount
            case .page(let response, let request):
                // Ordered with everything around it: a page cannot overtake a
                // legacy entry submitted before it.
                flushLive()
                let outcome = applyPage(response, request: request, bytes: item.byteCount)
                await MainActor.run { onPageOutcome(outcome) }
            case .maintenance(let request, let id):
                flushLive()
                let outcome = runMaintenance(request, id: id)
                await MainActor.run { onMaintenanceOutcome(outcome) }
            }
        }
        flushLive()

        if liveMetrics.entries > 0 {
            liveMetrics.queueWaitMs = queueWaitMs
            logger.info("Index live ingestion: \(liveMetrics.summaryLine)")
        }

        for id in responseOrder {
            guard let result = responses[id] else { continue }
            let outcome = IndexIngestionOutcome(
                generation: generation,
                responseId: id,
                isIncremental: result.isIncremental,
                summary: result.summary,
                metrics: result.metrics
            )
            await MainActor.run { onOutcome(outcome) }
        }
    }

    // MARK: - Bulk responses

    private func applyResponse(
        _ response: IndexSyncResponse,
        queueWaitMs: Double,
        bytes: Int,
        decodeMs: Double
    ) -> (summary: IndexImportSummary, isIncremental: Bool, metrics: IndexIngestionMetrics) {
        var summary = IndexImportSummary()
        var metrics = IndexIngestionMetrics()
        metrics.bytes = bytes
        metrics.decodeMs = decodeMs
        metrics.queueWaitMs = queueWaitMs

        var operations: [IndexWriteOperation] = []
        var watermark: Int?
        var storageFailed = false

        // Decrypt outside the transaction, then commit in bounded batches.
        // `watermark` only reaches the writer on the last batch of a response
        // that had no failure of any kind.
        func commit(isFinal: Bool) {
            // A retired generation must stop writing, not finish the import for
            // an account or connection that is gone.
            if Task.isCancelled {
                operations = []
                summary.failed = true
                return
            }
            let entriesInBatch = operations.count
            let advance = isFinal && !summary.failed && !storageFailed ? watermark : nil
            guard !operations.isEmpty || advance != nil else { return }
            if !write(operations, watermark: advance, metrics: &metrics) {
                storageFailed = true
                summary.storageFailureCount += entriesInBatch
                summary.failed = true
            }
            operations = []
        }

        for project in response.projects {
            if Task.isCancelled { summary.failed = true; break }
            metrics.entries += 1
            if let decrypted = decryptProject(project, metrics: &metrics) {
                summary.decryptedEntryCount += 1
                operations.append(.project(decrypted, revision: nil))
            } else {
                metrics.decryptFailures += 1
                summary.failed = true
            }
            if operations.count >= IndexIngestion.maxEntriesPerBatch { commit(isFinal: false) }
        }

        for entry in response.sessions {
            if Task.isCancelled { summary.failed = true; break }
            metrics.entries += 1
            if let decrypted = decrypt(entry, metrics: &metrics) {
                summary.decryptedEntryCount += 1
                watermark = max(watermark ?? 0, entry.updatedAt)
                operations.append(.session(decrypted, revision: nil))
            } else {
                metrics.decryptFailures += 1
                summary.failedSessionDecryptCount += 1
                summary.failed = true
            }
            if operations.count >= IndexIngestion.maxEntriesPerBatch { commit(isFinal: false) }
        }

        // A truncated full response is not a complete index, and its absent rows
        // are not evidence of anything.
        let isTruncated = response.since == nil
            && response.totalSessionCount.map { $0 != response.sessions.count } == true
        if isTruncated { summary.failed = true }

        commit(isFinal: true)

        // A delta or mixed-key index cannot establish a device-wide mismatch.
        // Any authenticated entry disproves that this pairing key is unusable.
        summary.shouldSuggestRepair = response.since == nil && !isTruncated
            && summary.failedSessionDecryptCount > 5 && summary.decryptedEntryCount == 0
            && summary.storageFailureCount == 0

        if summary.failed {
            logger.error("Index import failures: \(summary.failedSessionDecryptCount) session decryptions, \(summary.storageFailureCount) storage operations; \(summary.decryptedEntryCount) entries decrypted")
        }
        logger.info("Index ingestion: \(metrics.summaryLine)")
        return (summary, response.since != nil, metrics)
    }

    // MARK: - Maintenance

    /// Coverage reads and crash recovery, off the main actor.
    ///
    /// Resuming an interrupted bootstrap can reconcile an entire history, so
    /// running it where the driver lives would block the UI for as long as that
    /// takes. It runs here, in the same ordered queue as the pages, and its
    /// result reaches the driver as an outcome like any other.
    private func runMaintenance(_ request: IndexReplicationMaintenance, id: Int) -> IndexMaintenanceOutcome {
        let offMain = !Thread.isMainThread
        func outcome(
            _ state: IndexReplicationCursorState,
            pendingRunId: String? = nil,
            missingAncestors: [String] = [],
            failure: String? = nil
        ) -> IndexMaintenanceOutcome {
            IndexMaintenanceOutcome(
                generation: generation, id: id, request: request, cursorState: state,
                pendingFinalizationRunId: pendingRunId, missingAncestorIds: missingAncestors,
                ranOffMainActor: offMain, failure: failure
            )
        }

        do {
            switch request {
            case .loadCoverage:
                return try database.writer.write { db in
                    try store.ensureSchema(db)
                    let state = try store.cursorState(db)
                    let pending = try store.pendingFinalization(db)
                    return outcome(state, pendingRunId: pending?.runId)
                }
            case .resumeFinalization(let runId):
                logger.info("Resuming interrupted bootstrap finalization")
                _ = try IndexReplicationApplier.finalizeBootstrap(
                    runId: runId, store: store, database: database, cancellation: cancellation
                )
                let state = try database.writer.write { db in try store.cursorState(db) }
                return outcome(state)
            case .resetCursor:
                let state: IndexReplicationCursorState = try database.writer.write { db in
                    try store.ensureSchema(db)
                    try store.resetReplicationEpoch(db)
                    return try store.cursorState(db)
                }
                return outcome(state)
            case .missingAncestors(let sessionIds):
                let missing: [String] = try database.writer.read { db in
                    var wanted: Set<String> = []
                    for session in try Session.filter(ids: Set(sessionIds)).fetchAll(db) {
                        if let parent = session.parentSessionId { wanted.insert(parent) }
                        if let creator = session.createdBySessionId { wanted.insert(creator) }
                    }
                    guard !wanted.isEmpty else { return [] }
                    let present = Set(try Session.filter(ids: wanted).fetchAll(db).map(\.id))
                    return Array(wanted.subtracting(present))
                }
                return outcome(IndexReplicationCursorState(), missingAncestors: missing)
            }
        } catch {
            logger.error("Index maintenance failed: \(error.localizedDescription)")
            return outcome(IndexReplicationCursorState(), failure: error.localizedDescription)
        }
    }

    // MARK: - Versioned pages

    private func applyPage(
        _ response: IndexPageResponse,
        request: IndexPageWork,
        bytes: Int
    ) -> IndexPageOutcome {
        func outcome(_ result: IndexPageOutcome.Result) -> IndexPageOutcome {
            IndexPageOutcome(generation: generation, requestId: request.requestId, mode: request.mode, result: result)
        }
        if isCancelled { return outcome(.failed("cancelled")) }

        let validation = IndexReplicationPageValidator.validate(
            response,
            expectedRequestId: request.requestId,
            expectedMode: request.mode,
            crypto: crypto
        )
        let page: ValidatedIndexPage
        switch validation {
        case .success(let validated): page = validated
        case .failure(let error):
            logger.error("Index page rejected: \(String(describing: error))")
            return outcome(.failed(String(describing: error)))
        }
        if page.resetRequired { return outcome(.reset) }
        if isCancelled { return outcome(.failed("cancelled")) }

        do {
            var result = try IndexReplicationApplier.apply(
                page,
                store: store,
                database: database,
                bootstrapRunId: request.bootstrapRunId,
                cancellation: cancellation
            )
            var historyComplete = false
            if let pending = result.awaitingFinalization, !isCancelled {
                let finalization = try IndexReplicationApplier.finalizeBootstrap(
                    runId: pending.runId,
                    store: store,
                    database: database,
                    cancellation: cancellation
                )
                result.committedCursor = finalization.cursor
                historyComplete = true
            }
            var metrics = IndexIngestionMetrics()
            metrics.bytes = bytes
            metrics.entries = page.operations.count
            metrics.applied = result.outcome.applied
            metrics.unchanged = result.outcome.unchanged
            metrics.deletes = result.outcome.deletes
            metrics.batches = result.batches
            metrics.transactionMs = result.outcome.transactionMs
            logger.info("Index page applied (\(request.mode.rawValue)): \(metrics.summaryLine) stale=\(result.outcome.staleRejected) retained=\(result.outcome.retainedTombstones)")
            return outcome(.applied(
                nextPageToken: page.nextPageToken,
                complete: page.complete,
                committedCursor: result.committedCursor,
                historyComplete: historyComplete,
                entries: page.operations.count
            ))
        } catch {
            logger.error("Index page storage failure: \(error.localizedDescription)")
            return outcome(.failed(error.localizedDescription))
        }
    }

    // MARK: - Steps

    private func decrypt(_ entry: ServerSessionEntry, metrics: inout IndexIngestionMetrics) -> DecryptedSessionEntry? {
        let start = DispatchTime.now()
        defer { metrics.decryptMs += elapsedMs(since: start) }
        return IndexEntryDecryptor.decrypt(session: entry, crypto: crypto)
    }

    private func decryptProject(_ entry: ServerProjectEntry, metrics: inout IndexIngestionMetrics) -> DecryptedProjectEntry? {
        let start = DispatchTime.now()
        defer { metrics.decryptMs += elapsedMs(since: start) }
        return IndexEntryDecryptor.decrypt(project: entry, crypto: crypto)
    }

    /// Returns false when the transaction failed; nothing in it was committed.
    private func write(
        _ operations: [IndexWriteOperation],
        watermark: Int?,
        metrics: inout IndexIngestionMetrics
    ) -> Bool {
        let start = DispatchTime.now()
        do {
            let outcome = try IndexBatchWriter.apply(
                operations,
                context: IndexApplyContext(legacyWatermark: watermark, cancellation: cancellation),
                database: database
            )
            metrics.transactionMs += outcome.transactionMs
            metrics.writerWaitMs += max(0, elapsedMs(since: start) - outcome.transactionMs)
            metrics.batches += 1
            metrics.largestBatch = max(metrics.largestBatch, operations.count)
            metrics.applied += outcome.applied
            metrics.unchanged += outcome.unchanged
            metrics.coalesced += outcome.coalesced
            metrics.deletes += outcome.deletes
            return true
        } catch {
            metrics.writerWaitMs += elapsedMs(since: start)
            metrics.batches += 1
            metrics.storageFailures += operations.count
            logger.error("Index batch transaction failed: \(error.localizedDescription)")
            return false
        }
    }

    /// True when this generation has been retired, whether or not we are
    /// currently running inside the consumer task.
    private var isCancelled: Bool { Task.isCancelled || cancellation.isCancelled }

    private func elapsedMs(since start: DispatchTime) -> Double {
        Double(DispatchTime.now().uptimeNanoseconds &- start.uptimeNanoseconds) / 1_000_000
    }
}
