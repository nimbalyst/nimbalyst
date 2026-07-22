import XCTest
import GRDB
import CryptoKit
@testable import NimbalystNative

@MainActor
private final class FakeSyncSocket: SyncWebSocketClient {
    var sendsDeviceAnnounce = false
    var onMessageWithContext: WebSocketMessageHandler?
    var onConnectionStateChangedWithContext: WebSocketConnectionHandler?
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

    func sendRaw(_ json: String, completion: WebSocketSendCompletion?) {
        sentJSON.append(json)
        let result = sendResults.isEmpty ? nil : sendResults.removeFirst()
        completion?(result)
    }

    func startPings() {}
    func stopPings() {}

    func emit(_ data: Data, context: WebSocketConnectionContext? = nil) async {
        guard let context = context ?? currentContext else { return }
        await onMessageWithContext?(data, context)
    }

    func emitConnection(_ connected: Bool, context: WebSocketConnectionContext) {
        onConnectionStateChangedWithContext?(connected, context)
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

private final class ControlledWebSocketEventDelivery: WebSocketEventDelivering, @unchecked Sendable {
    private let lock = NSLock()
    private var operations: [WebSocketEventOperation] = []

    var count: Int {
        lock.withLock { operations.count }
    }

    func deliver(_ operation: @escaping WebSocketEventOperation) {
        lock.withLock {
            operations.append(operation)
        }
    }

    func run(at index: Int = 0) async {
        let operation = lock.withLock { operations.remove(at: index) }
        await operation()
    }
}

private final class FakeWebSocketTransportTask: WebSocketTransportTask {
    private let lock = NSLock()
    private var taskState: URLSessionTask.State = .suspended
    private var receiveCompletion: (@Sendable (
        Result<WebSocketTransportMessage, Error>
    ) -> Void)?
    private var sendCompletions: [@Sendable (Error?) -> Void] = []

    var state: URLSessionTask.State {
        lock.withLock { taskState }
    }

    var hasPendingReceive: Bool {
        lock.withLock { receiveCompletion != nil }
    }

    var pendingSendCount: Int {
        lock.withLock { sendCompletions.count }
    }

    func resume() {
        lock.withLock { taskState = .running }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        lock.withLock { taskState = .canceling }
    }

    func send(
        text: String,
        completionHandler: @escaping @Sendable (Error?) -> Void
    ) {
        lock.withLock { sendCompletions.append(completionHandler) }
    }

    func receive(
        completionHandler: @escaping @Sendable (
            Result<WebSocketTransportMessage, Error>
        ) -> Void
    ) {
        lock.withLock {
            precondition(receiveCompletion == nil, "only one receive may be outstanding")
            receiveCompletion = completionHandler
        }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {}

    @discardableResult
    func completeReceive(
        _ result: Result<WebSocketTransportMessage, Error>
    ) -> Bool {
        let completion = lock.withLock { () -> (@Sendable (
            Result<WebSocketTransportMessage, Error>
        ) -> Void)? in
            defer { receiveCompletion = nil }
            return receiveCompletion
        }
        guard let completion else { return false }
        completion(result)
        return true
    }

    func completeSend(at index: Int = 0, error: Error?) {
        let completion = lock.withLock { sendCompletions.remove(at: index) }
        completion(error)
    }
}

@MainActor
private final class FakeWebSocketTransportFactory: WebSocketTransportCreating {
    private(set) var tasks: [FakeWebSocketTransportTask] = []

    func makeTask(url: URL) -> any WebSocketTransportTask {
        let task = FakeWebSocketTransportTask()
        tasks.append(task)
        return task
    }
}

@MainActor
private final class DocumentWebSocketClientQueue {
    private var clients: [WebSocketClient]

    init(_ clients: [WebSocketClient]) {
        self.clients = clients
    }

    func next() -> WebSocketClient {
        precondition(!clients.isEmpty, "document client factory exhausted")
        return clients.removeFirst()
    }
}

private enum DeterministicWebSocketError: Error, Sendable {
    case receiveFailed
}

@MainActor
private final class OneShotSuspension {
    let reached: XCTestExpectation
    private var shouldSuspend = true
    private var continuation: CheckedContinuation<Void, Never>?

    init(description: String) {
        reached = XCTestExpectation(description: description)
    }

    func suspendOnce() async {
        guard shouldSuspend else { return }
        shouldSuspend = false
        reached.fulfill()
        await withCheckedContinuation { continuation = $0 }
    }

    func resume() {
        continuation?.resume()
        continuation = nil
    }
}

@MainActor
private final class ControlledSessionCatchUpYielder: SessionCatchUpYielding {
    let suspension = OneShotSuspension(description: "session final chunk persisted")

    func yieldAfterPersistedChunk() async {
        await suspension.suspendOnce()
    }
}

@MainActor
private final class SuspendedMessageRecorder {
    private(set) var messages: [String] = []
    private(set) var secondaryMessages: [String] = []
    private(set) var connectedGenerations: [Int] = []
    private(set) var sendErrorCodes: [Int?] = []
    let suspension = OneShotSuspension(description: "message callback suspended")
    var suspendNext = false

    func accept(_ data: Data) async {
        if suspendNext {
            suspendNext = false
            await suspension.suspendOnce()
        }
        messages.append(String(data: data, encoding: .utf8) ?? "<binary>")
    }

    func resume() {
        suspension.resume()
    }

    func recordConnection(_ connected: Bool, context: WebSocketConnectionContext) {
        if connected {
            connectedGenerations.append(context.generation)
        }
    }

    func recordSend(error: Error?) {
        sendErrorCodes.append(error.map { ($0 as NSError).code })
    }

    func recordSecondary(_ data: Data) {
        secondaryMessages.append(String(data: data, encoding: .utf8) ?? "<binary>")
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
        indexSocket: any SyncWebSocketClient,
        sessionSocket: any SyncWebSocketClient,
        scheduler: ControlledSyncScheduler = ControlledSyncScheduler(),
        executor: ControlledIndexExecutor = ControlledIndexExecutor(),
        sessionCatchUpYielder: any SessionCatchUpYielding = TaskSessionCatchUpYielder()
    ) -> SyncManager {
        SyncManager(
            crypto: crypto,
            database: database,
            serverUrl: "https://example.invalid",
            userId: userId,
            indexClient: indexSocket,
            sessionClient: sessionSocket,
            scheduler: scheduler,
            indexExecutor: executor,
            sessionCatchUpYielder: sessionCatchUpYielder
        )
    }

    private func settleMainActor(_ count: Int = 12) async {
        for _ in 0..<count {
            await Task.yield()
        }
    }

    private func startTrackedOperation(
        description: String,
        operation: @escaping @MainActor @Sendable () async -> Void
    ) -> (task: Task<Void, Never>, completion: XCTestExpectation) {
        let completion = expectation(description: description)
        let task = Task { @MainActor in
            await operation()
            completion.fulfill()
        }
        return (task, completion)
    }

    private func documentRoomId(projectId: String = "/project") -> String {
        let digest = SHA256.hash(data: Data(projectId.utf8))
        let hashedProjectId = digest.map { String(format: "%02x", $0) }.joined()
        return "org:org:user:\(userId):project:\(hashedProjectId)"
    }

    private func documentContentBroadcast(
        syncId: String,
        content: String,
        crypto: CryptoManager
    ) throws -> FileContentBroadcast {
        let encryptedContent = try crypto.encrypt(plaintext: content)
        let encryptedPath = try crypto.encrypt(plaintext: "\(syncId).md")
        let encryptedTitle = try crypto.encrypt(plaintext: syncId)
        return FileContentBroadcast(
            type: "fileContentBroadcast",
            syncId: syncId,
            encryptedContent: encryptedContent.encrypted,
            contentIv: encryptedContent.iv,
            contentHash: "hash-\(syncId)",
            encryptedPath: encryptedPath.encrypted,
            pathIv: encryptedPath.iv,
            encryptedTitle: encryptedTitle.encrypted,
            titleIv: encryptedTitle.iv,
            lastModifiedAt: 2_000,
            fromConnectionId: "desktop"
        )
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

    private func exerciseStaleFinalChunkSchedule(oldHasMore: Bool) async throws {
        let database = try makeDatabaseWithSession(title: "initial")
        let crypto = makeCrypto()
        let delivery = ControlledWebSocketEventDelivery()
        let factory = FakeWebSocketTransportFactory()
        let sessionSocket = WebSocketClient(
            transportFactory: factory,
            eventDelivery: delivery
        )
        let yielder = ControlledSessionCatchUpYielder()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: FakeSyncSocket(),
            sessionSocket: sessionSocket,
            sessionCatchUpYielder: yielder
        )
        var diagnostics: [SessionSyncDiagnostic] = []
        manager.onSessionSyncDiagnostic = { _, diagnostic in
            diagnostics.append(diagnostic)
        }

        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        manager.joinSessionRoom(sessionId: "session-1")
        await delivery.run()
        let firstTask = try XCTUnwrap(factory.tasks.first)

        let staleResponse = SessionSyncResponse(
            type: "syncResponse",
            messages: [try serverMessage(sequence: 1, crypto: crypto)],
            metadata: try metadata(
                crypto: crypto,
                title: "stale generation",
                isExecuting: true,
                updatedAt: 2_000
            ),
            hasMore: oldHasMore,
            cursor: oldHasMore ? "1" : nil
        )
        XCTAssertTrue(firstTask.completeReceive(.success(.data(
            try JSONEncoder().encode(staleResponse)
        ))))
        let staleDelivery = startTrackedOperation(
            description: "stale session delivery unwound"
        ) {
            await delivery.run()
        }
        await fulfillment(of: [yielder.suspension.reached], timeout: 1.0)

        manager.setAppInForeground(false)
        manager.setAppInForeground(true)
        await delivery.run()
        let replacementTask = try XCTUnwrap(factory.tasks.last)
        let replacementSendCount = replacementTask.pendingSendCount

        yielder.suspension.resume()
        await fulfillment(of: [staleDelivery.completion], timeout: 1.0)
        staleDelivery.task.cancel()

        XCTAssertEqual(
            try database.session(byId: "session-1")?.titleDecrypted,
            "initial",
            "generation N cannot apply metadata after N+1 owns catch-up"
        )
        XCTAssertTrue(diagnostics.isEmpty, "generation N cannot finish N+1 catch-up")
        if oldHasMore {
            XCTAssertEqual(
                replacementTask.pendingSendCount,
                replacementSendCount,
                "generation N cannot paginate on N+1's socket"
            )
        }

        let replacementResponse = SessionSyncResponse(
            type: "syncResponse",
            messages: [try serverMessage(sequence: 2, crypto: crypto)],
            metadata: try metadata(
                crypto: crypto,
                title: "replacement generation",
                isExecuting: false,
                updatedAt: 3_000
            ),
            hasMore: false,
            cursor: "2"
        )
        XCTAssertTrue(replacementTask.completeReceive(.success(.data(
            try JSONEncoder().encode(replacementResponse)
        ))))
        await delivery.run()

        XCTAssertEqual(try database.session(byId: "session-1")?.titleDecrypted, "replacement generation")
        XCTAssertEqual(diagnostics.count, 1, "only generation N+1 may finish catch-up")
        XCTAssertEqual(diagnostics.first?.totalServerMessages, 1)
    }

    func testStaleFinalChunkCannotFinishReplacementCatchUp() async throws {
        try await exerciseStaleFinalChunkSchedule(oldHasMore: false)
    }

    func testStaleFinalChunkCannotApplyMetadataOrPaginateOnReplacementSocket() async throws {
        try await exerciseStaleFinalChunkSchedule(oldHasMore: true)
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
        await sessionSocket.emit(try JSONEncoder().encode(firstPage))
        await settleMainActor(300)

        let secondPage = SessionSyncResponse(
            type: "syncResponse",
            messages: try (257...520).map { try serverMessage(sequence: $0, crypto: crypto) },
            metadata: nil,
            hasMore: false,
            cursor: "520"
        )
        await sessionSocket.emit(try JSONEncoder().encode(secondPage))
        await settleMainActor(300)

        let replay = MessageBroadcast(
            type: "messageBroadcast",
            message: try serverMessage(sequence: 520, crypto: crypto),
            fromConnectionId: "desktop"
        )
        await sessionSocket.emit(try JSONEncoder().encode(replay))
        await settleMainActor()

        let stored = try database.messages(forSession: "session-1")
        XCTAssertEqual(stored.count, 520)
        XCTAssertEqual(stored.map(\.sequence), Array(1...520))
        XCTAssertEqual(try database.syncState(forRoom: "session-1")?.lastSequence, 520)
        XCTAssertEqual(try database.session(byId: "session-1")?.lastSyncedSeq, 520)
    }

    func testSessionServerErrorFinishesOwnedCatchUp() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let sessionSocket = FakeSyncSocket()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: FakeSyncSocket(),
            sessionSocket: sessionSocket
        )
        var diagnostics: [SessionSyncDiagnostic] = []
        manager.addSessionSyncDiagnosticHandler(sessionId: "session-1") { diagnostic in
            diagnostics.append(diagnostic)
        }

        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        manager.joinSessionRoom(sessionId: "session-1")
        await settleMainActor()
        XCTAssertEqual(sessionSocket.sentJSON.count, 1)

        let serverError = ServerError(
            type: "error",
            code: "sync_failed",
            message: "session history unavailable"
        )
        await sessionSocket.emit(try JSONEncoder().encode(serverError))

        XCTAssertEqual(
            diagnostics.last?.error,
            "Server sync error [sync_failed]: session history unavailable"
        )
    }

    func testSessionSyncResponseTimeoutFinishesOwnedCatchUp() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let sessionSocket = FakeSyncSocket()
        let scheduler = ControlledSyncScheduler()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: FakeSyncSocket(),
            sessionSocket: sessionSocket,
            scheduler: scheduler
        )
        var diagnostics: [SessionSyncDiagnostic] = []
        manager.addSessionSyncDiagnosticHandler(sessionId: "session-1") { diagnostic in
            diagnostics.append(diagnostic)
        }

        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        manager.joinSessionRoom(sessionId: "session-1")
        await settleMainActor()
        XCTAssertEqual(sessionSocket.sentJSON.count, 1)
        XCTAssertEqual(scheduler.operations.count, 1)

