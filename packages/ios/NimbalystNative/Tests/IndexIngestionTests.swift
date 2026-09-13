import XCTest
import Combine
import CryptoKit
import GRDB
@testable import NimbalystNative

/// Ordered background index ingestion: correctness of what reaches SQLite, and
/// of the cursor/state that survives a failure.
@MainActor
final class IndexIngestionTests: XCTestCase {
    private let crypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 7, count: 32)))
    private let otherCrypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 8, count: 32)))
    private let projectPath = "/test/ingestion"

    func testActionDraftWaitsForMatchingCreationAndIndexRow() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)
        let requestId = try sync.createSession(projectId: projectPath, targetDeviceId: "sandbox-one", initialDraft: "Review these changes")
        let response: [String: Any] = ["type": "createSessionResponseBroadcast", "response": ["requestId": requestId, "success": true, "sessionId": "created"]]
        await sync.receiveIndexMessage(try JSONSerialization.data(withJSONObject: response))
        _ = try await receive(sync, sessions: [try entry("created", updatedAt: 1)])
        XCTAssertEqual(try db.session(byId: "created")?.draftInput, "Review these changes")
        XCTAssertFalse(try db.session(byId: "created")?.isExecuting ?? true)
    }

    private func manager(_ db: DatabaseManager) -> SyncManager {
        SyncManager(crypto: crypto, database: db, serverUrl: "https://invalid.example", userId: "test", registerDeviceCallbacks: false)
    }

    /// A session entry. `valid: false` encrypts the project id under a key this
    /// manager cannot authenticate, which is how a decryption failure reaches
    /// the importer without corrupting anything else about the entry.
    private func entry(
        _ id: String,
        updatedAt: Int,
        title: String? = nil,
        phase: String? = nil,
        draft: String? = nil,
        isExecuting: Bool? = nil,
        valid: Bool = true
    ) throws -> [String: Any] {
        var dict: [String: Any] = [
            "sessionId": id,
            "encryptedProjectId": try (valid ? crypto : otherCrypto).encryptProjectId(projectPath),
            "projectIdIv": CryptoManager.projectIdIvBase64,
            "createdAt": 1,
            "updatedAt": updatedAt,
        ]
        if let title {
            let encrypted = try crypto.encrypt(plaintext: title)
            dict["encryptedTitle"] = encrypted.encrypted
            dict["titleIv"] = encrypted.iv
        }
        if let isExecuting { dict["isExecuting"] = isExecuting }
        if phase != nil || draft != nil {
            let meta = ClientMetadata(
                currentContext: nil, hasPendingPrompt: nil, phase: phase,
                tags: nil, draftInput: draft, draftUpdatedAt: draft == nil ? nil : updatedAt
            )
            let json = String(data: try JSONEncoder().encode(meta), encoding: .utf8)!
            let encrypted = try crypto.encrypt(plaintext: json)
            dict["encryptedClientMetadata"] = encrypted.encrypted
            dict["clientMetadataIv"] = encrypted.iv
        }
        return dict
    }

    /// Deliver an index response and wait for its import to settle.
    @discardableResult
    private func receive(
        _ sync: SyncManager,
        sessions: [[String: Any]],
        projects: [[String: Any]] = [],
        since: Int? = nil,
        total: Int? = nil
    ) async throws -> IndexLoadState {
        var payload: [String: Any] = ["type": "indexSyncResponse", "sessions": sessions, "projects": projects]
        if let since { payload["since"] = since }
        if let total { payload["totalSessionCount"] = total }
        let completed = expectation(description: "Index import finished")
        var settled: IndexLoadState = .loading
        let subscription = sync.$indexLoadState.dropFirst().filter { $0 != .loading }.prefix(1).sink {
            settled = $0
            completed.fulfill()
        }
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: payload))
        await fulfillment(of: [completed], timeout: 5)
        subscription.cancel()
        return settled
    }

    // MARK: - Same-timestamp updates

    /// The server does not advance `updatedAt` for every metadata patch, and a
    /// legacy response carries no revision, so equal timestamps cannot be read
    /// as equal content. Skipping on timestamp equality drops the update.
    func testSameTimestampMetadataUpdateIsApplied() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        try await receive(sync, sessions: [try entry("s1", updatedAt: 200, title: "First", phase: "planning")])
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "First")

        try await receive(sync, sessions: [try entry("s1", updatedAt: 200, title: "Second", phase: "implementing")])
        let stored = try db.session(byId: "s1")
        XCTAssertEqual(stored?.titleDecrypted, "Second", "A same-timestamp metadata edit must still reach SQLite")
        XCTAssertEqual(stored?.phase, "implementing")
    }

    // MARK: - Cursor safety

    /// A watermark that advances past an entry we failed to apply makes the
    /// next incremental request skip that row forever.
    func testWatermarkDoesNotAdvancePastAFailedEntry() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        let state = try await receive(sync, sessions: [
            try entry("good", updatedAt: 10, title: "Kept"),
            try entry("undecryptable", updatedAt: 20, valid: false),
        ])
        XCTAssertEqual(state, .failed)
        XCTAssertNotNil(try db.session(byId: "good"), "Entries that did apply are still committed")
        XCTAssertNil(
            try db.syncState(forRoom: "index")?.lastSyncedAt,
            "A response containing a failed entry must not advance the applied cursor"
        )

        try await receive(sync, sessions: [try entry("good", updatedAt: 30, title: "Kept")])
        XCTAssertEqual(try db.syncState(forRoom: "index")?.lastSyncedAt, 30, "A clean response advances the cursor")
    }

    /// A rejected transaction is the same hazard as a rejected decryption: the
    /// rows never landed, so the cursor cannot claim they did.
    func testStorageFailureLeavesTheCursorWhereItWas() async throws {
        let db = try DatabaseManager()
        try await db.writer.write { db in
            try db.execute(sql: "CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'injected storage failure'); END")
        }
        let sync = manager(db)

        let state = try await receive(sync, sessions: [try entry("s1", updatedAt: 40, title: "Rejected")])
        XCTAssertEqual(state, .failed)
        XCTAssertNil(try db.syncState(forRoom: "index")?.lastSyncedAt)
        XCTAssertFalse(sync.encryptionKeyMismatch, "A SQLite failure does not prove the pairing key is wrong")
    }

    // MARK: - Ordering

    /// Bulk history and live broadcasts share one queue. A broadcast that
    /// arrives after a bulk response must win, even though the response is far
    /// more work: applying them on independent tasks is how a stale history row
    /// lands on top of the update the user is watching.
    func testLiveBroadcastAfterABulkResponseIsNotOverwrittenByIt() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        var sessions = try (0..<250).map { try entry("bulk\($0)", updatedAt: 100, title: "Bulk") }
        sessions.append(try entry("s1", updatedAt: 100, title: "From history"))
        let response: [String: Any] = ["type": "indexSyncResponse", "sessions": sessions, "projects": []]

        let completed = expectation(description: "Index import finished")
        let subscription = sync.$indexLoadState.dropFirst().filter { $0 != .loading }.prefix(1).sink { _ in completed.fulfill() }
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: response))
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: [
            "type": "indexBroadcast",
            "session": try entry("s1", updatedAt: 101, title: "Live update"),
        ]))
        await fulfillment(of: [completed], timeout: 5)
        subscription.cancel()

        // The broadcast is applied after the response it followed, so drain the
        // queue before reading: completion belongs to the response, not to it.
        try await drainIngestion(sync)
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "Live update")
    }

    /// A delete is an ordering barrier: what follows it recreates the row rather
    /// than merging onto the row that was removed.
    func testRecreationAfterDeleteDoesNotInheritTheDeletedRow() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        try await receive(sync, sessions: [try entry("s1", updatedAt: 10, title: "Original", phase: "planning")])
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: [
            "type": "indexDeleteBroadcast", "sessionId": "s1",
        ]))
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: [
            "type": "indexBroadcast", "session": try entry("s1", updatedAt: 20, title: "Recreated"),
        ]))
        try await drainIngestion(sync)

        let stored = try db.session(byId: "s1")
        XCTAssertEqual(stored?.titleDecrypted, "Recreated")
        XCTAssertNil(stored?.phase, "The recreated row must not inherit the deleted row's metadata")
    }

    // MARK: - Bounded batches

    func testLargeResponseIsAppliedInBoundedTransactions() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        try await receive(sync, sessions: try (0..<250).map { try entry("s\($0)", updatedAt: 100 + $0, title: "T\($0)") })

        XCTAssertEqual(try db.sessions(forProject: projectPath).count, 250)
        let metrics = try XCTUnwrap(sync.lastIndexIngestionMetrics)
        XCTAssertEqual(metrics.entries, 250)
        XCTAssertEqual(metrics.applied, 250)
        XCTAssertGreaterThan(metrics.bytes, 0, "Transport size is part of the baseline instrumentation")
        XCTAssertLessThanOrEqual(metrics.largestBatch, IndexIngestion.maxEntriesPerBatch)
        XCTAssertEqual(metrics.batches, 3, "250 entries commit as three bounded transactions, not 250")
    }

    /// Repeated updates to one session inside a burst write once, and still
    /// merge every entry's fields in arrival order.
    func testRepeatedUpdatesInOneBatchWriteOnce() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        try await receive(sync, sessions: [
            try entry("s1", updatedAt: 10, title: "First", phase: "planning"),
            try entry("s1", updatedAt: 11),
            try entry("s1", updatedAt: 12, title: "Latest"),
        ])

        let stored = try db.session(byId: "s1")
        XCTAssertEqual(stored?.titleDecrypted, "Latest")
        XCTAssertEqual(stored?.updatedAt, 12)
        XCTAssertEqual(stored?.phase, "planning", "An entry that omits a field keeps what an earlier entry supplied")
        let metrics = try XCTUnwrap(sync.lastIndexIngestionMetrics)
        XCTAssertEqual(metrics.applied, 1)
        XCTAssertEqual(metrics.coalesced, 2)
    }

    // MARK: - Local state during ingestion

    /// Drafts and read markers are local-first: an index entry that says nothing
    /// about them must leave them alone, and an explicit empty draft clears.
    func testLocalDraftSurvivesAnEntryThatOmitsIt() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        try await receive(sync, sessions: [try entry("s1", updatedAt: 10, title: "T")])
        try db.updateSessionDraftInput(sessionId: "s1", draftInput: "unsent local text", draftUpdatedAt: 50)
        try db.markSessionRead("s1")
        let readAt = try db.session(byId: "s1")?.lastReadAt

        try await receive(sync, sessions: [try entry("s1", updatedAt: 11, title: "T")])
        XCTAssertEqual(try db.session(byId: "s1")?.draftInput, "unsent local text")
        XCTAssertEqual(try db.session(byId: "s1")?.lastReadAt, readAt)

        try await receive(sync, sessions: [try entry("s1", updatedAt: 12, title: "T", draft: "")])
        XCTAssertNil(try db.session(byId: "s1")?.draftInput, "An explicit empty draft is a clear, not an omission")
    }

    // MARK: - Generations

    /// Work submitted by a connection that has gone away must not report
    /// completion for it, and must not stay queued.
    func testDisconnectRetiresQueuedWorkAndItsPublication() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        let sessions = try (0..<250).map { try entry("s\($0)", updatedAt: 100 + $0, title: "T\($0)") }
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: [
            "type": "indexSyncResponse", "sessions": sessions, "projects": [],
        ]))
        sync.disconnect()

        XCTAssertEqual(sync.pendingIndexIngestionCount, 0, "The retired generation's backlog is dropped")
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(sync.indexLoadState, .loading, "A retired generation cannot complete the current load state")
    }

    /// Cancellation has to reach inside the response, not just the gap between
    /// items: a 3,000-entry import must stop mid-flight, not run to completion
    /// for an account that is gone.
    func testCancellationStopsWritesInsideALargeResponse() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)

        let sessions = try (0..<3000).map { try entry("s\($0)", updatedAt: 100 + $0, title: "T\($0)") }
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: [
            "type": "indexSyncResponse", "sessions": sessions, "projects": [],
        ]))
        sync.disconnect()

        try await Task.sleep(nanoseconds: 300_000_000)
        let afterCancel = try db.sessions(forProject: projectPath).count
        try await Task.sleep(nanoseconds: 300_000_000)
        let later = try db.sessions(forProject: projectPath).count

        XCTAssertEqual(afterCancel, later, "No writes land after the generation is retired")
        XCTAssertLessThan(later, 3000, "and the import stopped rather than finishing the whole response")
    }

    /// The production path decodes off the main actor; the synchronous entry
    /// point, kept for callers that cannot await, does not.
    func testProductionPathDecodesOffTheMainActor() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)
        let payload = try JSONSerialization.data(withJSONObject: [
            "type": "indexSyncResponse",
            "sessions": [try entry("s1", updatedAt: 5, title: "T")],
            "projects": [],
        ])

        await sync.receiveIndexMessage(payload)
        XCTAssertTrue(sync.lastIndexDecodeWasOffMainActor, "Index JSON must not be decoded on the main actor")

        sync.handleIndexMessage(payload)
        XCTAssertFalse(sync.lastIndexDecodeWasOffMainActor)
    }

    /// Crash recovery reconciles history, so it runs on the ingestion owner, not
    /// on the main actor where the driver lives. Resuming an interrupted
    /// bootstrap there would block the UI for as long as the reconciliation takes.
    func testInterruptedBootstrapIsFinalizedOffTheMainActor() async throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        // A session cached before the interrupted enumeration, which that
        // enumeration never listed.
        _ = try await receive(manager(db), sessions: [try entry("orphaned", updatedAt: 10, title: "Gone")])
        try await db.writer.write { db in
            try store.ensureSchema(db)
            try store.beginFinalization(db, runId: "run-x", cursor: 55)
        }

        var received: IndexMaintenanceOutcome?
        let published = expectation(description: "Maintenance outcome published")
        let ingestion = IndexIngestion(
            generation: 1, crypto: crypto, database: db,
            onOutcome: { _ in },
            onMaintenanceOutcome: { outcome in
                received = outcome
                published.fulfill()
            }
        )
        ingestion.submit(.maintenance(.resumeFinalization(runId: "run-x"), id: 1), byteCount: 0)
        await fulfillment(of: [published], timeout: 5)
        ingestion.cancel()

        let outcome = try XCTUnwrap(received)
        XCTAssertTrue(outcome.ranOffMainActor, "Recovery must not run where the UI runs")
        XCTAssertNil(outcome.failure)
        XCTAssertTrue(outcome.cursorState.historyComplete)
        XCTAssertEqual(outcome.cursorState.cursor, 55)
        XCTAssertNil(try db.session(byId: "orphaned"), "The interrupted reconciliation finished")
        let pending = try await db.writer.read { try store.pendingFinalization($0) }
        XCTAssertNil(pending)
    }

    /// Finishing the queue drops the backlog and releases its consumer.
    func testQueueFinishClearsPendingWorkAndEndsConsumption() async throws {
        let queue = IndexIngestionQueue()
        queue.submit(.delete(sessionId: "a"), byteCount: 10)
        queue.submit(.delete(sessionId: "b"), byteCount: 10)
        XCTAssertEqual(queue.pendingCount, 2)

        queue.finish()
        XCTAssertEqual(queue.pendingCount, 0)
        let batch = await queue.nextBatch(maxEntries: 100)
        XCTAssertNil(batch, "A finished queue stops its consumer instead of stalling it")
    }

    func testQueuePreservesSubmissionOrderAcrossBatches() async throws {
        let queue = IndexIngestionQueue()
        for index in 0..<5 { queue.submit(.delete(sessionId: "s\(index)"), byteCount: 1) }
        var seen: [String] = []
        while seen.count < 5, let batch = await queue.nextBatch(maxEntries: 2) {
            for item in batch {
                if case .delete(let sessionId) = item.work { seen.append(sessionId) }
            }
        }
        XCTAssertEqual(seen, ["s0", "s1", "s2", "s3", "s4"])
    }

    // MARK: - Helpers

    /// Wait for submitted work to be applied. Live broadcasts publish no state,
    /// so tests that assert on their result need the queue to be empty first.
    private func drainIngestion(_ sync: SyncManager, timeout: TimeInterval = 5) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while sync.pendingIndexIngestionCount > 0, Date() < deadline {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        // The last dequeued batch may still be inside its transaction.
        try await Task.sleep(nanoseconds: 100_000_000)
    }
}
