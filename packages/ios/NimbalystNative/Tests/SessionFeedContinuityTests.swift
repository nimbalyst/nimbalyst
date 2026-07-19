import XCTest
import GRDB
@testable import NimbalystNative

private final class FakeSyncSocket: SyncWebSocketClient {
    var sendsDeviceAnnounce = false
    var onMessageWithContext: ((Data, WebSocketConnectionContext) -> Void)?
    var onConnectionStateChangedWithContext: ((Bool, WebSocketConnectionContext) -> Void)?
    var isConnected = false

    private(set) var connectCount = 0
    private(set) var reconnectCount = 0
    private(set) var sentJSON: [String] = []
    private(set) var currentContext: WebSocketConnectionContext?
    var sendResults: [Error?] = []

    private var generation = 0
    private var serverUrl: String?
    private var roomId: String?
    private var authToken: String?

    func reportActivity() {}
    func setAppInForeground(_ inForeground: Bool) {}

    func connect(serverUrl: String, roomId: String, authToken: String) {
        self.serverUrl = serverUrl
        self.roomId = roomId
        self.authToken = authToken
        connectCount += 1
        openReplacementConnection()
    }

    func disconnect() {
        let closed = currentContext
        generation &+= 1
        currentContext = nil
        isConnected = false
        if let closed {
            onConnectionStateChangedWithContext?(false, closed)
        }
    }

    func reconnect() {
        reconnectCount += 1
        guard serverUrl != nil, roomId != nil, authToken != nil else { return }
        openReplacementConnection()
    }

    func sendRaw(_ json: String) {
        sendRaw(json, completion: nil)
    }

    func sendRaw(_ json: String, completion: ((Error?) -> Void)?) {
        sentJSON.append(json)
        let result = sendResults.isEmpty ? nil : sendResults.removeFirst()
        completion?(result)
    }

    func startPings() {}
    func stopPings() {}

    func emit(_ data: Data, context: WebSocketConnectionContext? = nil) {
        guard let context = context ?? currentContext else { return }
        onMessageWithContext?(data, context)
    }

    private func openReplacementConnection() {
        generation &+= 1
        let context = WebSocketConnectionContext(
            generation: generation,
            roomId: roomId ?? ""
        )
        currentContext = context
        isConnected = true
        onConnectionStateChangedWithContext?(true, context)
    }
}

@MainActor
private final class ControlledSyncScheduler: SyncScheduling {
    private(set) var operations: [SyncScheduledOperation] = []

    func schedule(after delay: TimeInterval, _ operation: @escaping SyncScheduledOperation) {
        operations.append(operation)
    }

    func runNext() {
        operations.removeFirst()()
    }
}

private final class ControlledIndexExecutor: IndexWorkExecuting, @unchecked Sendable {
    private var activeGeneration: Int?
    private(set) var queued: [(Int, IndexWork)] = []

    func setActiveGeneration(_ generation: Int?) {
        activeGeneration = generation
    }

    func enqueue(generation: Int, _ work: @escaping IndexWork) {
        queued.append((generation, work))
    }

    func runNext() {
        let (generation, work) = queued.removeFirst()
        let isCurrent: IndexGenerationCheck = { [weak self] in
            self?.activeGeneration == generation
        }
        guard isCurrent() else { return }
        work(isCurrent)
    }

    func runAll() {
        while !queued.isEmpty {
            runNext()
        }
    }
}

@MainActor
final class SessionFeedContinuityTests: XCTestCase {
    private let userId = "user-test-12345"
    private let seed = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw=="

    private func makeCrypto() -> CryptoManager {
        CryptoManager(seed: seed, userId: userId)
    }

    private func makeDatabaseWithSession(
        id: String = "session-1",
        title: String? = nil,
        isPinned: Bool = false,
        isExecuting: Bool = false,
        updatedAt: Int = 1_000
    ) throws -> DatabaseManager {
        let database = try DatabaseManager()
        try database.upsertProject(Project(id: "/project", name: "project"))
        try database.upsertSession(Session(
            id: id,
            projectId: "/project",
            titleDecrypted: title,
            isPinned: isPinned,
            isExecuting: isExecuting,
            createdAt: 500,
            updatedAt: updatedAt
        ))
        return database
    }

