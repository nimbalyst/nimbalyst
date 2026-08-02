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

    func testEncryptedUnavailableContextMeterClearsLegacyDisplayAndPersists() throws {
        let projectPath = "/Users/test/context"
        try database.upsertProject(Project.from(workspacePath: projectPath))
        let clientJson = """
        {"currentContext":{"tokens":42000,"contextWindow":200000},"contextMeterState":{"schemaVersion":1,"confidence":"unavailable","reason":"thread-reset"}}
        """
        let encrypted = try crypto.encrypt(plaintext: clientJson)
        let decrypted = try crypto.decrypt(
            encryptedBase64: encrypted.encrypted,
            ivBase64: encrypted.iv
        )
        let metadata = try JSONDecoder().decode(
            ClientMetadata.self,
            from: Data(decrypted.utf8)
        )
        let resolved = resolveContextMeterMetadata(
            metadata,
            existingStateJson: nil,
            existingTokens: 42_000,
            existingWindow: 200_000
        )
        XCTAssertNil(resolved.tokens)
        XCTAssertNil(resolved.window)
        XCTAssertNotNil(resolved.stateJson)

        try database.upsertSession(Session(
            id: "context-sync",
            projectId: projectPath,
            contextTokens: resolved.tokens,
            contextWindow: resolved.window,
            contextMeterStateJson: resolved.stateJson,
            createdAt: 1,
            updatedAt: 2
        ))
        let stored = try database.session(byId: "context-sync")
        XCTAssertNil(stored?.contextTokens)
        XCTAssertNil(stored?.contextWindow)
        XCTAssertEqual(stored?.contextMeterState?.reason, "thread-reset")
    }

    func testContextMeterValidatorRejectsImpossibleAndInconsistentStates() {
        let provenance = sampleContextMeterProvenance()
        XCTAssertTrue(ContextMeterStateV1(
            schemaVersion: 1,
            confidence: .exact,
            fillTokens: 42_000,
            effectiveWindowTokens: 200_000,
            reason: nil,
            provenance: provenance
        ).isValid)
        let invalidStates = [
            ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .exact,
                fillTokens: 200_001,
                effectiveWindowTokens: 200_000,
                reason: nil,
                provenance: provenance
            ),
            ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .exact,
                fillTokens: 42_000,
                effectiveWindowTokens: 200_000,
                reason: nil,
                provenance: sampleContextMeterProvenance(observedAtMs: 9_007_199_254_740_992)
            ),
            ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .exact,
                fillTokens: 42_000,
                effectiveWindowTokens: 200_000,
                reason: nil,
                provenance: sampleContextMeterProvenance(providerModelId: " ")
            ),
            ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .exact,
                fillTokens: 42_000,
                effectiveWindowTokens: 200_000,
                reason: nil,
                provenance: sampleContextMeterProvenance(
                    contextWindowSeedTokens: 2_000_001,
                    invalidationReason: "not-a-reason"
                )
            ),
            ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .exact,
                fillTokens: 42_000,
                effectiveWindowTokens: 200_000,
                reason: nil,
                provenance: sampleContextMeterProvenance(
                    denominatorSource: "none",
                    runtimeWindowTokens: nil
                )
            ),
            ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .estimated,
                fillTokens: 42_000,
                effectiveWindowTokens: 200_000,
                reason: nil,
                provenance: provenance
            ),
            ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .unavailable,
                fillTokens: nil,
                effectiveWindowTokens: nil,
                reason: "thread-reset",
                provenance: sampleContextMeterProvenance(turnId: " ")
            )
        ]

        invalidStates.forEach { XCTAssertFalse($0.isValid) }
    }

    func testInvalidIncomingContextMeterPreservesTrustedStateAndNumericMirrors() throws {
        let trusted = ContextMeterStateV1(
            schemaVersion: 1,
            confidence: .exact,
            fillTokens: 42_000,
            effectiveWindowTokens: 200_000,
            reason: nil,
            provenance: sampleContextMeterProvenance()
        )
        let trustedJson = String(data: try JSONEncoder().encode(trusted), encoding: .utf8)!
        let invalid = ContextMeterStateV1(
            schemaVersion: 1,
            confidence: .exact,
            fillTokens: 250_000,
            effectiveWindowTokens: 200_000,
            reason: nil,
            provenance: sampleContextMeterProvenance()
        )

        XCTAssertEqual(
            resolveContextMeterMetadata(
                ClientMetadata(
                    currentContext: ContextInfo(tokens: 999_999, contextWindow: 1_000_000),
                    contextMeterState: invalid,
                    hasPendingPrompt: nil,
                    phase: nil,
                    tags: nil,
                    draftInput: nil,
                    draftUpdatedAt: nil
                ),
                existingStateJson: trustedJson,
                existingTokens: 42_000,
                existingWindow: 200_000
            ),
            ResolvedContextMeterMetadata(
                stateJson: trustedJson,
                tokens: 42_000,
                window: 200_000
            )
        )
    }

    func testEncryptedExplicitNullContextMeterOptionalsPreserveTrustedStateAndMirrors() throws {
        let trusted = ContextMeterStateV1(
            schemaVersion: 1,
            confidence: .exact,
            fillTokens: 42_000,
            effectiveWindowTokens: 200_000,
            reason: nil,
            provenance: sampleContextMeterProvenance()
        )
        let trustedJson = String(data: try JSONEncoder().encode(trusted), encoding: .utf8)!
        let incoming = ClientMetadata(
            currentContext: ContextInfo(tokens: 99_999, contextWindow: 300_000),
            contextMeterState: ContextMeterStateV1(
                schemaVersion: 1,
                confidence: .exact,
                fillTokens: 99_999,
                effectiveWindowTokens: 300_000,
                reason: nil,
                provenance: sampleContextMeterProvenance(runtimeWindowTokens: 300_000)
            ),
            hasPendingPrompt: nil,
            phase: nil,
            tags: nil,
            draftInput: nil,
            draftUpdatedAt: nil
        )
        let encoded = try JSONEncoder().encode(incoming)
        let base = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        let explicitNullPaths = [
            ["contextMeterState", "provenance", "identity", "providerModelId"],
            ["contextMeterState", "provenance", "identity", "catalogEntryId"],
            ["contextMeterState", "provenance", "identity", "interfaceId"],
            ["contextMeterState", "provenance", "order", "turnId"],
            ["contextMeterState", "provenance", "runtimeWindowTokens"],
            ["contextMeterState", "provenance", "contextWindowSeedTokens"],
            ["contextMeterState", "provenance", "lastFreshObservationAtMs"],
            ["contextMeterState", "provenance", "invalidationReason"]
        ]
        var candidates = explicitNullPaths.map { settingExplicitNull(in: base, path: $0) }
        candidates.append([
            "contextMeterState": [
                "schemaVersion": 1,
                "confidence": "unavailable",
                "reason": "thread-reset",
                "provenance": NSNull()
            ]
        ])

        let expected = ResolvedContextMeterMetadata(
            stateJson: trustedJson,
            tokens: 42_000,
            window: 200_000
        )
        for candidate in candidates {
            let raw = try JSONSerialization.data(withJSONObject: candidate)
            let encrypted = try crypto.encrypt(plaintext: String(decoding: raw, as: UTF8.self))
            let decrypted = try crypto.decrypt(
                encryptedBase64: encrypted.encrypted,
                ivBase64: encrypted.iv
            )
            let decoded = try? JSONDecoder().decode(
                ClientMetadata.self,
                from: Data(decrypted.utf8)
            )
            XCTAssertNil(decoded)
            XCTAssertEqual(
                resolveContextMeterMetadata(
                    decoded,
                    existingStateJson: trustedJson,
                    existingTokens: 42_000,
                    existingWindow: 200_000
                ),
                expected
            )
        }
    }

    private func settingExplicitNull(
        in object: [String: Any],
        path: [String]
    ) -> [String: Any] {
        precondition(!path.isEmpty)
        var result = object
        let key = path[0]
        if path.count == 1 {
            result[key] = NSNull()
            return result
        }
        let child = result[key] as! [String: Any]
        result[key] = settingExplicitNull(in: child, path: Array(path.dropFirst()))
        return result
    }

    private func sampleContextMeterProvenance(
        providerModelId: String? = nil,
        turnId: String? = nil,
        observedAtMs: Int = 1_000,
        denominatorSource: String = "runtime-observation",
        runtimeWindowTokens: Int? = 200_000,
        contextWindowSeedTokens: Int? = nil,
        invalidationReason: String? = nil
    ) -> ContextMeterProvenanceV1 {
        ContextMeterProvenanceV1(
            identity: ContextMeterIdentityV1(
                nimbalystSessionId: "session-1",
                providerId: "openai-codex",
                persistedModelId: "openai-codex:gpt-5.4",
                providerModelId: providerModelId,
                catalogEntryId: nil,
                interfaceId: nil,
                upstreamThreadId: "thread-1",
                producerRole: "lead"
            ),
            order: ContextMeterOrderV1(
                processInstanceId: "process-1",
                lifecycleGeneration: 1,
                sequence: 2,
                turnId: turnId,
                observedAtMs: observedAtMs
            ),
            adapterId: "codex-app-server-thread-usage-v1",
            windowPolicy: "runtime-required",
            numeratorSource: "runtime-observation",
            denominatorSource: denominatorSource,
            runtimeWindowTokens: runtimeWindowTokens,
            contextWindowSeedTokens: contextWindowSeedTokens,
            acceptedAtMs: 1_000,
            lastFreshObservationAtMs: 1_000,
            invalidationReason: invalidationReason
        )
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
