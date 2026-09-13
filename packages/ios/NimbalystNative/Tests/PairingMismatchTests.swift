import XCTest
import Combine
import CryptoKit
import GRDB
@testable import NimbalystNative

@MainActor
final class PairingMismatchTests: XCTestCase {
    private let crypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 1, count: 32)))
    private let otherCrypto = CryptoManager(key: SymmetricKey(data: Data(repeating: 2, count: 32)))

    private func session(_ id: String, valid: Bool = true) throws -> [String: Any] {
        ["sessionId": id, "encryptedProjectId": try (valid ? crypto : otherCrypto).encryptProjectId("/test/project"),
         "projectIdIv": CryptoManager.projectIdIvBase64, "createdAt": 1, "updatedAt": 2]
    }

    private func manager(_ db: DatabaseManager) -> SyncManager {
        SyncManager(crypto: crypto, database: db, serverUrl: "https://invalid.example", userId: "test", registerDeviceCallbacks: false)
    }

    private func receive(_ sync: SyncManager, sessions: [[String: Any]], projects: [[String: Any]] = [], since: Int? = nil, total: Int? = nil) async throws {
        var payload: [String: Any] = ["type": "indexSyncResponse", "sessions": sessions, "projects": projects]
        if let since { payload["since"] = since }
        if let total { payload["totalSessionCount"] = total }
        let completed = expectation(description: "Index import finished")
        let subscription = sync.$indexLoadState.dropFirst().filter { $0 != .loading }.prefix(1).sink { _ in completed.fulfill() }
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: payload))
        await fulfillment(of: [completed], timeout: 5)
        subscription.cancel()
    }

    func testDatabaseWriteFailuresDoNotRequestRepair() async throws {
        let db = try DatabaseManager()
        try await db.writer.write { db in
            try db.execute(sql: "CREATE TRIGGER reject_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(FAIL, 'injected storage failure'); END")
        }
        let sync = manager(db)
        try await receive(sync, sessions: (0..<6).map { try session("s\($0)") })
        XCTAssertEqual(sync.indexLoadState, .failed)
        XCTAssertFalse(sync.encryptionKeyMismatch, "A SQLite failure does not prove the pairing key is wrong")
    }

    func testUnchangedHealthySessionPreventsRepairForBadEntries() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)
        let healthy = try session("healthy")
        try await receive(sync, sessions: [healthy])
        try await receive(sync, sessions: [healthy] + (0..<6).map { try session("bad\($0)", valid: false) })
        XCTAssertNotNil(try db.session(byId: "healthy"))
        XCTAssertEqual(sync.indexLoadState, .failed)
        XCTAssertFalse(sync.encryptionKeyMismatch)
    }

    func testMixedKeysDoNotClaimDeviceKeyMismatch() async throws {
        let db = try DatabaseManager()
        let sync = manager(db)
        try await receive(sync, sessions: [try session("healthy")] + (0..<6).map { try session("bad\($0)", valid: false) })
        XCTAssertFalse(sync.encryptionKeyMismatch)
    }

    func testPreviouslyAuthenticatedIndexPreventsLaterRepairWarning() async throws {
        let sync = manager(try DatabaseManager())
        try await receive(sync, sessions: [try session("healthy")])
        try await receive(sync, sessions: (0..<6).map { try session("bad\($0)", valid: false) })
        XCTAssertFalse(sync.encryptionKeyMismatch, "This manager already proved its immutable key can decrypt index data")
    }

    func testIncrementalFailuresDoNotRequestRepair() async throws {
        let sync = manager(try DatabaseManager())
        try await receive(sync, sessions: (0..<6).map { try session("bad\($0)", valid: false) }, since: 1)
        XCTAssertEqual(sync.indexLoadState, .failed)
        XCTAssertFalse(sync.encryptionKeyMismatch)
    }

    func testDecryptableProjectPreventsRepairForBadSessions() async throws {
        let sync = manager(try DatabaseManager())
        let project: [String: Any] = ["encryptedProjectId": try crypto.encryptProjectId("/test/project"), "projectIdIv": CryptoManager.projectIdIvBase64]
        try await receive(sync, sessions: (0..<6).map { try session("bad\($0)", valid: false) }, projects: [project])
        XCTAssertFalse(sync.encryptionKeyMismatch)
    }

    func testTruncatedFullResponseDoesNotRequestRepair() async throws {
        let sync = manager(try DatabaseManager())
        try await receive(sync, sessions: (0..<6).map { try session("bad\($0)", valid: false) }, total: 100)
        XCTAssertFalse(sync.encryptionKeyMismatch)
    }

    func testFullyWrongKeyStillSuggestsRepairAndSuccessfulRetryClearsIt() async throws {
        let sync = manager(try DatabaseManager())
        try await receive(sync, sessions: (0..<6).map { try session("bad\($0)", valid: false) }, total: 6)
        XCTAssertTrue(sync.encryptionKeyMismatch)
        try await receive(sync, sessions: [try session("healthy")], since: 1)
        XCTAssertEqual(sync.indexLoadState, .loaded)
        XCTAssertFalse(sync.encryptionKeyMismatch, "Successful decryption invalidates the earlier key mismatch inference")
    }
}