    private func makeManager(
        database: DatabaseManager,
        crypto: CryptoManager,
        indexSocket: FakeSyncSocket,
        sessionSocket: FakeSyncSocket,
        scheduler: ControlledSyncScheduler = ControlledSyncScheduler(),
        executor: ControlledIndexExecutor = ControlledIndexExecutor()
    ) -> SyncManager {
        SyncManager(
            crypto: crypto,
            database: database,
            serverUrl: "https://example.invalid",
            userId: userId,
            indexClient: indexSocket,
            sessionClient: sessionSocket,
            scheduler: scheduler,
            indexExecutor: executor
        )
    }

    private func settleMainActor(_ count: Int = 12) async {
        for _ in 0..<count {
            await Task.yield()
        }
    }

    private func serverMessage(sequence: Int, crypto: CryptoManager) throws -> ServerMessageEntry {
        let encrypted = try crypto.encrypt(plaintext: "message \(sequence)")
        return ServerMessageEntry(
            id: "message-\(sequence)",
            sequence: sequence,
            createdAt: 1_000 + sequence,
            source: sequence.isMultiple(of: 2) ? "assistant" : "user",
            direction: sequence.isMultiple(of: 2) ? "output" : "input",
            encryptedContent: encrypted.encrypted,
            iv: encrypted.iv,
            metadata: nil
        )
    }

    private func serverSession(
        crypto: CryptoManager,
        title: String,
        isPinned: Bool,
        isExecuting: Bool,
        updatedAt: Int
    ) throws -> ServerSessionEntry {
        let encryptedTitle = try crypto.encrypt(plaintext: title)
        return ServerSessionEntry(
            sessionId: "session-1",
            encryptedProjectId: try crypto.encryptProjectId("/project"),
            projectIdIv: CryptoManager.projectIdIvBase64,
            encryptedTitle: encryptedTitle.encrypted,
            titleIv: encryptedTitle.iv,
            provider: "claude-code",
            model: "opus",
            mode: "agent",
            sessionType: nil,
            parentSessionId: nil,
            agentRole: nil,
            createdBySessionId: nil,
            worktreeId: nil,
            isArchived: false,
            isPinned: isPinned,
            branchedFromSessionId: nil,
            branchPointMessageId: nil,
            branchedAt: nil,
            messageCount: 0,
            lastMessageAt: nil,
            createdAt: 500,
            updatedAt: updatedAt,
            pendingExecution: nil,
            isExecuting: isExecuting,
            queuedPromptCount: 0,
            encryptedQueuedPrompts: nil,
            hasPendingPrompt: false,
            encryptedClientMetadata: nil,
            clientMetadataIv: nil,
            lastReadAt: nil
        )
    }

    private func metadata(
        crypto: CryptoManager,
        title: String,
        isExecuting: Bool,
        updatedAt: Int
    ) throws -> SessionRoomMetadata {
        let encryptedTitle = try crypto.encrypt(plaintext: title)
        return SessionRoomMetadata(
            encryptedTitle: encryptedTitle.encrypted,
            titleIv: encryptedTitle.iv,
            provider: "claude-code",
            model: "opus",
            mode: "agent",
            isExecuting: isExecuting,
            createdAt: nil,
            updatedAt: updatedAt,
            encryptedProjectId: nil,
            projectIdIv: nil,
            encryptedClientMetadata: nil,
            clientMetadataIv: nil
        )
    }