        scheduler.runNext()

        XCTAssertEqual(diagnostics.last?.error, "Session sync response timed out")
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
        await indexSocket.emit(try JSONEncoder().encode(oldSnapshot))
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
        let delivery = ControlledWebSocketEventDelivery()
        let factory = FakeWebSocketTransportFactory()
        let indexSocket = WebSocketClient(
            transportFactory: factory,
            eventDelivery: delivery
        )
        let executor = ControlledIndexExecutor()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: indexSocket,
            sessionSocket: FakeSyncSocket(),
            executor: executor
        )
        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        await delivery.run()
        let transportTask = try XCTUnwrap(factory.tasks.first)

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

        XCTAssertTrue(transportTask.completeReceive(.success(.data(
            try JSONEncoder().encode(snapshot)
        ))))
        await delivery.run()
        XCTAssertTrue(transportTask.completeReceive(.success(.data(
            try JSONEncoder().encode(pin)
        ))))
        await delivery.run()
        XCTAssertEqual(executor.queued.count, 2)
        executor.runAll()

        XCTAssertTrue(try XCTUnwrap(database.session(byId: "session-1")).isPinned)
    }

    func testSocketActorHopRejectsStaleConnectedAndCompetingOldTaskCallbacks() async throws {
        let delivery = ControlledWebSocketEventDelivery()
        let factory = FakeWebSocketTransportFactory()
        let recorder = SuspendedMessageRecorder()
        let client = WebSocketClient(
            transportFactory: factory,
            eventDelivery: delivery
        )
        client.onConnectionStateChangedWithContext = { connected, context in
            recorder.recordConnection(connected, context: context)
        }
        client.onMessageWithContext = { data, _ in
            await recorder.accept(data)
        }

        client.connect(
            serverUrl: "https://example.invalid",
            roomId: "index:user",
            authToken: "token"
        )
        let firstTask = try XCTUnwrap(factory.tasks.first)
        client.reconnect()
        let secondTask = try XCTUnwrap(factory.tasks.last)

        // Admit N+1 before the deliberately delayed N connected callback.
        await delivery.run(at: 1)
        await delivery.run(at: 0)
        XCTAssertEqual(recorder.connectedGenerations, [2])
        XCTAssertFalse(firstTask.hasPendingReceive)
        XCTAssertTrue(secondTask.hasPendingReceive)

        client.sendRaw("{\"type\":\"syncRequest\"}") { error in
            recorder.recordSend(error: error)
        }
        XCTAssertEqual(secondTask.pendingSendCount, 1)

        client.reconnect()
        let thirdTask = try XCTUnwrap(factory.tasks.last)
        XCTAssertTrue(secondTask.completeReceive(.success(.string("stale snapshot"))))
        secondTask.completeSend(error: nil)

        // Run the old receive and send completions ahead of N+2 admission.
        // They may report a stale send to their caller, but have no socket or
        // manager mutation authority.
        await delivery.run(at: 1)
        await delivery.run(at: 1)
        XCTAssertTrue(recorder.messages.isEmpty)
        XCTAssertEqual(recorder.sendErrorCodes, [-2])
        XCTAssertFalse(thirdTask.hasPendingReceive)

        await delivery.run()
        XCTAssertEqual(recorder.connectedGenerations, [2, 3])
        XCTAssertTrue(thirdTask.hasPendingReceive)
    }

    func testSocketDoesNotArmPinReceiveUntilSuspendedSnapshotDeliveryFinishes() async throws {
        let delivery = ControlledWebSocketEventDelivery()
        let factory = FakeWebSocketTransportFactory()
        let recorder = SuspendedMessageRecorder()
        recorder.suspendNext = true
        let client = WebSocketClient(
            transportFactory: factory,
            eventDelivery: delivery
        )
        client.onMessageWithContext = { data, _ in
            await recorder.accept(data)
        }

        client.connect(
            serverUrl: "https://example.invalid",
            roomId: "index:user",
            authToken: "token"
        )
        await delivery.run()
        let task = try XCTUnwrap(factory.tasks.first)
        XCTAssertTrue(task.completeReceive(.success(.string("snapshot"))))

        let snapshotDelivery = startTrackedOperation(
            description: "snapshot delivery unwound"
        ) {
            await delivery.run()
        }
        await fulfillment(of: [recorder.suspension.reached], timeout: 1.0)

        XCTAssertFalse(task.hasPendingReceive)
        XCTAssertFalse(
            task.completeReceive(.success(.string("pin"))),
            "the next URLSession receive must not be armed while snapshot delivery is suspended"
        )

        recorder.resume()
        await fulfillment(of: [snapshotDelivery.completion], timeout: 1.0)
        snapshotDelivery.task.cancel()
        XCTAssertTrue(task.hasPendingReceive)
        XCTAssertTrue(task.completeReceive(.success(.string("pin"))))
        await delivery.run()

        XCTAssertEqual(recorder.messages, ["snapshot", "pin"])
    }

    func testReconnectDuringLegacyCallbackPreventsContextCallbackDelivery() async throws {
        let delivery = ControlledWebSocketEventDelivery()
        let factory = FakeWebSocketTransportFactory()
        let recorder = SuspendedMessageRecorder()
        recorder.suspendNext = true
        let client = WebSocketClient(
            transportFactory: factory,
            eventDelivery: delivery
        )
        client.onMessage = { data in
            await recorder.accept(data)
        }
        client.onMessageWithContext = { data, _ in
            recorder.recordSecondary(data)
        }

        client.connect(
            serverUrl: "https://example.invalid",
            roomId: "index:user",
            authToken: "token"
        )
        await delivery.run()
        let firstTask = try XCTUnwrap(factory.tasks.first)
        XCTAssertTrue(firstTask.completeReceive(.success(.string("generation N"))))

        let messageDelivery = startTrackedOperation(
            description: "legacy callback delivery unwound"
        ) {
            await delivery.run()
        }
        await fulfillment(of: [recorder.suspension.reached], timeout: 1.0)
        client.reconnect()
        recorder.resume()
        await fulfillment(of: [messageDelivery.completion], timeout: 1.0)
        messageDelivery.task.cancel()

        XCTAssertEqual(recorder.messages, ["generation N"])
        XCTAssertTrue(
            recorder.secondaryMessages.isEmpty,
            "authority must be revalidated between the two awaited callback surfaces"
        )
    }

    func testDocumentCallbacksRemainOrderedAcrossSuspensionAndDelete() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let delivery = ControlledWebSocketEventDelivery()
        let factory = FakeWebSocketTransportFactory()
        let client = WebSocketClient(
            transportFactory: factory,
            eventDelivery: delivery
        )
        let suspension = OneShotSuspension(description: "document message handling suspended")
        let manager = DocumentSyncManager(
            crypto: crypto,
            database: database,
            serverUrl: "https://example.invalid",
            userId: userId,
            clientFactory: { client },
            messageWillHandle: { _, _ in
                await suspension.suspendOnce()
            }
        )
        manager.setAuth(authToken: "token", authUserId: userId, orgId: "org")
        manager.connectProject("/project")
        await delivery.run()
        let task = try XCTUnwrap(factory.tasks.first)

        let encryptedContent = try crypto.encrypt(plaintext: "ordered content")
        let encryptedPath = try crypto.encrypt(plaintext: "notes.md")
        let encryptedTitle = try crypto.encrypt(plaintext: "Notes")
        let content = FileContentBroadcast(
            type: "fileContentBroadcast",
            syncId: "doc-1",
            encryptedContent: encryptedContent.encrypted,
            contentIv: encryptedContent.iv,
            contentHash: "hash-1",
            encryptedPath: encryptedPath.encrypted,
            pathIv: encryptedPath.iv,
            encryptedTitle: encryptedTitle.encrypted,
            titleIv: encryptedTitle.iv,
            lastModifiedAt: 2_000,
            fromConnectionId: "desktop"
        )
        XCTAssertTrue(task.completeReceive(.success(.data(
            try JSONEncoder().encode(content)
        ))))
        let contentDelivery = startTrackedOperation(
            description: "document content delivery unwound"
        ) {
            await delivery.run()
        }
        await fulfillment(of: [suspension.reached], timeout: 1.0)
        XCTAssertFalse(
            task.hasPendingReceive,
            "DocumentSyncManager must keep the socket callback awaited while handling content"
        )

        suspension.resume()
        await fulfillment(of: [contentDelivery.completion], timeout: 1.0)
        contentDelivery.task.cancel()
        XCTAssertNotNil(try database.document(byId: "doc-1"))
        XCTAssertTrue(task.hasPendingReceive)

        let deletion = FileDeleteBroadcast(
            type: "fileDeleteBroadcast",
            syncId: "doc-1",
            fromConnectionId: "desktop"
        )
        XCTAssertTrue(task.completeReceive(.success(.data(
            try JSONEncoder().encode(deletion)
        ))))
        await delivery.run()
        XCTAssertNil(try database.document(byId: "doc-1"))
    }

    func testDocumentFreshClientGenerationOneRebindsAuthorityAndRejectsRetiredClientCallbacks() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let delivery = ControlledWebSocketEventDelivery()
        let firstFactory = FakeWebSocketTransportFactory()
        let secondFactory = FakeWebSocketTransportFactory()
        let firstClient = WebSocketClient(
            transportFactory: firstFactory,
            eventDelivery: delivery
        )
        let secondClient = WebSocketClient(
            transportFactory: secondFactory,
            eventDelivery: delivery
        )
        let clients = DocumentWebSocketClientQueue([firstClient, secondClient])
        let manager = DocumentSyncManager(
            crypto: crypto,
            database: database,
            serverUrl: "https://example.invalid",
            userId: userId,
            clientFactory: { clients.next() },
            messageWillHandle: { _, _ in }
        )
        manager.setAuth(authToken: "token", authUserId: userId, orgId: "org")
        manager.connectProject("/project")
        await delivery.run()

        let firstTask = try XCTUnwrap(firstFactory.tasks.first)
        let firstContext = WebSocketConnectionContext(
            generation: 1,
            roomId: documentRoomId()
        )
        let delayedConnection = try XCTUnwrap(firstClient.onConnectionStateChangedWithContext)
        let delayedMessage = try XCTUnwrap(firstClient.onMessageWithContext)
        XCTAssertTrue(manager.isConnected)
        XCTAssertGreaterThanOrEqual(firstTask.pendingSendCount, 1)

        XCTAssertTrue(firstTask.completeReceive(.failure(
            DeterministicWebSocketError.receiveFailed
        )))
        await delivery.run()
        XCTAssertFalse(manager.isConnected)

        manager.connectProject("/project")
        await delivery.run()
        let secondTask = try XCTUnwrap(secondFactory.tasks.first)
        XCTAssertTrue(manager.isConnected, "fresh client B generation 1 must be authoritative")
        XCTAssertGreaterThanOrEqual(
            secondTask.pendingSendCount,
            1,
            "fresh client B must send its initial sync request"
        )
        XCTAssertTrue(secondTask.hasPendingReceive)

        let freshContent = try documentContentBroadcast(
            syncId: "fresh-doc",
            content: "fresh",
            crypto: crypto
        )
        XCTAssertTrue(secondTask.completeReceive(.success(.data(
            try JSONEncoder().encode(freshContent)
        ))))
        await delivery.run()
        XCTAssertNotNil(try database.document(byId: "fresh-doc"))

        let sendsBeforeRetiredCallbacks = secondTask.pendingSendCount
        delayedConnection(true, firstContext)
        let staleContent = try documentContentBroadcast(
            syncId: "stale-doc",
            content: "stale",
            crypto: crypto
        )
        await delayedMessage(try JSONEncoder().encode(staleContent), firstContext)

        XCTAssertTrue(manager.isConnected)
        XCTAssertEqual(secondTask.pendingSendCount, sendsBeforeRetiredCallbacks)
        XCTAssertNil(
            try database.document(byId: "stale-doc"),
            "retired client A callbacks must fail exact identity/context authority"
        )
    }

    func testDocumentDisconnectRejectsDelayedLowerConnectedGenerationAtManagerGate() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let delivery = ControlledWebSocketEventDelivery()
        let factory = FakeWebSocketTransportFactory()
        let client = WebSocketClient(
            transportFactory: factory,
            eventDelivery: delivery
        )
        let manager = DocumentSyncManager(
            crypto: crypto,
            database: database,
            serverUrl: "https://example.invalid",
            userId: userId,
            clientFactory: { client },
            messageWillHandle: { _, _ in }
        )
        manager.setAuth(authToken: "token", authUserId: userId, orgId: "org")
        manager.connectProject("/project")
        client.reconnect()

        await delivery.run(at: 1)
        XCTAssertTrue(manager.isConnected)
        let managerCallback = try XCTUnwrap(client.onConnectionStateChangedWithContext)
        let roomId = documentRoomId()
        managerCallback(false, WebSocketConnectionContext(generation: 2, roomId: roomId))
        XCTAssertFalse(manager.isConnected)

        managerCallback(true, WebSocketConnectionContext(generation: 1, roomId: roomId))
        XCTAssertFalse(
            manager.isConnected,
            "the manager watermark must reject a delayed lower generation after disconnect"
        )
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
        await indexSocket.emit(data, context: oldContext)
        await settleMainActor()
        XCTAssertEqual(executor.queued.count, 1)

        manager.setAppInForeground(false)
        manager.setAppInForeground(true)
        await settleMainActor()
        let replacementContext = try XCTUnwrap(indexSocket.currentContext)
        executor.runAll()
        XCTAssertEqual(try database.session(byId: "session-1")?.titleDecrypted, "current")

        let queuedAfterReconnect = executor.queued.count
        await indexSocket.emit(data, context: oldContext)
        await settleMainActor()
        XCTAssertEqual(executor.queued.count, queuedAfterReconnect)

        let sendsAfterReconnect = indexSocket.sentJSON.count
        indexSocket.emitConnection(true, context: oldContext)
        XCTAssertEqual(
            indexSocket.sentJSON.count,
            sendsAfterReconnect,
            "a stale connected callback must not replace newer manager context or trigger catch-up"
        )

        indexSocket.emitConnection(false, context: replacementContext)
        let sendsAfterReplacementDisconnect = indexSocket.sentJSON.count
        indexSocket.emitConnection(true, context: oldContext)
        XCTAssertFalse(manager.isConnected)
        XCTAssertEqual(
            indexSocket.sentJSON.count,
            sendsAfterReplacementDisconnect,
            "disconnect must not erase the highest accepted index generation"
        )
    }

    func testSessionDisconnectDoesNotEraseHighestAcceptedGeneration() async throws {
        let database = try makeDatabaseWithSession()
        let crypto = makeCrypto()
        let sessionSocket = FakeSyncSocket()
        let manager = makeManager(
            database: database,
            crypto: crypto,
            indexSocket: FakeSyncSocket(),
            sessionSocket: sessionSocket
        )
        manager.connect(authToken: "token", authUserId: userId, orgId: "org")
        manager.joinSessionRoom(sessionId: "session-1")
        let oldContext = try XCTUnwrap(sessionSocket.currentContext)

        manager.setAppInForeground(false)
        manager.setAppInForeground(true)
        let replacementContext = try XCTUnwrap(sessionSocket.currentContext)
        sessionSocket.emitConnection(false, context: replacementContext)
        let sendsAfterReplacementDisconnect = sessionSocket.sentJSON.count

        sessionSocket.emitConnection(true, context: oldContext)
        XCTAssertEqual(
            sessionSocket.sentJSON.count,
            sendsAfterReplacementDisconnect,
            "disconnect must not let an older session generation restart catch-up"
        )
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
