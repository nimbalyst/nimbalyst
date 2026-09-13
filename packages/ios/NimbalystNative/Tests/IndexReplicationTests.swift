import XCTest
import CryptoKit
import GRDB
@testable import NimbalystNative

/// Versioned index replication: what a page is allowed to prove, and what it is
/// never allowed to overwrite or delete.
final class IndexReplicationTests: XCTestCase {
    private let crypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 9, count: 32)))
    private let projectPath = "/test/replication"
    /// The id the SERVER keys a project by: the encrypted project id, which is
    /// deterministic (fixed IV) and is NOT the plaintext path.
    private var projectWireId: String { get throws { try crypto.encryptProjectId(projectPath) } }

    // MARK: - Fixtures

    private func sessionPayload(_ id: String, updatedAt: Int = 10, title: String? = nil) throws -> [String: Any] {
        var dict: [String: Any] = [
            "sessionId": id,
            "encryptedProjectId": try crypto.encryptProjectId(projectPath),
            "projectIdIv": CryptoManager.projectIdIvBase64,
            "createdAt": 1,
            "updatedAt": updatedAt,
        ]
        if let title {
            let encrypted = try crypto.encrypt(plaintext: title)
            dict["encryptedTitle"] = encrypted.encrypted
            dict["titleIv"] = encrypted.iv
        }
        return dict
    }

    private func filePayload(_ docId: String, path: String = "docs/notes.md", title: String = "Notes") throws -> [String: Any] {
        let relativePath = try crypto.encrypt(plaintext: path)
        let encryptedTitle = try crypto.encrypt(plaintext: title)
        return [
            "docId": docId,
            "encryptedProjectId": try crypto.encryptProjectId(projectPath),
            "projectIdIv": CryptoManager.projectIdIvBase64,
            "encryptedRelativePath": relativePath.encrypted,
            "relativePathIv": relativePath.iv,
            "encryptedTitle": encryptedTitle.encrypted,
            "titleIv": encryptedTitle.iv,
            "lastModifiedAt": 100,
            "syncedAt": 101,
        ]
    }

    private func change(
        entity: String,
        id: String,
        revision: Int,
        deleted: Bool = false,
        session: [String: Any]? = nil,
        project: [String: Any]? = nil,
        file: [String: Any]? = nil
    ) -> [String: Any] {
        var dict: [String: Any] = ["entity": entity, "id": id, "revision": revision, "deleted": deleted]
        if let session { dict["session"] = session }
        if let project { dict["project"] = project }
        if let file { dict["file"] = file }
        return dict
    }

    private func response(
        requestId: String = "r1",
        mode: String = "delta",
        entries: [[String: Any]],
        complete: Bool = true,
        nextPageToken: String? = nil,
        cursor: Int? = nil,
        protocolVersion: Int = 2,
        resetRequired: Bool? = nil
    ) throws -> IndexPageResponse {
        var dict: [String: Any] = [
            "type": "indexPageResponse",
            "protocolVersion": protocolVersion,
            "requestId": requestId,
            "mode": mode,
            "entries": entries,
            "complete": complete,
        ]
        if let nextPageToken { dict["nextPageToken"] = nextPageToken }
        if let cursor { dict["cursor"] = cursor }
        if let resetRequired { dict["resetRequired"] = resetRequired }
        return try JSONDecoder().decode(IndexPageResponse.self, from: JSONSerialization.data(withJSONObject: dict))
    }

    private func validated(
        _ response: IndexPageResponse,
        requestId: String = "r1",
        mode: IndexReplicationMode = .delta
    ) throws -> ValidatedIndexPage {
        switch IndexReplicationPageValidator.validate(response, expectedRequestId: requestId, expectedMode: mode, crypto: crypto) {
        case .success(let page): return page
        case .failure(let error): throw error
        }
    }

    @discardableResult
    private func apply(
        _ page: ValidatedIndexPage,
        store: IndexReplicationStore,
        database: DatabaseManager,
        runId: String? = nil
    ) throws -> IndexReplicationApplier.Result {
        try IndexReplicationApplier.apply(page, store: store, database: database, bootstrapRunId: runId)
    }

    // MARK: - Revisions and tombstones

    /// Revision, not arrival order and not a timestamp, decides who wins. A
    /// tombstone keeps winning: absence proven at revision N is not undone by a
    /// page that predates it.
    func testStaleEntriesAndTombstonesCannotOverwriteNewerRows() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 5, session: try sessionPayload("s1", title: "Newer")),
        ], cursor: 5)), store: store, database: db)
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "Newer")

        let stale = try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 3, session: try sessionPayload("s1", title: "Older")),
        ], cursor: 3)), store: store, database: db)
        XCTAssertEqual(stale.outcome.staleRejected, 1)
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "Newer")
        XCTAssertEqual(try store.cursorState(db).cursor, 5, "The cursor never moves backwards")

        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 7, deleted: true),
        ], cursor: 7)), store: store, database: db)
        XCTAssertNil(try db.session(byId: "s1"))

        let resurrect = try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 6, session: try sessionPayload("s1", title: "Zombie")),
        ], cursor: 7)), store: store, database: db)
        XCTAssertEqual(resurrect.outcome.staleRejected, 1)
        XCTAssertNil(try db.session(byId: "s1"), "A page older than the tombstone cannot resurrect the row")

        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 8, session: try sessionPayload("s1", title: "Recreated")),
        ], cursor: 8)), store: store, database: db)
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "Recreated")
    }

    // MARK: - Cursor discipline

    func testOnlyProvenTerminalPagesAdvanceTheCursor() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        let partial = try validated(
            try response(mode: "bootstrap", entries: [
                change(entity: "session", id: "a", revision: 11, session: try sessionPayload("a")),
            ], complete: false, nextPageToken: "page-2"),
            mode: .bootstrap
        )
        try apply(partial, store: store, database: db, runId: "run-1")
        XCTAssertEqual(try store.cursorState(db).cursor, 0, "A page in the middle of a range proves nothing about the range")

        let recent = try validated(
            try response(mode: "recent", entries: [
                change(entity: "session", id: "b", revision: 20, session: try sessionPayload("b")),
            ], cursor: 20),
            mode: .recent
        )
        let recentResult = try apply(recent, store: store, database: db)
        XCTAssertNil(recentResult.committedCursor)
        XCTAssertEqual(try store.cursorState(db).cursor, 0, "A recent feed cannot establish global coverage")
        XCTAssertNotNil(try db.session(byId: "b"), "but its rows are still usable immediately")

        let lookup = try validated(
            try response(mode: "lookup", entries: [
                change(entity: "session", id: "c", revision: 30, session: try sessionPayload("c")),
            ], cursor: 30),
            mode: .lookup
        )
        try apply(lookup, store: store, database: db)
        XCTAssertEqual(try store.cursorState(db).cursor, 0)

        let delta = try validated(try response(entries: [
            change(entity: "session", id: "d", revision: 42, session: try sessionPayload("d")),
        ], cursor: 42))
        try apply(delta, store: store, database: db)
        XCTAssertEqual(try store.cursorState(db).cursor, 42)
        XCTAssertFalse(try store.cursorState(db).historyComplete, "Only a bootstrap terminal proves complete history")
    }

    /// A terminal must not report complete coverage before the reconciliation it
    /// owes has actually run: the cursor and the flag are committed by
    /// finalization, and a crash in between leaves a resumable marker rather
    /// than a claim we never proved.
    func testHistoryCompleteOnlyComesFromAFinishedBootstrap() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        let deltaTerminal = try validated(try response(entries: [], cursor: 7))
        try apply(deltaTerminal, store: store, database: db)
        XCTAssertFalse(try store.cursorState(db).historyComplete)

        let bootstrapTerminal = try validated(
            try response(mode: "bootstrap", entries: [], cursor: 9),
            mode: .bootstrap
        )
        let applied = try apply(bootstrapTerminal, store: store, database: db, runId: "run-1")
        XCTAssertEqual(applied.awaitingFinalization?.cursor, 9)
        XCTAssertFalse(try store.cursorState(db).historyComplete, "Coverage is not claimed until reconciliation runs")
        XCTAssertEqual(try store.cursorState(db).cursor, 7, "and neither is the terminal cursor")
        XCTAssertEqual(
            try db.writer.read { try store.pendingFinalization($0) },
            .init(runId: "run-1", cursor: 9),
            "The interrupted terminal is resumable"
        )

        try IndexReplicationApplier.finalizeBootstrap(runId: "run-1", store: store, database: db)
        let state = try store.cursorState(db)
        XCTAssertTrue(state.historyComplete)
        XCTAssertEqual(state.cursor, 9)
        XCTAssertNil(try db.writer.read { try store.pendingFinalization($0) })

        try db.writer.write { try store.resetReplicationEpoch($0) }
        XCTAssertEqual(try store.cursorState(db), IndexReplicationCursorState(cursor: 0, historyComplete: false))
    }

    /// A failed transaction is not partial progress: the rows never landed, so
    /// the cursor must not claim they did.
    func testFailedTransactionCommitsNeitherRowsNorCursor() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        try db.writer.write { db in
            try db.execute(sql: "CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'injected'); END")
        }

        let page = try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 50, session: try sessionPayload("s1")),
        ], cursor: 50))
        XCTAssertThrowsError(try apply(page, store: store, database: db))
        XCTAssertNil(try db.session(byId: "s1"))
        XCTAssertEqual(try store.cursorState(db).cursor, 0)
    }

    // MARK: - Validation

    func testValidatorRejectsSelfInconsistentPages() throws {
        func expectFailure(_ response: IndexPageResponse, _ expected: IndexReplicationPageError, file: StaticString = #filePath, line: UInt = #line) {
            switch IndexReplicationPageValidator.validate(response, expectedRequestId: "r1", expectedMode: .delta, crypto: crypto) {
            case .success:
                XCTFail("Expected \(expected)", file: file, line: line)
            case .failure(let error):
                XCTAssertEqual(error, expected, file: file, line: line)
            }
        }

        expectFailure(try response(entries: [], protocolVersion: 1), .unsupportedProtocolVersion(1))
        expectFailure(try response(requestId: "other", entries: []), .requestMismatch(expected: "r1", received: "other"))
        expectFailure(try response(mode: "recent", entries: []), .modeMismatch(expected: "delta", received: "recent"))
        expectFailure(try response(mode: "sideways", entries: []), .unknownMode("sideways"))
        expectFailure(
            try response(entries: [], complete: true, nextPageToken: "more"),
            .pageTokenInconsistent(complete: true, hasToken: true)
        )
        expectFailure(
            try response(entries: [], complete: false),
            .pageTokenInconsistent(complete: false, hasToken: false)
        )
        expectFailure(
            try response(entries: [change(entity: "wormhole", id: "x", revision: 1)]),
            .unknownEntity("wormhole")
        )
        expectFailure(
            try response(entries: [change(entity: "session", id: "s1", revision: -1, session: try sessionPayload("s1"))]),
            .invalidRevision(id: "s1", revision: -1)
        )
        expectFailure(
            try response(entries: [change(entity: "session", id: "s1", revision: 4, deleted: true, session: try sessionPayload("s1"))]),
            .unexpectedPayload(entity: "session", id: "s1")
        )
        expectFailure(
            try response(entries: [change(entity: "session", id: "s1", revision: 4)]),
            .missingPayload(entity: "session", id: "s1")
        )
        expectFailure(
            try response(entries: [change(entity: "session", id: "s1", revision: 4, session: try sessionPayload("other"))]),
            .missingPayload(entity: "session", id: "s1")
        )
        expectFailure(
            try response(entries: [change(
                entity: "session", id: "s1", revision: 4,
                session: try sessionPayload("s1"), file: try filePayload("s1")
            )]),
            .unexpectedPayload(entity: "session", id: "s1")
        )
    }

    /// Rows migrated from a pre-v2 server carry baseline revision 0. Rejecting
    /// them would make every migrated account fail its first bootstrap.
    func testBaselineRevisionZeroIsValid() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        let page = try validated(
            try response(mode: "bootstrap", entries: [
                change(entity: "session", id: "migrated", revision: 0, session: try sessionPayload("migrated", title: "Legacy")),
                change(entity: "session", id: "goneBeforeV2", revision: 0, deleted: true),
            ], cursor: 0),
            mode: .bootstrap
        )
        try apply(page, store: store, database: db, runId: "run-0")
        XCTAssertEqual(try db.session(byId: "migrated")?.titleDecrypted, "Legacy")
        XCTAssertEqual(
            try db.writer.read { try store.revision($0, entity: .session, id: "goneBeforeV2") },
            .init(revision: 0, deleted: true),
            "A bootstrap tombstone is durable, so a full resync cannot reintroduce the row"
        )
    }

    /// v2 cannot advance a revision over a row it only half-read: a title,
    /// client metadata blob or queued prompt we cannot decrypt fails the page.
    func testUnreadableFieldsFailAVersionedPageButNotALegacyEntry() throws {
        let otherCrypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 4, count: 32)))
        let foreignTitle = try otherCrypto.encrypt(plaintext: "not ours")
        var payload = try sessionPayload("s1")
        payload["encryptedTitle"] = foreignTitle.encrypted
        payload["titleIv"] = foreignTitle.iv

        switch IndexReplicationPageValidator.validate(
            try response(entries: [change(entity: "session", id: "s1", revision: 3, session: payload)]),
            expectedRequestId: "r1", expectedMode: .delta, crypto: crypto
        ) {
        case .success: XCTFail("A versioned page must not apply a row it could not fully read")
        case .failure(let error): XCTAssertEqual(error, .decryptionFailed(entity: "session", id: "s1"))
        }

        // The legacy path still shows the row, without its title: dropping it
        // there would hide a session the user can otherwise open.
        let entry = try JSONDecoder().decode(
            ServerSessionEntry.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
        let lenient = IndexEntryDecryptor.decrypt(session: entry, crypto: crypto)
        XCTAssertNotNil(lenient)
        XCTAssertNil(lenient?.titleDecrypted)
    }

    func testResetIsRecognisedBeforeThePageTokenRule() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 4, session: try sessionPayload("s1")),
        ], cursor: 4)), store: store, database: db)

        // A reset is complete:false with no entries and no page token, which the
        // ordinary consistency rule would reject.
        let reset = try validated(try response(entries: [], complete: false, resetRequired: true))
        XCTAssertTrue(reset.resetRequired)
        let result = try apply(reset, store: store, database: db)
        XCTAssertNil(result.committedCursor)
        XCTAssertNotNil(try db.session(byId: "s1"), "A reset never discards cached rows")

        try db.writer.write { try store.resetReplicationEpoch($0) }
        XCTAssertEqual(try store.cursorState(db).cursor, 0)
        XCTAssertNotNil(try db.session(byId: "s1"))
    }

    // MARK: - Deletion safety

    /// `sessions.projectId` cascades. A project tombstone must not become a
    /// silent mass delete of cached sessions.
    func testProjectTombstoneNeverCascadesAwayCachedSessions() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 3, session: try sessionPayload("s1")),
        ], cursor: 3)), store: store, database: db)

        try apply(try validated(try response(entries: [
            change(entity: "project", id: try projectWireId, revision: 9, deleted: true),
        ], cursor: 9)), store: store, database: db)
        XCTAssertNotNil(try db.session(byId: "s1"), "The project's sessions are still cached, so the project row stays")
        XCTAssertEqual(try db.allProjects().count, 1)

        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 10, deleted: true),
            change(entity: "project", id: try projectWireId, revision: 11, deleted: true),
        ], cursor: 11)), store: store, database: db)
        XCTAssertEqual(try db.allProjects().count, 0, "An empty project follows its tombstone")
    }

    /// The personal index carries file metadata; document bodies belong to
    /// document sync and are never deleted from here.
    func testFileEntriesAreBookkeepingAndNeverDeleteDocumentBodies() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        try db.upsertProject(Project(id: projectPath, name: "replication"))
        try db.upsertDocument(SyncedDocument(
            id: "doc-1", projectId: projectPath, relativePath: "docs/notes.md",
            title: "Notes", contentDecrypted: "body that must survive"
        ))

        try apply(try validated(try response(entries: [
            change(entity: "file", id: "doc-1", revision: 4, file: try filePayload("doc-1")),
        ], cursor: 4)), store: store, database: db)
        let metadata = try db.writer.read { try store.fileMetadata($0, docId: "doc-1") }
        XCTAssertEqual(metadata?.relativePath, "docs/notes.md")
        XCTAssertEqual(metadata?.projectId, projectPath)

        try apply(try validated(try response(entries: [
            change(entity: "file", id: "doc-1", revision: 5, deleted: true),
        ], cursor: 5)), store: store, database: db)
        XCTAssertNil(try db.writer.read { try store.fileMetadata($0, docId: "doc-1") })
        XCTAssertEqual(try db.document(byId: "doc-1")?.contentDecrypted, "body that must survive")
    }

    /// Deleting the row cascades its messages and queued prompts. Work that
    /// exists only on this device is not the server's to destroy.
    func testTombstoneRetainsASessionHoldingUndeliveredLocalWork() throws {
        for reason in ["deleted", "expired"] {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 2, session: try sessionPayload("s1")),
        ], cursor: 2)), store: store, database: db)
        try db.updateSessionDraftInput(sessionId: "s1", draftInput: "unsent thought", draftUpdatedAt: 5)

        var removal = change(entity: "session", id: "s1", revision: 6, deleted: true)
        removal["removalReason"] = reason
        let page = try response(entries: [removal], cursor: 6)
        XCTAssertEqual(page.entries.first?.removalReason, reason)
        let result = try apply(try validated(page), store: store, database: db)
        XCTAssertEqual(result.outcome.retainedTombstones, 1)
        XCTAssertEqual(result.outcome.deletes, 0)
        XCTAssertNotNil(try db.session(byId: "s1"), "The draft outranks the remote deletion")
        XCTAssertEqual(
            try db.writer.read { try store.revision($0, entity: .session, id: "s1") },
            .init(revision: 6, deleted: true),
            "but the tombstone is recorded, so the row cannot come back as new"
        )
        XCTAssertEqual(try db.writer.read { try store.retainedTombstonedSessionIds($0) }, ["s1"])

        // Once the draft is gone the deferred deletion completes.
        try db.updateSessionDraftInput(sessionId: "s1", draftInput: nil, draftUpdatedAt: nil)
        let purged = try db.writer.write { try store.purgeRetainedTombstones($0) }
        XCTAssertEqual(purged, ["s1"])
        XCTAssertNil(try db.session(byId: "s1"))
        }
    }

    /// queuedPrompts.sessionId references sessions, so a first-ever session
    /// arriving with a remote queue must write its row before its prompts.
    func testFirstEverSessionWithARemoteQueueApplies() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        let prompt = try crypto.encrypt(plaintext: "run the tests")
        var payload = try sessionPayload("brandNew", title: "New")
        payload["queuedPromptCount"] = 1
        payload["encryptedQueuedPrompts"] = [[
            "id": "p1", "encryptedPrompt": prompt.encrypted, "iv": prompt.iv,
            "timestamp": 10, "source": "desktop",
        ]]

        try apply(try validated(try response(entries: [
            change(entity: "session", id: "brandNew", revision: 2, session: payload),
        ], cursor: 2)), store: store, database: db)

        XCTAssertNotNil(try db.session(byId: "brandNew"))
        XCTAssertEqual(try db.queuedPrompts(forSession: "brandNew").map(\.promptTextDecrypted), ["run the tests"])
        XCTAssertEqual(try store.cursorState(db).cursor, 2)
    }

    /// The lazy schema must survive a rolled-back transaction: the tables go
    /// with it, so a cached "already created" answer would fail every retry.
    func testSchemaSurvivesAFailedFirstPageAndRetrySucceeds() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        try db.writer.write { db in
            try db.execute(sql: "CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'injected'); END")
        }
        let page = try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 3, session: try sessionPayload("s1")),
        ], cursor: 3))
        XCTAssertThrowsError(try apply(page, store: store, database: db))

        try db.writer.write { db in try db.execute(sql: "DROP TRIGGER reject_session") }
        try apply(page, store: store, database: db)
        XCTAssertNotNil(try db.session(byId: "s1"))
        XCTAssertEqual(try store.cursorState(db).cursor, 3)
    }

    // MARK: - Wire identity

    /// The server keys a project by its ENCRYPTED id. Validating the entry id
    /// against the decrypted path instead rejected every real project page, and
    /// no fixture built from plaintext ids could have caught it.
    func testProjectEntriesAreKeyedByTheEncryptedWireId() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        let wireId = try projectWireId
        let projectEntry: [String: Any] = [
            "encryptedProjectId": wireId,
            "projectIdIv": CryptoManager.projectIdIvBase64,
            "sessionCount": 3,
            "lastActivityAt": 500,
        ]

        try apply(try validated(try response(entries: [
            change(entity: "project", id: wireId, revision: 4, project: projectEntry),
        ], cursor: 4)), store: store, database: db)

        // The local row keeps the decrypted path as its id...
        XCTAssertEqual(try db.allProjects().map(\.id), [projectPath])
        // ...while the revision is keyed the way the server keys it, so a second
        // device's tombstone for the same project matches this row's history.
        XCTAssertEqual(
            try db.writer.read { try store.revision($0, entity: .project, id: wireId) },
            .init(revision: 4, deleted: false)
        )
        XCTAssertNil(try db.writer.read { try store.revision($0, entity: .project, id: projectPath) })

        // A page keyed by the plaintext path is the shape that used to pass.
        switch IndexReplicationPageValidator.validate(
            try response(entries: [change(entity: "project", id: projectPath, revision: 5, project: projectEntry)]),
            expectedRequestId: "r1", expectedMode: .delta, crypto: crypto
        ) {
        case .success: XCTFail("A project entry whose id is not the wire id must be refused")
        case .failure(let error): XCTAssertEqual(error, .missingPayload(entity: "project", id: projectPath))
        }
    }

    /// A project tombstone carries only the encrypted id, so the local row it
    /// refers to has to be recovered by decrypting it.
    func testProjectTombstoneResolvesTheLocalRowFromTheEncryptedId() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        try db.upsertProject(Project(id: projectPath, name: "replication"))

        try apply(try validated(try response(entries: [
            change(entity: "project", id: try projectWireId, revision: 12, deleted: true),
        ], cursor: 12)), store: store, database: db)

        XCTAssertEqual(try db.allProjects().count, 0, "The empty project followed its tombstone")
        XCTAssertEqual(
            try db.writer.read { try store.revision($0, entity: .project, id: try projectWireId) },
            .init(revision: 12, deleted: true)
        )
    }

    // MARK: - Cursor provenance

    /// The cursor is only ever what the server stated. A bootstrap page can
    /// carry a row newer than the range its terminal proves, so inferring the
    /// cursor from the highest entry revision would skip everything between.
    func testCursorIsNeverInferredFromEntryRevisions() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        // Terminal with no cursor is malformed, not "cursor 0" and not
        // "cursor = highest revision".
        switch IndexReplicationPageValidator.validate(
            try response(entries: [
                change(entity: "session", id: "s1", revision: 900, session: try sessionPayload("s1")),
            ]),
            expectedRequestId: "r1", expectedMode: .delta, crypto: crypto
        ) {
        case .success: XCTFail("A terminal page must state its cursor")
        case .failure(let error): XCTAssertEqual(error, .missingTerminalCursor)
        }

        switch IndexReplicationPageValidator.validate(
            try response(entries: [], cursor: -1),
            expectedRequestId: "r1", expectedMode: .delta, crypto: crypto
        ) {
        case .success: XCTFail("A negative cursor is nonsense")
        case .failure(let error): XCTAssertEqual(error, .invalidCursor(-1))
        }

        // A partial BOOTSTRAP page proves nothing even when it carries a cursor.
        let partialBootstrap = try validated(
            try response(mode: "bootstrap", entries: [
                change(entity: "session", id: "b1", revision: 700, session: try sessionPayload("b1")),
            ], complete: false, nextPageToken: "next", cursor: 700),
            mode: .bootstrap
        )
        XCTAssertNil(partialBootstrap.committableCursor)
        try apply(partialBootstrap, store: store, database: db, runId: "run-1")
        XCTAssertEqual(try store.cursorState(db).cursor, 0)

        // A partial DELTA page may commit the cursor the server supplied: it
        // only sends one for a contiguous prefix.
        let partialDelta = try validated(try response(entries: [
            change(entity: "session", id: "d1", revision: 800, session: try sessionPayload("d1")),
        ], complete: false, nextPageToken: "next", cursor: 750))
        XCTAssertEqual(partialDelta.committableCursor, 750)
        try apply(partialDelta, store: store, database: db)
        XCTAssertEqual(try store.cursorState(db).cursor, 750, "and never the 800 that happened to be on the page")
    }

    // MARK: - Cancellation

    /// Task.isCancelled cannot see the task from inside a GRDB write closure --
    /// that block runs on the database queue -- so a retired generation would
    /// have written the whole batch and its cursor anyway. The explicit flag is
    /// what actually stops it.
    func testARetiredGenerationWritesNothingInsideTheTransaction() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        let cancellation = IndexIngestionCancellation()
        let page = try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 30, session: try sessionPayload("s1", title: "Retired")),
        ], cursor: 30))

        cancellation.cancel()
        XCTAssertThrowsError(
            try IndexReplicationApplier.apply(page, store: store, database: db, cancellation: cancellation)
        ) { error in
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertNil(try db.session(byId: "s1"))
        XCTAssertEqual(try store.cursorState(db).cursor, 0)

        // Reconciliation stops between transactions and leaves its marker, so
        // the next connection resumes rather than re-enumerating.
        try db.writer.write { db in
            try store.ensureSchema(db)
            try store.beginFinalization(db, runId: "run-c", cursor: 90)
        }
        let finalization = try IndexReplicationApplier.finalizeBootstrap(
            runId: "run-c", store: store, database: db, cancellation: cancellation
        )
        XCTAssertTrue(finalization.cancelled)
        XCTAssertFalse(try store.cursorState(db).historyComplete, "Cancelled recovery claims no coverage")
        XCTAssertEqual(
            try db.writer.read { try store.pendingFinalization($0) },
            .init(runId: "run-c", cursor: 90),
            "and leaves the work to be resumed"
        )
    }

    /// A retained tombstone whose local work is gone must not sit behind rows
    /// that are still protected. Taking the first N tombstoned rows and then
    /// filtering would return only the protected ones and purge nothing, forever.
    func testTombstonePurgeIsNotStarvedByProtectedRows() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()
        let entries = try (0..<3).map { index in
            change(entity: "session", id: "s\(index)", revision: 1 + index, session: try sessionPayload("s\(index)"))
        }
        try apply(try validated(try response(entries: entries, cursor: 6)), store: store, database: db)

        // All three hold an unsent draft, so all three survive their tombstones.
        for index in 0..<3 {
            try db.updateSessionDraftInput(sessionId: "s\(index)", draftInput: "unsent", draftUpdatedAt: 1)
        }
        try apply(try validated(try response(entries: (0..<3).map {
            change(entity: "session", id: "s\($0)", revision: 20 + $0, deleted: true)
        }, cursor: 30)), store: store, database: db)
        XCTAssertEqual(try db.writer.read { try store.retainedTombstonedSessionIds($0) }.count, 3)

        // The LAST one's draft is delivered; the two ahead of it stay protected.
        try db.updateSessionDraftInput(sessionId: "s2", draftInput: nil, draftUpdatedAt: nil)

        let purged = try db.writer.write { try store.purgeRetainedTombstones($0, limit: 1) }
        XCTAssertEqual(purged, ["s2"], "The eligible row is found even behind protected ones")
        XCTAssertNotNil(try db.session(byId: "s0"))
        XCTAssertNotNil(try db.session(byId: "s1"))
        XCTAssertNil(try db.session(byId: "s2"))
    }

    // MARK: - Reset recovery

    /// A reset can mean the server's room was RESTORED, so its head is lower
    /// than what we cached: a room at revision 100 rebuilt to revision 5.
    ///
    /// Keeping the old per-row revisions through that reset would make the whole
    /// fresh bootstrap look stale -- every row rejected, nothing updated -- while
    /// the terminal still committed historyComplete. The account would sit
    /// forever on metadata from before the reset with nothing on screen to
    /// suggest it, which is the worst shape this system can be in.
    func testResetLetsALowerRevisionServerRebuildTheCache() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        // Cached from the old epoch, at a revision far above the rebuilt room's.
        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 100, session: try sessionPayload("s1", title: "Before the reset")),
            change(entity: "session", id: "gone", revision: 99, deleted: true),
        ], cursor: 100)), store: store, database: db)
        try db.updateSessionDraftInput(sessionId: "s1", draftInput: "unsent local text", draftUpdatedAt: 1)
        // And a finalization owed from that epoch, whose cursor must never land.
        try db.writer.write { db in
            try store.ensureSchema(db)
            try store.beginFinalization(db, runId: "old-run", cursor: 100)
            try store.recordSeen(db, runId: "old-run", entity: .session, id: "s1")
        }

        try db.writer.write { try store.resetReplicationEpoch($0) }

        // Cached rows survive the reset: absence is proven by the new bootstrap,
        // never by the reset itself.
        XCTAssertNotNil(try db.session(byId: "s1"))
        XCTAssertEqual(try db.session(byId: "s1")?.draftInput, "unsent local text")
        // Every piece of old-epoch bookkeeping is gone.
        XCTAssertNil(try db.writer.read { try store.revision($0, entity: .session, id: "s1") })
        XCTAssertNil(try db.writer.read { try store.pendingFinalization($0) }, "An owed finalization cannot commit the pre-reset cursor")
        XCTAssertEqual(try db.writer.read { try store.seenCount($0, runId: "old-run") }, 0)
        XCTAssertEqual(try store.cursorState(db), IndexReplicationCursorState(cursor: 0, historyComplete: false))

        // The rebuilt room's canonical bootstrap, at revision 5, now applies.
        let terminal = try validated(
            try response(mode: "bootstrap", entries: [
                change(entity: "session", id: "s1", revision: 5, session: try sessionPayload("s1", title: "After the rebuild")),
            ], cursor: 5),
            mode: .bootstrap
        )
        let result = try apply(terminal, store: store, database: db, runId: "new-run")
        XCTAssertEqual(result.outcome.staleRejected, 0, "Revision 5 is not stale against a cleared epoch")
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "After the rebuild")
        XCTAssertEqual(try db.session(byId: "s1")?.draftInput, "unsent local text", "and the local draft is still there")

        try IndexReplicationApplier.finalizeBootstrap(runId: "new-run", store: store, database: db)
        XCTAssertEqual(try store.cursorState(db), IndexReplicationCursorState(cursor: 5, historyComplete: true))

        // Revision protection is live again in the new epoch: a page from before
        // revision 5 loses, and a later one wins.
        let stale = try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 3, session: try sessionPayload("s1", title: "Stale")),
        ], cursor: 5)), store: store, database: db)
        XCTAssertEqual(stale.outcome.staleRejected, 1)
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "After the rebuild")

        try apply(try validated(try response(entries: [
            change(entity: "session", id: "s1", revision: 7, session: try sessionPayload("s1", title: "Newer again")),
        ], cursor: 7)), store: store, database: db)
        XCTAssertEqual(try db.session(byId: "s1")?.titleDecrypted, "Newer again")
    }

    // MARK: - Bootstrap coverage

    /// Coverage is proven from SQLite, and reconciliation removes only what the
    /// server can account for.
    func testBootstrapCoverageReconcilesAbsentRowsButSparesLocalWork() throws {
        let db = try DatabaseManager()
        let store = IndexReplicationStore()

        // Four cached sessions from an earlier legacy sync.
        try apply(try validated(try response(entries: [
            change(entity: "session", id: "listed", revision: 1, session: try sessionPayload("listed")),
            change(entity: "session", id: "alreadyCurrent", revision: 2, session: try sessionPayload("alreadyCurrent")),
            change(entity: "session", id: "abandoned", revision: 3, session: try sessionPayload("abandoned")),
            change(entity: "session", id: "hasDraft", revision: 4, session: try sessionPayload("hasDraft")),
            change(entity: "session", id: "hasLocalPrompt", revision: 5, session: try sessionPayload("hasLocalPrompt")),
        ], cursor: 5)), store: store, database: db)
        try db.updateSessionDraftInput(sessionId: "hasDraft", draftInput: "unsent", draftUpdatedAt: 1)
        try db.writer.write { db in
            try QueuedPrompt(
                id: "p1", sessionId: "hasLocalPrompt", promptTextEncrypted: "x", iv: "y",
                createdAt: 1, sentAt: nil, promptTextDecrypted: "local", source: nil
            ).save(db)
        }

        // The enumeration lists two rows: one new, one whose revision we already
        // hold. A stale entry is still coverage -- the server listed it.
        let terminal = try validated(
            try response(mode: "bootstrap", entries: [
                change(entity: "session", id: "listed", revision: 6, session: try sessionPayload("listed", title: "Fresh")),
                change(entity: "session", id: "alreadyCurrent", revision: 2, session: try sessionPayload("alreadyCurrent")),
            ], cursor: 6),
            mode: .bootstrap
        )
        let result = try apply(terminal, store: store, database: db, runId: "run-1")
        XCTAssertEqual(result.outcome.staleRejected, 1)
        XCTAssertEqual(try db.writer.read { try store.seenCount($0, runId: "run-1") }, 2)

        let finalized = try IndexReplicationApplier.finalizeBootstrap(runId: "run-1", store: store, database: db)
        XCTAssertTrue(try store.cursorState(db).historyComplete)
        XCTAssertEqual(finalized.removedCount, 1)
        let removed = finalized.removedSampleIds
        XCTAssertNotNil(try db.session(byId: "listed"))
        XCTAssertNotNil(try db.session(byId: "alreadyCurrent"), "A row listed but not rewritten is covered, not absent")
        XCTAssertNotNil(try db.session(byId: "hasDraft"), "An unsent draft outranks a reconciliation pass")
        XCTAssertNotNil(try db.session(byId: "hasLocalPrompt"), "So does a prompt this device has not delivered yet")
        XCTAssertEqual(try db.writer.read { try store.seenCount($0, runId: "run-1") }, 0, "The run's coverage set is released")
    }
}