    func testForegroundTransitionReplacesStaleRunningIndexAndSessionSockets() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let indexSocket = FakeSyncSocket()
        let sessionSocket = FakeSyncSocket()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: indexSocket,
            sessionSocket: sessionSocket
        )

        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        manager.joinSessionRoom(sessionId: "session-1")
        await settleMainActor()
        XCTAssertTrue(indexSocket.isConnected, "Fake deliberately reports stale .running state")
        XCTAssertTrue(sessionSocket.isConnected)

        manager.setAppInForeground(false)
        manager.setAppInForeground(false)
        manager.setAppInForeground(true)
        await settleMainActor()

        XCTAssertEqual(indexSocket.reconnectCount, 1)
        XCTAssertEqual(sessionSocket.reconnectCount, 1)
        XCTAssertGreaterThanOrEqual(indexSocket.sentJSON.count, 2, "replacement generation must catch up index")
        XCTAssertGreaterThanOrEqual(sessionSocket.sentJSON.count, 2, "replacement generation must catch up transcript")

        manager.setAppInForeground(true)
        XCTAssertEqual(indexSocket.reconnectCount, 1, "foreground callbacks are transition-bounded")
    }

    func testSessionRetrySchedulerAndPaginatedRuntimeCallbackStoreLongHistory() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let indexSocket = FakeSyncSocket()
        let sessionSocket = FakeSyncSocket()
        let scheduler = ControlledSyncScheduler()
        sessionSocket.sendResults = [NSError(domain: "test", code: 1), nil, nil]
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: indexSocket,
            sessionSocket: sessionSocket,
            scheduler: scheduler
        )

        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        manager.joinSessionRoom(sessionId: "session-1")
        await settleMainActor()
        XCTAssertEqual(scheduler.operations.count, 1)
        scheduler.runNext()
        await settleMainActor()

        let firstPage = SessionSyncResponse(
            type: "syncResponse",
            messages: try (1...256).map { try serverMessage(sequence: $0, crypto: crypto) },
            metadata: nil,
            hasMore: true,
            cursor: "256"
        )
        sessionSocket.emit(try JSONEncoder().encode(firstPage))
        await settleMainActor(300)

        let secondPage = SessionSyncResponse(
            type: "syncResponse",
            messages: try (257...520).map { try serverMessage(sequence: $0, crypto: crypto) },
            metadata: nil,
            hasMore: false,
            cursor: "520"
        )
        sessionSocket.emit(try JSONEncoder().encode(secondPage))
        await settleMainActor(300)

        let replay = MessageBroadcast(
            type: "messageBroadcast",
            message: try serverMessage(sequence: 520, crypto: crypto),
            fromConnectionId: "desktop"
        )
        sessionSocket.emit(try JSONEncoder().encode(replay))
        await settleMainActor()

        let stored = try database.messages(forSession: "session-1")
        XCTAssertEqual(stored.count, 520)
        XCTAssertEqual(stored.map(\.sequence), Array(1...520))
        XCTAssertEqual(try database.syncState(forRoom: "session-1")?.lastSequence, 520)
        XCTAssertEqual(try database.session(byId: "session-1")?.lastSyncedSeq, 520)
    }

    func testOlderQueuedIndexResponseCannotSplitNewerMetadataAndCursor() async throws {
        let database = try makeDatabaseWithSession(title: "initial")
        let crypto = makeCrypto()
        let indexSocket = FakeSyncSocket()
        let executor = ControlledIndexExecutor()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: indexSocket,
            sessionSocket: FakeSyncSocket(),
            executor: executor
        )
        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        await settleMainActor()

        let oldSnapshot = IndexSyncResponse(
            type: "indexSyncResponse",
            sessions: [try serverSession(
                crypto: crypto,
                title: "stale index title",
                isPinned: true,
                isExecuting: false,
                updatedAt: 2_000
            )],
            projects: [],
            totalSessionCount: 1,
            since: nil
        )
        indexSocket.emit(try JSONEncoder().encode(oldSnapshot))
        await settleMainActor()
        XCTAssertEqual(executor.queued.count, 1)

        manager.applySessionMetadata(
            try metadata(crypto: crypto, title: "new room title", isExecuting: true, updatedAt: 3_000),
            sessionId: "session-1"
        )
        executor.runAll()

        let stored = try XCTUnwrap(database.session(byId: "session-1"))
        XCTAssertEqual(stored.titleDecrypted, "new room title")
        XCTAssertTrue(stored.isExecuting)
        XCTAssertTrue(stored.isPinned, "index-owned fields still reconcile")
        XCTAssertEqual(try database.syncState(forRoom: "session-1")?.lastCursor, "3000")
    }

    func testEqualTimestampSnapshotThenPinBroadcastAppliesInReceiveOrder() async throws {
        let database = try makeDatabaseWithSession(isPinned: false)
        let crypto = makeCrypto()
        let indexSocket = FakeSyncSocket()
        let executor = ControlledIndexExecutor()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: indexSocket,
            sessionSocket: FakeSyncSocket(),
            executor: executor
        )
        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        await settleMainActor()

        let snapshotEntry = try serverSession(
            crypto: crypto,
            title: "session",
            isPinned: false,
            isExecuting: false,
            updatedAt: 2_000
        )
        let snapshot = IndexSyncResponse(
            type: "indexSyncResponse",
            sessions: [snapshotEntry],
            projects: [],
            totalSessionCount: 1,
            since: nil
        )
        let pin = IndexBroadcast(
            type: "indexBroadcast",
            session: try serverSession(
                crypto: crypto,
                title: "session",
                isPinned: true,
                isExecuting: false,
                updatedAt: 2_000
            ),
            fromConnectionId: "desktop"
        )

        indexSocket.emit(try JSONEncoder().encode(snapshot))
        indexSocket.emit(try JSONEncoder().encode(pin))
        await settleMainActor()
        XCTAssertEqual(executor.queued.count, 2)
        executor.runAll()

        XCTAssertTrue(try XCTUnwrap(database.session(byId: "session-1")).isPinned)
    }

    func testQueuedOldGenerationIndexWorkAndLateCallbackAreRejected() async throws {
        let database = try makeDatabaseWithSession(title: "current")
        let crypto = makeCrypto()
        let indexSocket = FakeSyncSocket()
        let executor = ControlledIndexExecutor()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: indexSocket,
            sessionSocket: FakeSyncSocket(),
            executor: executor
        )
        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        await settleMainActor()
        let oldContext = try XCTUnwrap(indexSocket.currentContext)
        let oldResponse = IndexSyncResponse(
            type: "indexSyncResponse",
            sessions: [try serverSession(
                crypto: crypto,
                title: "old generation",
                isPinned: true,
                isExecuting: false,
                updatedAt: 2_000
            )],
            projects: [],
            totalSessionCount: 1,
            since: nil
        )
        let data = try JSONEncoder().encode(oldResponse)
        indexSocket.emit(data, context: oldContext)
        await settleMainActor()
        XCTAssertEqual(executor.queued.count, 1)

        manager.setAppInForeground(false)
        manager.setAppInForeground(true)
        await settleMainActor()
        executor.runAll()
        XCTAssertEqual(try database.session(byId: "session-1")?.titleDecrypted, "current")

        let queuedAfterReconnect = executor.queued.count
        indexSocket.emit(data, context: oldContext)
        await settleMainActor()
        XCTAssertEqual(executor.queued.count, queuedAfterReconnect)
    }

    func testMetadataProgressesWithoutTranscriptTrafficAndRejectsOlderReplay() throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: FakeSyncSocket(),
            sessionSocket: FakeSyncSocket()
        )

        manager.applySessionMetadata(
            try metadata(crypto: crypto, title: "running", isExecuting: true, updatedAt: 2_000),
            sessionId: "session-1"
        )
        manager.applySessionMetadata(
            try metadata(crypto: crypto, title: "complete", isExecuting: false, updatedAt: 3_000),
            sessionId: "session-1"
        )
        manager.applySessionMetadata(
            try metadata(crypto: crypto, title: "stale", isExecuting: true, updatedAt: 2_500),
            sessionId: "session-1"
        )

        let stored = try XCTUnwrap(database.session(byId: "session-1"))
        XCTAssertFalse(stored.isExecuting)
        XCTAssertEqual(stored.titleDecrypted, "complete")
        XCTAssertEqual(try database.messages(forSession: "session-1").count, 0)
        XCTAssertEqual(try database.syncState(forRoom: "session-1")?.lastCursor, "3000")
    }

    func testDatabaseObservationHandoffDropsAlreadyQueuedOldWatcherValue() async throws {
        let database = try makeDatabaseWithSession()
        try database.upsertProject(Project(id: "/other", name: "other"))
        try database.upsertSession(Session(id: "session-2", projectId: "/other"))
        let handoff = SessionListObservationHandoff<[Session]>()
        var oldReceive: (([Session]) -> Void)?
        var receivedIds: [[String]] = []

        let firstObservation = ValueObservation.tracking { db in
            try Session.filter(Session.Columns.projectId == "/project").fetchAll(db)
        }
        handoff.replace(
            start: { receive in
                oldReceive = receive
                return firstObservation.start(
                    in: database.writer,
                    scheduling: .async(onQueue: .main),
                    onError: { XCTFail("first observation failed: \($0)") },
                    onChange: receive
                )
            },
            onChange: { receivedIds.append($0.map(\.id)) }
        )

        let currentValue = expectation(description: "replacement watcher delivered")
        let secondObservation = ValueObservation.tracking { db in
            try Session.filter(Session.Columns.projectId == "/other").fetchAll(db)
        }
        handoff.replace(
            start: { receive in
                secondObservation.start(
                    in: database.writer,
                    scheduling: .async(onQueue: .main),
                    onError: { XCTFail("second observation failed: \($0)") },
                    onChange: receive
                )
            },
            onChange: {
                receivedIds.append($0.map(\.id))
                if $0.map(\.id) == ["session-2"] {
                    currentValue.fulfill()
                }
            }
        )

        oldReceive?([try XCTUnwrap(database.session(byId: "session-1"))])
        await fulfillment(of: [currentValue], timeout: 2)
        handoff.cancel()
        XCTAssertFalse(receivedIds.contains(["session-1"]))
        XCTAssertEqual(receivedIds.last, ["session-2"])
    }
}
