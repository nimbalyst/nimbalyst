import XCTest
import Combine
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

    @MainActor
    func testSessionCreationDoesNotSilentlySucceedWithoutAConnectedDesktop() throws {
        let sync = SyncManager(crypto: crypto, database: database, serverUrl: "https://invalid.example", userId: Self.userId, registerDeviceCallbacks: false)
        XCTAssertThrowsError(try sync.createSession(projectId: "/test/project"))
    }

    @MainActor
    func testIndexLoadCompletesOnlyAfterImportAndRejectsFailedImports() async throws {
        let sync = SyncManager(crypto: crypto, database: database, serverUrl: "https://invalid.example", userId: Self.userId, registerDeviceCallbacks: false)
        XCTAssertEqual(sync.indexLoadState, .loading)
        let projectPath = "/test/loading-project"
        let encryptedProject = try crypto.encryptProjectId(projectPath)
        let payload: [String: Any] = [
            "type": "indexSyncResponse",
            "projects": [["encryptedProjectId": encryptedProject, "projectIdIv": CryptoManager.projectIdIvBase64]],
            "sessions": [["sessionId": "loaded-session", "encryptedProjectId": encryptedProject,
                          "projectIdIv": CryptoManager.projectIdIvBase64, "createdAt": 1, "updatedAt": 2]]
        ]
        let imported = expectation(description: "Completion publishes after rows are usable")
        let subscription = sync.$indexLoadState.filter { $0 == .loaded }.prefix(1).sink { _ in
            XCTAssertEqual(try? self.database.allProjects().count, 1)
            XCTAssertEqual(try? self.database.sessions(forProject: projectPath).count, 1)
            imported.fulfill()
        }
        // The production entry point: JSON decode happens off the main actor,
        // and only the routing decision comes back to it.
        await sync.receiveIndexMessage(try JSONSerialization.data(withJSONObject: payload))
        XCTAssertTrue(sync.lastIndexDecodeWasOffMainActor, "Index decode must not run on the main actor")
        await fulfillment(of: [imported], timeout: 5)
        subscription.cancel()

        let invalidImport: [String: Any] = ["type": "indexSyncResponse", "sessions": [],
            "projects": [["encryptedProjectId": "invalid", "projectIdIv": "invalid"]]]
        let failed = expectation(description: "Decryption failure is not an empty index")
        let failureSubscription = sync.$indexLoadState.filter { $0 == .failed }.prefix(1).sink { _ in failed.fulfill() }
        await sync.receiveIndexMessage(try JSONSerialization.data(withJSONObject: invalidImport))
        await fulfillment(of: [failed], timeout: 5)
        failureSubscription.cancel()

        let empty = expectation(description: "A successful empty retry completes loading")
        // Record the sequence rather than sampling it: an arriving response has
        // to publish .loading before it completes, and starting from .failed
        // makes that a real transition rather than the initial state. Sampling
        // the property right after the call cannot assert this -- the import can
        // finish first, and the test would be checking a race.
        var observedStates: [IndexLoadState] = []
        let emptySubscription = sync.$indexLoadState.sink { state in
            observedStates.append(state)
            if state == .loaded { empty.fulfill() }
        }
        await sync.receiveIndexMessage(Data(#"{"type":"indexSyncResponse","sessions":[],"projects":[]}"#.utf8))
        await fulfillment(of: [empty], timeout: 5)
        emptySubscription.cancel()
        XCTAssertEqual(
            Array(observedStates.prefix(3)),
            [.failed, .loading, .loaded],
            "An arriving index response enters loading before it completes"
        )

        // An undecodable response is a failure, not an empty index -- and the
        // rows imported earlier are still there.
        await sync.receiveIndexMessage(Data(#"{"type":"indexSyncResponse","sessions":null}"#.utf8))
        XCTAssertEqual(sync.indexLoadState, .failed)
        XCTAssertEqual(try database.sessions(forProject: projectPath).count, 1)
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

    /// `connect` used to reach `NotificationManager.shared` -- and through it
    /// `UNUserNotificationCenter.current()` -- from the connection-state
    /// handler, which traps with `bundleProxyForCurrentProcess is nil` outside
    /// an app bundle. `registerDeviceCallbacks: false` only skipped the
    /// init-time wiring, so any test that connected took the whole binary down.
    @MainActor
    func testConnectingWithDeviceRegistrationDisabledDoesNotTouchNotificationsOrActivityKit() async throws {
        let sync = SyncManager(crypto: crypto, database: database, serverUrl: "https://127.0.0.1:1",
                               userId: Self.userId, registerDeviceCallbacks: false)
        XCTAssertFalse(sync.registersDeviceTokens)

        sync.connect(authToken: "test-token", authUserId: "auth-user", orgId: "org-1")
        // The connection-state handler hops to the main actor; let it run.
        try await Task.sleep(for: .milliseconds(150))

        // Direct calls are gated too -- push forwarding can fire from elsewhere.
        sync.registerPushToken("deadbeef")
        sync.unregisterPushToken()
        sync.unregisterLiveActivityToken(kind: nil)
        sync.disconnect()
    }

    // MARK: - Outbound send contract (SyncRequestRegistry)

    /// A sender whose failures the test drives. `sent` is the JSON that landed.
    private final class SendRecorder: @unchecked Sendable {
        var failure: Error?
        var sent: [String] = []
    }

    private func seedSession(_ id: String, projectId: String = "/test/project") throws {
        try database.upsertProject(Project(id: projectId, name: "project"))
        try database.upsertSession(Session(id: id, projectId: projectId, provider: "claude-code",
                                           createdAt: 1000, updatedAt: 1000))
    }

    @MainActor
    private func manager(
        _ recorder: SendRecorder,
        requestTimeout: Duration = .seconds(30),
        settingsVersions: AppliedSettingsVersionStore = AppliedSettingsVersionStore(
            defaults: UserDefaults(suiteName: "sync-tests-\(UUID().uuidString)")!)
    ) -> SyncManager {
        SyncManager(crypto: crypto, database: database, serverUrl: "https://invalid.example",
                    userId: Self.userId, registerDeviceCallbacks: false, requestTimeout: requestTimeout,
                    sender: { _, json, completion in
                        if let failure = recorder.failure { completion(failure) }
                        else { recorder.sent.append(json); completion(nil) }
                    },
                    settingsVersions: settingsVersions)
    }

    private func draftInput(in json: String) throws -> String? {
        let message = try JSONDecoder().decode(IndexUpdateMessage.self, from: Data(json.utf8))
        guard let blob = message.session.encryptedClientMetadata,
              let iv = message.session.clientMetadataIv,
              let plaintext = crypto.decryptOrNil(encryptedBase64: blob, ivBase64: iv) else { return nil }
        return try JSONDecoder().decode(ClientMetadata.self, from: Data(plaintext.utf8)).draftInput
    }

    func testMobileEditsDoNotOverwriteDesktopExecutionState() throws {
        for executing in [false, true] {
            let session = Session(id: "status-owner", projectId: "/test/project",
                                  isExecuting: executing, createdAt: 1, updatedAt: 2)
            let encrypted = try crypto.encrypt(plaintext: "start work")
            let prompt = EncryptedQueuedPrompt(id: "outgoing", encryptedPrompt: encrypted.encrypted,
                                              iv: encrypted.iv, timestamp: 3, source: "keyboard")
            let updates = [
                try SessionIndexUpdates.prompt(session: session, prompt: prompt, messageCount: 0, crypto: crypto),
                try SessionIndexUpdates.draft(session: session, draft: "", draftUpdatedAt: 3, messageCount: 0, crypto: crypto),
                try SessionIndexUpdates.readReceipt(session: session, lastReadAt: 3, crypto: crypto),
                try SessionIndexUpdates.parent(session: session, parentSessionId: "parent", crypto: crypto),
            ]
            for json in updates {
                let update = try JSONDecoder().decode(IndexUpdateMessage.self, from: Data(json.utf8))
                XCTAssertNil(update.session.isExecuting, "A stale phone snapshot must not publish desktop-owned status")
            }
            let submitted = try JSONDecoder().decode(IndexUpdateMessage.self, from: Data(updates[0].utf8)).session
            XCTAssertEqual(submitted.encryptedQueuedPrompts?.first?.id, "outgoing")
            XCTAssertEqual(submitted.queuedPromptCount, 1)
        }
    }

    /// The draft is committed locally before the send, so a failed send is a
    /// divergence the user has to be told about -- and the replay must publish
    /// what the row says now, not the bytes that failed.
    @MainActor
    func testFailedDraftPushReportsAndReplaysFromTheRow() throws {
        let recorder = SendRecorder()
        recorder.failure = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "offline"])
        let sync = manager(recorder)
        try seedSession("draft-session")

        sync.updateDraftInput(sessionId: "draft-session", draftInput: "first edit")
        XCTAssertEqual(sync.syncError?.kind, .transport)
        XCTAssertEqual(try database.session(byId: "draft-session")?.draftInput, "first edit")

        sync.updateDraftInput(sessionId: "draft-session", draftInput: "second edit")
        XCTAssertEqual(sync.requests.replayCount, 1, "Offline edits for one session replay once, not once each")

        recorder.failure = nil
        sync.requests.reconnect()
        XCTAssertEqual(recorder.sent.count, 1)
        XCTAssertEqual(try draftInput(in: try XCTUnwrap(recorder.sent.first)), "second edit")
        XCTAssertEqual(sync.requests.replayCount, 0)
    }

    /// The read marker is the same shape: local first, then published.
    @MainActor
    func testFailedReadReceiptIsReportedAndParked() throws {
        let recorder = SendRecorder()
        recorder.failure = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "offline"])
        let sync = manager(recorder)
        try seedSession("read-session")

        sync.markSessionRead(sessionId: "read-session")
        XCTAssertEqual(sync.syncError?.kind, .transport)
        XCTAssertEqual(sync.requests.replayCount, 1)

        recorder.failure = nil
        sync.requests.reconnect()
        XCTAssertEqual(recorder.sent.count, 1)
        let entry = try JSONDecoder().decode(IndexUpdateMessage.self, from: Data(try XCTUnwrap(recorder.sent.first).utf8)).session
        XCTAssertNotNil(entry.lastReadAt)
        XCTAssertNil(entry.messageCount, "A read receipt knows nothing about the transcript length")
    }

    /// An interactive prompt answer must not be replayed later: by then the
    /// desktop has moved on and the answer is wrong.
    @MainActor
    func testInteractivePromptControlIsReportedButNeverReplayed() throws {
        let recorder = SendRecorder()
        recorder.failure = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "offline"])
        let sync = manager(recorder)
        try seedSession("control-session")

        sync.sendSessionControlMessage(sessionId: "control-session", messageType: "askUserQuestionResponse")
        XCTAssertEqual(sync.syncError?.kind, .transport)
        XCTAssertEqual(sync.requests.replayCount, 0)

        sync.requests.reconnect()
        XCTAssertTrue(recorder.sent.isEmpty)
    }

    /// Archiving does mirror a local row, so it is the one control that replays.
    @MainActor
    func testArchiveControlReplaysTheCommittedValue() throws {
        let recorder = SendRecorder()
        recorder.failure = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "offline"])
        let sync = manager(recorder)
        try seedSession("archive-session")

        try sync.setSessionArchived(sessionId: "archive-session", isArchived: true)
        XCTAssertEqual(sync.requests.replayCount, 1)

        recorder.failure = nil
        sync.requests.reconnect()
        XCTAssertEqual(recorder.sent.count, 1)
        XCTAssertTrue(try XCTUnwrap(recorder.sent.first).contains("\"isArchived\""))
    }

    /// Worktree creation had no tracker and no timeout: a desktop that never
    /// answered was indistinguishable from a slow one.
    @MainActor
    func testWorktreeRequestTimesOutInsteadOfWaitingForever() async throws {
        let recorder = SendRecorder()
        let sync = manager(recorder, requestTimeout: .milliseconds(50))
        _ = try sync.createWorktree(projectId: "/test/project")
        XCTAssertEqual(sync.requests.pendingCount, 1)

        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(sync.syncError?.kind, .requestTimeout)
        XCTAssertEqual(sync.requests.pendingCount, 0)
    }

    /// The desktop's own reason beats our generic copy.
    @MainActor
    func testWorktreeResponseResolvesTheRequestWithTheDesktopsReason() throws {
        let recorder = SendRecorder()
        let sync = manager(recorder)
        let requestId = try sync.createWorktree(projectId: "/test/project")

        let payload: [String: Any] = [
            "type": "createWorktreeResponseBroadcast",
            "response": ["requestId": requestId, "success": false, "error": "The working tree has uncommitted changes."],
        ]
        sync.handleIndexMessage(try JSONSerialization.data(withJSONObject: payload))

        XCTAssertEqual(sync.requests.pendingCount, 0)
        XCTAssertEqual(sync.syncError?.message, "The working tree has uncommitted changes.")
    }

    /// A socket that goes away mid-flight is a failure, not silence.
    @MainActor
    func testDisconnectFailsEverythingStillInFlight() throws {
        let recorder = SendRecorder()
        let sync = manager(recorder, requestTimeout: .seconds(30))
        _ = try sync.createWorktree(projectId: "/test/project")
        XCTAssertEqual(sync.requests.pendingCount, 1)

        sync.requests.disconnect()
        XCTAssertEqual(sync.requests.pendingCount, 0)
        XCTAssertEqual(sync.syncError?.kind, .transport)
    }

    // MARK: - Error surface (R-D-2, R-D-3)

    /// R-D-2: a frame can be delivered and the socket error arrive after it, so
    /// "has not reached your desktop" is a claim this device cannot make.
    func testFailureCopyNeverAssertsNonDelivery() {
        for kind in [SyncRequestKind.draftPush, .readReceipt, .reparent, .sessionControl,
                     .toolResult, .createWorktree] {
            XCTAssertFalse(kind.failureDescription.contains("has not reached"),
                           "\(kind.rawValue) asserts non-delivery it cannot know")
        }
        for kind in [SyncRequestKind.draftPush, .readReceipt, .reparent] {
            XCTAssertTrue(kind.failureDescription.contains("may not have reached"))
            XCTAssertTrue(kind.failureDescription.contains("sent again"),
                          "A kind that replays on reconnect should say so")
        }
    }

    /// R-D-3: coalescing existed only as the banner's animation key, which
    /// cannot help when the message differs. A draft push and a read receipt
    /// failing against one dead socket are a single interruption.
    @MainActor
    func testAlternatingTransportFailuresAreOneBanner() throws {
        let recorder = SendRecorder()
        recorder.failure = NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "offline"])
        let sync = manager(recorder)
        try seedSession("flap-session")

        sync.updateDraftInput(sessionId: "flap-session", draftInput: "typing")
        let first = try XCTUnwrap(sync.syncError)
        XCTAssertEqual(first.kind, .transport)
        XCTAssertEqual(first.message, SyncRequestKind.draftPush.failureDescription)

        sync.markSessionRead(sessionId: "flap-session")
        let second = try XCTUnwrap(sync.syncError)
        XCTAssertEqual(second.id, first.id, "A second transport failure must not start a new banner")
        XCTAssertEqual(second.message, SyncError.Kind.transport.coalescedMessage,
                       "Naming one of several failed operations would be arbitrary")

        sync.updateDraftInput(sessionId: "flap-session", draftInput: "more typing")
        XCTAssertEqual(sync.syncError?.id, first.id)
        XCTAssertEqual(sync.syncError?.message, SyncError.Kind.transport.coalescedMessage,
                       "The text settles instead of flapping back to the draft wording")

        // A different kind is a different thing to a reader, so it replaces now.
        sync.handleSessionMessage(try messageBroadcast(id: "bad", sequence: 9, text: "x", readable: false),
                                  sessionId: "flap-session")
        let third = try XCTUnwrap(sync.syncError)
        XCTAssertEqual(third.kind, .decrypt)
        XCTAssertNotEqual(third.id, first.id)
    }

    /// The window is measured from the first failure and deliberately not
    /// refreshed, so a steady stream cannot pin one stale banner open forever.
    @MainActor
    func testCoalescingWindowExpiresSoTheBannerCanRenew() {
        var coalescer = SyncErrorCoalescer(window: 2)
        let start = Date()
        guard let first = coalescer.accept(SyncError(kind: .transport, message: "a"), now: start) else {
            return XCTFail("The first failure must open a banner")
        }
        XCTAssertEqual(first.message, "a")
        XCTAssertNil(coalescer.accept(SyncError(kind: .transport, message: "a"), now: start.addingTimeInterval(0.5)),
                     "An identical repeat inside the window changes nothing")
        XCTAssertEqual(coalescer.accept(SyncError(kind: .transport, message: "b"),
                                        now: start.addingTimeInterval(1))?.id, first.id)
        let renewed = coalescer.accept(SyncError(kind: .transport, message: "c"), now: start.addingTimeInterval(3))
        XCTAssertNotEqual(renewed?.id, first.id, "Past the window a new interruption gets a new banner")
        XCTAssertEqual(renewed?.message, "c")
    }

    // MARK: - Ordering guards (NIM-5921, NIM-5922, NIM-5924)

    private func settingsBroadcast(version: Int, timestamp: Int, deviceId: String = "desktop-1",
                                   defaultModel: String) throws -> Data {
        let settings: [String: Any] = ["version": version, "defaultModel": defaultModel]
        let plaintext = String(decoding: try JSONSerialization.data(withJSONObject: settings), as: UTF8.self)
        let encrypted = try crypto.encrypt(plaintext: plaintext)
        return try JSONSerialization.data(withJSONObject: [
            "type": "settingsSyncBroadcast",
            "settings": [
                "encryptedSettings": encrypted.encrypted, "settingsIv": encrypted.iv,
                "deviceId": deviceId, "timestamp": timestamp, "version": version,
            ],
        ])
    }

    /// NIM-5921: the desktop's settings counter restarts at zero on every
    /// desktop launch, so a rejoin replayed an old payload -- the OpenAI
    /// credential included -- over newer state.
    @MainActor
    func testStaleSettingsBroadcastCannotOverwriteNewerSettings() throws {
        let defaults = UserDefaults(suiteName: "settings-guard-\(UUID().uuidString)")!
        let recorder = SendRecorder()
        let sync = manager(recorder, settingsVersions: AppliedSettingsVersionStore(defaults: defaults))

        sync.handleIndexMessage(try settingsBroadcast(version: 5, timestamp: 2_000, defaultModel: "claude-code:opus"))
        XCTAssertEqual(sync.desktopDefaultModel, "claude-code:opus")

        sync.handleIndexMessage(try settingsBroadcast(version: 4, timestamp: 1_000, defaultModel: "replayed"))
        XCTAssertEqual(sync.desktopDefaultModel, "claude-code:opus", "A replay is not newer state")

        sync.handleIndexMessage(try settingsBroadcast(version: 5, timestamp: 2_000, defaultModel: "same-again"))
        XCTAssertEqual(sync.desktopDefaultModel, "claude-code:opus", "An equal version is not newer state")

        // A desktop restart resets the counter but not the clock.
        sync.handleIndexMessage(try settingsBroadcast(version: 0, timestamp: 3_000, defaultModel: "after-restart"))
        XCTAssertEqual(sync.desktopDefaultModel, "after-restart", "A desktop restart must still be able to sync")

        sync.handleIndexMessage(try settingsBroadcast(version: 5, timestamp: 2_000, defaultModel: "before-restart-replay"))
        XCTAssertEqual(sync.desktopDefaultModel, "after-restart", "A higher counter from the previous launch must not rewind settings")

        // Second launch: the watermark has to survive the app, or the first
        // broadcast after every cold start applies blind.
        let relaunched = manager(recorder, settingsVersions: AppliedSettingsVersionStore(defaults: defaults))
        relaunched.handleIndexMessage(try settingsBroadcast(version: 5, timestamp: 2_000, defaultModel: "before-restart-replay"))
        XCTAssertNil(relaunched.desktopDefaultModel, "The persisted watermark must reject a previous launch's higher counter")
        relaunched.handleIndexMessage(try settingsBroadcast(version: 0, timestamp: 2_500, defaultModel: "replayed"))
        XCTAssertNil(relaunched.desktopDefaultModel, "The watermark must outlive the process")

        relaunched.handleIndexMessage(try settingsBroadcast(version: 1, timestamp: 3_000, defaultModel: "same-millisecond"))
        XCTAssertEqual(relaunched.desktopDefaultModel, "same-millisecond", "The counter orders broadcasts within the same millisecond")
        relaunched.handleIndexMessage(try settingsBroadcast(version: 0, timestamp: 3_000, defaultModel: "lower-counter"))
        XCTAssertEqual(relaunched.desktopDefaultModel, "same-millisecond")
    }

    /// NIM-5922: the phone wrote the new parent locally and sent nothing, so the
    /// desktop reasserted the old parent on the next index page.
    @MainActor
    func testReparentIsPublishedNotJustWrittenLocally() throws {
        let recorder = SendRecorder()
        let sync = manager(recorder)
        try seedSession("child")

        try sync.updateSessionParent(sessionId: "child", parentSessionId: "workstream-1")

        XCTAssertEqual(try database.session(byId: "child")?.parentSessionId, "workstream-1")
        let json = try XCTUnwrap(recorder.sent.last)
        let entry = try JSONDecoder().decode(IndexUpdateMessage.self, from: Data(json.utf8)).session
        XCTAssertEqual(entry.sessionId, "child")
        XCTAssertEqual(entry.parentSessionId, "workstream-1")
    }

    private func messageBroadcast(id: String, sequence: Int, text: String,
                                  readable: Bool = true) throws -> Data {
        // `readable: false` encrypts under a key this manager cannot
        // authenticate, which is how a decrypt failure reaches the handler.
        let encrypted = try (readable ? crypto : CryptoManager(seed: "other-seed", userId: "other"))
            .encrypt(plaintext: text)
        return try JSONSerialization.data(withJSONObject: [
            "type": "messageBroadcast",
            "message": ["id": id, "sequence": sequence, "createdAt": 1_000, "source": "assistant",
                        "direction": "output", "encryptedContent": encrypted.encrypted, "iv": encrypted.iv],
        ])
    }

    private func metadataBroadcast(isExecuting: Bool, updatedAt: Int) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "type": "metadataBroadcast",
            "metadata": ["isExecuting": isExecuting, "updatedAt": updatedAt],
        ])
    }

    /// NIM-5924: session-room frames carry no session id, so they were filed
    /// under `activeSessionId` -- read a main-actor hop after arrival, by which
    /// time navigation may have moved to a different session.
    @MainActor
    func testBroadcastLandsInTheRoomItArrivedOnAndTheWatermarkOnlyMovesForward() throws {
        let recorder = SendRecorder()
        let sync = manager(recorder)
        try seedSession("room-a")
        try seedSession("room-b")
        sync.activeSessionId = "room-b"

        sync.handleSessionMessage(try messageBroadcast(id: "m5", sequence: 5, text: "from A"), sessionId: "room-a")
        XCTAssertEqual(try database.messages(forSession: "room-a").count, 1)
        XCTAssertTrue(try database.messages(forSession: "room-b").isEmpty,
                      "A frame from room A must not be filed under the session the user navigated to")
        XCTAssertEqual(try database.syncState(forRoom: "room-a")?.lastSequence, 5)

        sync.handleSessionMessage(try messageBroadcast(id: "m2", sequence: 2, text: "late"), sessionId: "room-a")
        XCTAssertEqual(try database.messages(forSession: "room-a").count, 2, "The late message is still stored")
        XCTAssertEqual(try database.syncState(forRoom: "room-a")?.lastSequence, 5,
                       "A late broadcast must not rewind the delta cursor")
    }

    /// NIM-5924: a replayed metadata pair completed the turn twice, which is two
    /// completion notifications for one turn.
    @MainActor
    func testReplayedMetadataCannotCompleteTheTurnTwice() throws {
        let recorder = SendRecorder()
        let sync = manager(recorder)
        try seedSession("meta-session")
        var completions: [String] = []
        sync.onSessionCompleted = { sessionId, _ in completions.append(sessionId) }

        sync.handleSessionMessage(try metadataBroadcast(isExecuting: true, updatedAt: 100), sessionId: "meta-session")
        sync.handleSessionMessage(try metadataBroadcast(isExecuting: false, updatedAt: 200), sessionId: "meta-session")
        XCTAssertEqual(completions, ["meta-session"])

        sync.handleSessionMessage(try metadataBroadcast(isExecuting: true, updatedAt: 100), sessionId: "meta-session")
        sync.handleSessionMessage(try metadataBroadcast(isExecuting: false, updatedAt: 200), sessionId: "meta-session")
        XCTAssertEqual(completions, ["meta-session"], "A replayed pair is not a second turn")
    }
}
