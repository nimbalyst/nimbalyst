import XCTest
@testable import NimbalystNative

/// Integration tests that verify the crypto -> database pipeline works end-to-end.
/// Simulates the SyncManager flow: receive encrypted server data, decrypt it,
/// store in SQLite, and verify the results.
final class SyncIntegrationTests: XCTestCase {

    // Same test vectors as CryptoCompatibility
    static let passphrase = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw=="
    static let userId = "user-test-12345"

    var crypto: CryptoManager!
    var database: DatabaseManager!

    override func setUpWithError() throws {
        crypto = CryptoManager(seed: Self.passphrase, userId: Self.userId)
        database = try DatabaseManager()
    }

    /// Simulate receiving a server session entry, decrypting it, and storing it.
    func testDecryptAndStoreSession() throws {
        // Encrypt a project ID deterministically (like the desktop does)
        let projectPath = "/Users/ghinkle/sources/stravu-editor"
        let encryptedProjectId = try crypto.encryptProjectId(projectPath)

        // Encrypt a session title (like the desktop does)
        let (encryptedTitle, titleIv) = try crypto.encrypt(plaintext: "Fix auth bug in login flow")

        // Simulate decryption (like SyncManager does)
        let decryptedProjectId = try crypto.decrypt(
            encryptedBase64: encryptedProjectId,
            ivBase64: CryptoManager.projectIdIvBase64
        )
        XCTAssertEqual(decryptedProjectId, projectPath)

        let decryptedTitle = try crypto.decrypt(encryptedBase64: encryptedTitle, ivBase64: titleIv)
        XCTAssertEqual(decryptedTitle, "Fix auth bug in login flow")

        // Store in database (like SyncManager does)
        let project = Project.from(workspacePath: decryptedProjectId)
        try database.upsertProject(project)

        let session = Session(
            id: "session-abc-123",
            projectId: decryptedProjectId,
            titleEncrypted: encryptedTitle,
            titleIv: titleIv,
            titleDecrypted: decryptedTitle,
            provider: "claude",
            mode: "agent",
            createdAt: 1000,
            updatedAt: 2000
        )
        try database.upsertSession(session)

        // Verify stored data
        let projects = try database.allProjects()
        XCTAssertEqual(projects.count, 1)
        XCTAssertEqual(projects[0].id, projectPath)
        XCTAssertEqual(projects[0].name, "stravu-editor")

        let sessions = try database.sessions(forProject: projectPath)
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].titleDecrypted, "Fix auth bug in login flow")
        XCTAssertEqual(sessions[0].provider, "claude")
        XCTAssertEqual(sessions[0].mode, "agent")
    }

    /// Simulate receiving an index_sync_response with multiple sessions.
    func testBulkSyncWithMultipleSessions() throws {
        let projectPath = "/Users/test/project"

        // Create project
        let project = Project.from(workspacePath: projectPath)
        try database.upsertProject(project)

        // Simulate 3 sessions with encrypted titles
        let titles = ["Session 1: Bug fix", "Session 2: Feature work", "Session 3: Refactor"]
        for (i, title) in titles.enumerated() {
            let (encTitle, titleIv) = try crypto.encrypt(plaintext: title)
            let decryptedTitle = try crypto.decrypt(encryptedBase64: encTitle, ivBase64: titleIv)

            let session = Session(
                id: "session-\(i)",
                projectId: projectPath,
                titleEncrypted: encTitle,
                titleIv: titleIv,
                titleDecrypted: decryptedTitle,
                provider: "claude",
                createdAt: 1000 + i,
                updatedAt: 2000 + i
            )
            try database.upsertSession(session)
        }

        // Verify all sessions stored correctly
        let sessions = try database.sessions(forProject: projectPath)
        XCTAssertEqual(sessions.count, 3)

        // Sessions are ordered by updatedAt desc
        XCTAssertEqual(sessions[0].titleDecrypted, "Session 3: Refactor")
        XCTAssertEqual(sessions[1].titleDecrypted, "Session 2: Feature work")
        XCTAssertEqual(sessions[2].titleDecrypted, "Session 1: Bug fix")
    }

    /// Simulate an index_broadcast that updates an existing session.
    func testSessionUpsertUpdatesExisting() throws {
        let projectPath = "/Users/test/project"
        let project = Project.from(workspacePath: projectPath)
        try database.upsertProject(project)

        // Initial session
        let (title1, iv1) = try crypto.encrypt(plaintext: "Original title")
        let session1 = Session(
            id: "session-1",
            projectId: projectPath,
            titleEncrypted: title1,
            titleIv: iv1,
            titleDecrypted: "Original title",
            provider: "claude",
            isExecuting: false,
            createdAt: 1000,
            updatedAt: 1000
        )
        try database.upsertSession(session1)

        // Broadcast update (same ID, new title, now executing)
        let (title2, iv2) = try crypto.encrypt(plaintext: "Updated title")
        let session2 = Session(
            id: "session-1",
            projectId: projectPath,
            titleEncrypted: title2,
            titleIv: iv2,
            titleDecrypted: "Updated title",
            provider: "claude",
            isExecuting: true,
            createdAt: 1000,
            updatedAt: 2000
        )
        try database.upsertSession(session2)

        // Verify upsert replaced the session
        let sessions = try database.sessions(forProject: projectPath)
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(sessions[0].titleDecrypted, "Updated title")
        XCTAssertEqual(sessions[0].isExecuting, true)
    }

    /// Verify decryptOrNil handles missing title gracefully.
    func testSessionWithMissingTitle() throws {
        let projectPath = "/Users/test/project"
        let project = Project.from(workspacePath: projectPath)
        try database.upsertProject(project)

        // Session with no encrypted title (like a newly created session)
        let titleDecrypted = crypto.decryptOrNil(encryptedBase64: nil, ivBase64: nil)
        XCTAssertNil(titleDecrypted)

        let session = Session(
            id: "session-no-title",
            projectId: projectPath,
            titleDecrypted: titleDecrypted,
            provider: "claude",
            createdAt: 1000,
            updatedAt: 1000
        )
        try database.upsertSession(session)

        let sessions = try database.sessions(forProject: projectPath)
        XCTAssertEqual(sessions.count, 1)
        XCTAssertNil(sessions[0].titleDecrypted)
    }
}
