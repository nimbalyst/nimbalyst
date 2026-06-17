import XCTest
@testable import NimbalystNative

/// Tests for DocumentSyncManager.awaitDocument -- the on-demand resolution used
/// when a user taps a transcript link for a doc that may not have synced yet.
@MainActor
final class DocumentSyncAwaitTests: XCTestCase {

    private let projectId = "/Users/test/project"

    private func makeManager(_ db: DatabaseManager) -> DocumentSyncManager {
        let crypto = CryptoManager(seed: "test-passphrase-1234567890", userId: "user-1")
        return DocumentSyncManager(
            crypto: crypto,
            database: db,
            serverUrl: "wss://example.invalid",
            userId: "user-1"
        )
        // Note: no setAuth() -> connectProject() is a no-op, so awaitDocument
        // exercises only the local-DB resolution/poll path (no real network).
    }

    private func seedProject(_ db: DatabaseManager) throws {
        try db.upsertProject(Project(id: projectId, name: "project"))
    }

    private func makeDoc(relativePath: String) -> SyncedDocument {
        SyncedDocument(
            id: "sync-\(relativePath)",
            projectId: projectId,
            relativePath: relativePath,
            title: (relativePath as NSString).lastPathComponent
        )
    }

    func testReturnsImmediatelyWhenAlreadySynced() async throws {
        let db = try DatabaseManager()
        try seedProject(db)
        try db.upsertDocument(makeDoc(relativePath: "design/already.md"))

        let manager = makeManager(db)
        let resolved = await manager.awaitDocument(
            projectId: projectId,
            relativePath: "design/already.md",
            timeout: 1.0
        )

        XCTAssertNotNil(resolved)
        XCTAssertEqual(resolved?.relativePath, "design/already.md")
    }

    func testResolvesWhenDocumentArrivesAfterTap() async throws {
        let db = try DatabaseManager()
        try seedProject(db)

        let manager = makeManager(db)

        // Simulate the doc landing shortly after the user taps the link (as a
        // fileContentBroadcast / sync response would upsert it).
        Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            try? db.upsertDocument(makeDoc(relativePath: "design/incoming.md"))
        }

        let resolved = await manager.awaitDocument(
            projectId: projectId,
            relativePath: "design/incoming.md",
            timeout: 3.0
        )

        XCTAssertNotNil(resolved, "awaitDocument should resolve once the doc syncs in")
        XCTAssertEqual(resolved?.relativePath, "design/incoming.md")
    }

    func testReturnsNilWhenDocumentNeverArrives() async throws {
        let db = try DatabaseManager()
        try seedProject(db)

        let manager = makeManager(db)
        let resolved = await manager.awaitDocument(
            projectId: projectId,
            relativePath: "design/missing.md",
            timeout: 0.6
        )

        XCTAssertNil(resolved)
    }
}
