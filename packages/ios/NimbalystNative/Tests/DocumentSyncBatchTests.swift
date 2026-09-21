import XCTest
@testable import NimbalystNative

@MainActor
final class DocumentSyncBatchTests: XCTestCase {
    private let project = "/test/documents"

    /// The offline queue used to be cleared before any send outcome was known,
    /// so a replay that raced the socket going down again dropped every queued
    /// edit -- the one thing the queue exists to prevent.
    func testFailedOfflineReplayKeepsTheQueueInOrder() throws {
        let (_, _, manager) = try fixture()
        manager.pushYjsUpdate(syncId: "doc-1", encryptedUpdate: "one", iv: "iv1", projectId: project)
        manager.pushYjsUpdate(syncId: "doc-2", encryptedUpdate: "two", iv: "iv2", projectId: project)
        manager.pushYjsUpdate(syncId: "doc-3", encryptedUpdate: "three", iv: "iv3", projectId: project)
        XCTAssertEqual(manager.queuedMessageCount(for: project), 3)

        var attempted: [String] = []
        manager.replayOfflineQueue(projectId: project) { json, completion in
            attempted.append(json)
            completion(NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket gone"]))
        }
        XCTAssertEqual(attempted.count, 3)
        XCTAssertEqual(manager.queuedMessageCount(for: project), 3, "A refused replay must not empty the queue")

        var sent: [String] = []
        manager.replayOfflineQueue(projectId: project) { json, completion in
            sent.append(json)
            completion(nil)
        }
        XCTAssertEqual(sent, attempted, "The requeued messages replay in their original order")
        XCTAssertEqual(manager.queuedMessageCount(for: project), 0, "An accepted replay drains the queue")
    }

    func testPartialBatchMetadataCannotImportOrComplete() throws {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: project, name: "Documents"))
        let crypto = CryptoManager(seed: "test-seed", userId: "test-user")
        let manager = DocumentSyncManager(crypto: crypto, database: db, serverUrl: "https://invalid.example", userId: "test-user")
        let payload = try response(crypto: crypto, ids: ["a"], metadata: ["transferId": "incomplete"])
        manager.handleMessage(payload, projectId: project)
        XCTAssertTrue(try db.documents(forProject: project).isEmpty, "Malformed batch metadata must fail before importing any files")
        guard case .failed = manager.state(for: project) else { return XCTFail("Invalid batches must surface failure") }
    }

    func testBatchesApplyProgressivelyAndOnlyFinalBatchCompletes() throws {
        let (db, crypto, manager) = try fixture()
        manager.beginTransfer(project)
        manager.handleMessage(try response(crypto: crypto, ids: ["a"], metadata: batch(0, last: false)), projectId: project)
        XCTAssertEqual(manager.state(for: project), .syncing(received: 1))
        XCTAssertEqual(try db.documents(forProject: project).map(\.id), ["a"])
        let cached = try XCTUnwrap(db.document(byId: "a"))
        XCTAssertNil(cached.contentDecrypted)
        XCTAssertNotNil(cached.encryptedContent, "Small batches must still defer content decryption")
        manager.handleMessage(try response(crypto: crypto, ids: ["b"], metadata: batch(1, last: true)), projectId: project)
        XCTAssertEqual(manager.state(for: project), .ready)
        XCTAssertEqual(try db.documents(forProject: project).count, 2)
        XCTAssertEqual(manager.decryptContentOnDemand(cached), "# Content")

        manager.beginTransfer(project)
        manager.handleMessage(try response(crypto: crypto, ids: []), projectId: project)
        XCTAssertEqual(manager.state(for: project), .ready, "Legacy servers complete in one response")
        XCTAssertEqual(try db.documents(forProject: project).count, 2, "An empty response never clears cached documents")
    }

    func testDatabaseFailureRollsBackWholeBatchAndRetryReplaysPartialCache() throws {
        let (db, crypto, manager) = try fixture()
        manager.beginTransfer(project)
        manager.handleMessage(try response(crypto: crypto, ids: ["cached"], metadata: batch(0, last: false)), projectId: project)
        try db.writer.write { db in
            try db.execute(sql: "CREATE TRIGGER reject_document BEFORE INSERT ON syncedDocuments WHEN NEW.id = 'reject' BEGIN SELECT RAISE(ABORT, 'test write failure'); END")
        }
        manager.handleMessage(try response(crypto: crypto, ids: ["new", "reject"], metadata: batch(1, last: true)), projectId: project)
        guard case .failed = manager.state(for: project) else { return XCTFail("Write failure must not complete") }
        XCTAssertEqual(try db.documents(forProject: project).map(\.id), ["cached"], "A failing batch cannot leave a partial import")
        try db.writer.write { try $0.execute(sql: "DROP TRIGGER reject_document") }
        manager.beginTransfer(project)
        manager.handleMessage(try response(crypto: crypto, ids: ["new", "reject"], metadata: batch(0, last: true, id: "retry")), projectId: project)
        XCTAssertEqual(manager.state(for: project), .ready)
        XCTAssertEqual(try db.documents(forProject: project).count, 3)
    }

    func testMalformedOutOfOrderAndInterruptedTransfersRemainFailures() async throws {
        let (db, crypto, manager) = try fixture(timeout: .milliseconds(30))
        for metadata in [batch(1, last: true), ["transferId": "t"], batch(-1, last: true), ["transferId": NSNull(), "batchIndex": NSNull(), "isLastBatch": NSNull()]] {
            manager.beginTransfer(project)
            manager.handleMessage(try response(crypto: crypto, ids: ["bad"], metadata: metadata), projectId: project)
            guard case .failed = manager.state(for: project) else { return XCTFail("Invalid order accepted") }
            XCTAssertTrue(try db.documents(forProject: project).isEmpty)
        }
        manager.beginTransfer(project)
        manager.handleMessage(try response(crypto: crypto, ids: ["a"], metadata: batch(0, last: false)), projectId: project)
        manager.handleMessage(try response(crypto: crypto, ids: ["b"], metadata: batch(1, last: true, id: "wrong-transfer")), projectId: project)
        guard case .failed = manager.state(for: project) else { return XCTFail("Wrong transfer accepted") }
        XCTAssertEqual(try db.documents(forProject: project).map(\.id), ["a"])
        manager.beginTransfer(project)
        manager.handleMessage(Data("{invalid".utf8), projectId: project)
        guard case .failed = manager.state(for: project) else { return XCTFail("Invalid JSON accepted") }
        manager.beginTransfer(project)
        manager.handleMessage(try response(crypto: crypto, ids: [], metadata: batch(0, last: false)), projectId: project)
        try await Task.sleep(for: .milliseconds(80))
        guard case .failed = manager.state(for: project) else { return XCTFail("Missing terminal batch must time out") }
        XCTAssertEqual(try db.documents(forProject: project).count, 1)
        manager.disconnectAll()
    }

    private func fixture(timeout: Duration = .seconds(30)) throws -> (DatabaseManager, CryptoManager, DocumentSyncManager) {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: project, name: "Documents"))
        let crypto = CryptoManager(seed: "test-seed", userId: "test-user")
        return (db, crypto, DocumentSyncManager(crypto: crypto, database: db, serverUrl: "https://invalid.example", userId: "test-user", transferTimeout: timeout))
    }

    private func batch(_ index: Int, last: Bool, id: String = "transfer") -> [String: Any] {
        ["transferId": id, "batchIndex": index, "isLastBatch": last]
    }

    private func response(crypto: CryptoManager, ids: [String], metadata: [String: Any] = [:]) throws -> Data {
        let (content, contentIv) = try crypto.encrypt(plaintext: "# Content")
        let (title, titleIv) = try crypto.encrypt(plaintext: "Test")
        let files: [[String: Any]] = try ids.map { id in
            let (path, pathIv) = try crypto.encrypt(plaintext: "\(id).md")
            return ["syncId": id, "encryptedContent": content, "contentIv": contentIv, "contentHash": "hash", "encryptedPath": path, "pathIv": pathIv, "encryptedTitle": title, "titleIv": titleIv, "lastModifiedAt": 1, "hasYjs": false] }
        var payload: [String: Any] = ["type": "projectSyncResponse", "updatedFiles": [], "newFiles": files, "yjsUpdates": [], "needFromClient": [], "deletedSyncIds": []]
        payload.merge(metadata) { _, new in new }
        return try JSONSerialization.data(withJSONObject: payload)
    }
}
