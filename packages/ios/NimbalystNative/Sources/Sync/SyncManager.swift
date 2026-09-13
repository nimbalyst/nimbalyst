import Foundation
import Combine
import os

/// Manages synchronization between the native app and the desktop via WebSocket.
/// Handles index room sync (projects + sessions) and session room sync (messages).
///
/// Architecture:
///   - Connects to the index room: `user:<userId>:index`
///   - Receives encrypted sessions and projects from the server
///   - Decrypts using CryptoManager and stores in SQLite via DatabaseManager
///   - SwiftUI views observe the database for reactive updates
@MainActor
public final class SyncManager: ObservableObject {
    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")

    private let crypto: CryptoManager
    private let database: DatabaseManager
    private let indexClient: WebSocketClient = {
        let client = WebSocketClient()
        client.sendsDeviceAnnounce = true
        return client
    }()
    private let sessionClient = WebSocketClient()
    private let decoder = JSONDecoder()
    /// Decodes index-room JSON away from the main actor. See IndexMessageDecoder.
    private let indexDecoder = IndexMessageDecoder()

    @Published public var isConnected = false
    @Published public private(set) var indexLoadState: IndexLoadState = .loading
    @Published public var connectedDevices: [DeviceInfo] = []

    /// The session ID currently connected to the session room, if any.
    @Published public var activeSessionId: String?

    /// Available AI models synced from the desktop, for the model picker.
    @Published public var availableModels: [SyncedAvailableModel] = []

    /// The desktop's default model ID (e.g., "claude-code:opus").
    @Published public var desktopDefaultModel: String?

    /// A complete full index had no decryptable entries, so pairing may need
    /// attention. Partial sync and database failures cannot establish this.
    @Published public var encryptionKeyMismatch = false
    private var hasDecryptedIndexEntry = false

    /// Called when a session transitions from executing to idle (isExecuting: true -> false).
    /// Parameters: (sessionId, lastAssistantMessageSummary)
    public var onSessionCompleted: ((String, String) -> Void)?

    /// Called when settings are synced from the desktop (e.g., OpenAI API key, voice mode config).
    public var onSettingsSynced: ((SyncedSettings) -> Void)?

    /// Called when the desktop confirms a create-session request succeeded.
    /// Parameters: (requestId, sessionId). The `requestId` lets the caller match
    /// the response to a request it originated (this broadcast reaches every
    /// paired device), so only the requesting device navigates to the new session.
    public var onSessionCreated: ((String, String) -> Void)?
    private var pendingCreationDrafts: [String: String] = [:]
    private var pendingSessionDrafts: [String: String] = [:]

    /// Called with diagnostic info when session message sync completes (success or failure).
    /// Parameters: (sessionId, diagnostic).
    ///
    /// Deprecated: prefer `addSessionSyncDiagnosticHandler(sessionId:handler:)`,
    /// which is robust against the SwiftUI lifecycle race where an outgoing
    /// view's `onDisappear` nulls the single shared callback before the
    /// incoming view's `onAppear` has re-registered, causing sync diagnostics
    /// to be silently dropped for the newly-opened session. Kept as a fallback
    /// so any remaining single-callback consumers still fire.
    public var onSessionSyncDiagnostic: ((String, SessionSyncDiagnostic) -> Void)?

    /// Per-session diagnostic handlers. Multiple views (e.g., outgoing + incoming
    /// during navigation) can subscribe without stomping on each other.
    private var sessionSyncDiagnosticHandlers: [String: (SessionSyncDiagnostic) -> Void] = [:]

    /// Register a diagnostic handler for a specific session.
    /// Replaces any previous handler for the same sessionId.
    public func addSessionSyncDiagnosticHandler(
        sessionId: String,
        handler: @escaping (SessionSyncDiagnostic) -> Void
    ) {
        sessionSyncDiagnosticHandlers[sessionId] = handler
    }

    /// Remove the diagnostic handler for a specific session.
    public func removeSessionSyncDiagnosticHandler(sessionId: String) {
        sessionSyncDiagnosticHandlers.removeValue(forKey: sessionId)
    }

    /// Dispatch a diagnostic to both the per-session handler (if registered)
    /// and the legacy single-callback consumer.
    private func emitSessionSyncDiagnostic(_ sessionId: String, _ diagnostic: SessionSyncDiagnostic) {
        sessionSyncDiagnosticHandlers[sessionId]?(diagnostic)
        onSessionSyncDiagnostic?(sessionId, diagnostic)
    }

    private var serverUrl: String
    private var userId: String
    /// The Stytch user ID for room routing (from JWT sub claim). May differ from pairing userId.
    private var authUserId: String?
    private var authToken: String?
    /// The Stytch organization ID for org-scoped room IDs.
    private var orgId: String?

    /// Buffer for paginated sync responses before committing to DB.
    private var sessionSyncBuffer: [ServerMessageEntry] = []

    // MARK: - Index Ingestion

    /// The serial owner of index decode/decrypt/apply work for the current
    /// connection generation. See `IndexIngestion`.
    private var ingestion: IndexIngestion!
    private var ingestionGeneration = 0
    /// The index room the current generation belongs to.
    private var connectedIndexRoomId: String?
    /// Correlates a bulk response with the load state it owns, so a stale
    /// response cannot report completion for a newer request.
    private var indexResponseCounter = 0
    private var awaitedIndexResponseId: Int?

    /// Counters from the most recent ingestion outcome. Durations and counts
    /// only; exposed for measurement and tests.
    private(set) var lastIndexIngestionMetrics: IndexIngestionMetrics?

    /// Work submitted but not yet applied, for tests and diagnostics.
    var pendingIndexIngestionCount: Int { ingestion.pendingCount }

    /// Whether the last index response was decoded off the main actor. The
    /// production path must always be true; the synchronous entry point is not.
    private(set) var lastIndexDecodeWasOffMainActor = false

    // MARK: - Versioned Replication

    /// Drives versioned index replication for the current generation.
    private var replication: IndexReplicationClient?

    /// What the local index has actually proven. The list reads this to decide
    /// whether "no results" means "nothing matches" or "we are still checking
    /// older history".
    @Published public private(set) var indexCoverage = IndexCoverage()

    /// Compatibility accessor for the session list.
    public var historyComplete: Bool { indexCoverage.historyComplete }

    public convenience init(crypto: CryptoManager, database: DatabaseManager, serverUrl: String, userId: String) {
        self.init(crypto: crypto, database: database, serverUrl: serverUrl, userId: userId, registerDeviceCallbacks: true)
    }

    /// Allows index import tests to run without an application notification center.
    init(crypto: CryptoManager, database: DatabaseManager, serverUrl: String, userId: String, registerDeviceCallbacks: Bool) {
        self.crypto = crypto
        self.database = database
        self.serverUrl = serverUrl
        self.userId = userId

        startIndexIngestionGeneration()
        setupIndexClient()
        setupSessionClient()
        if registerDeviceCallbacks {
            setupPushTokenForwarding()
            setupLiveActivityForwarding()
        }
    }

    /// Retire the current ingestion owner and start one for a new connection
    /// generation. Queued work from the old generation is dropped and its late
    /// outcomes are ignored: it was decrypted for an identity we may no longer
    /// be writing for, and the fresh connection re-requests the index anyway.
    private func startIndexIngestionGeneration() {
        ingestion?.cancel()
        ingestionGeneration += 1
        awaitedIndexResponseId = nil
        let generation = ingestionGeneration
        ingestion = IndexIngestion(
            generation: generation,
            crypto: crypto,
            database: database,
            onOutcome: { [weak self] outcome in
                self?.applyIndexIngestionOutcome(outcome)
            },
            onPageOutcome: { [weak self] outcome in
                self?.replication?.handle(outcome: outcome)
            },
            onMaintenanceOutcome: { [weak self] outcome in
                self?.replication?.handle(maintenance: outcome)
            }
        )

        replication?.cancel()
        replication = IndexReplicationClient(
            generation: generation,
            send: { [weak self] json in
                self?.indexClient.sendRaw(json)
            },
            submitPage: { [weak self] response, request in
                guard let self else { return }
                self.ingestion.submit(.page(response, request: request), byteCount: 0)
            },
            submitMaintenance: { [weak self] request, id in
                guard let self else { return }
                self.ingestion.submit(.maintenance(request, id: id), byteCount: 0)
            },
            onCoverageChanged: { [weak self] coverage in
                guard let self else { return }
                self.indexCoverage = coverage
                if coverage.hasError {
                    // Sync failed. Cached rows stay on screen -- a failure is not
                    // an empty account -- but the list must stop reporting that
                    // it is still loading, or a v2 failure leaves the sidebar
                    // spinning forever.
                    self.indexLoadState = .failed
                    return
                }
                switch coverage.compatibility {
                case .v2 where self.indexLoadState != .loaded:
                    // At least one page applied, so the list has real data.
                    self.indexLoadState = .loaded
                case .unsupported where self.indexLoadState == .loading:
                    self.indexLoadState = .failed
                default:
                    break
                }
            },
            onLegacyServer: { [weak self] in
                // The server predates versioned replication: fall back to the
                // legacy index request rather than showing an empty list.
                self?.requestIndexSync()
            }
        )
    }

    // MARK: - Versioned Replication Handling

    /// Index-room errors carry an optional requestId on a v2 server. An
    /// `unknown_message_type` with no requestId, answering our first probe, is
    /// the one and only signal that the server predates versioned replication.
    private func handleIndexError(_ data: Data) {
        struct IndexErrorMessage: Decodable {
            let code: String
            let message: String?
            let requestId: String?
        }
        guard let error = try? decoder.decode(IndexErrorMessage.self, from: data) else {
            if indexLoadState == .loading { indexLoadState = .failed }
            handleServerError(data)
            return
        }
        logger.error("Index server error [\(error.code)]: \(error.message ?? "")")
        replication?.handle(errorCode: error.code, requestId: error.requestId)
        if indexLoadState == .loading, error.code != "unknown_message_type" {
            indexLoadState = .failed
        }
    }

    private func handleIndexPageResponse(_ response: IndexPageResponse, decoded: DecodedIndexMessageResult) {
        lastIndexDecodeWasOffMainActor = decoded.decodedOffMainActor
        guard replication?.handle(page: response) == true else { return }
    }

    private func handleIndexChangesAvailable(revision: Int) {
        replication?.handle(changesAvailable: revision)
    }

    private func applyIndexIngestionOutcome(_ outcome: IndexIngestionOutcome) {
        guard outcome.generation == ingestionGeneration else {
            logger.info("Ignoring index outcome from retired generation \(outcome.generation)")
            return
        }
        applyPendingCreationDrafts()
        lastIndexIngestionMetrics = outcome.metrics

        // Successful decryption clears earlier suspicion. A failed delta
        // cannot create a new device-wide pairing warning.
        if outcome.summary.decryptedEntryCount > 0 {
            hasDecryptedIndexEntry = true
            encryptionKeyMismatch = false
        } else if !outcome.isIncremental {
            encryptionKeyMismatch = outcome.summary.shouldSuggestRepair && !hasDecryptedIndexEntry
        }

        // Only the response the current load state is waiting on may end it.
        guard outcome.responseId == awaitedIndexResponseId else { return }
        awaitedIndexResponseId = nil
        indexLoadState = outcome.summary.failed ? .failed : .loaded
    }

    // MARK: - Activity Tracking

    /// Report actual user interaction (touch, scroll, tap, etc.).
    /// Call this from views when the user actively interacts with the app.
    public func reportUserActivity() {
        indexClient.reportActivity()
    }

    /// Update whether the app is in the foreground.
    /// Coming to foreground counts as user activity.
    /// When returning to foreground, reconnects WebSockets if they were dropped while backgrounded.
    public func setAppInForeground(_ inForeground: Bool) {
        indexClient.setAppInForeground(inForeground)
        // History backfill pauses while backgrounded; navigation lookups and
        // delta catch-up continue.
        replication?.setForeground(inForeground)
        if inForeground {
            reconnectIfNeeded()
            // Defense in depth: even if the reconnect's onConnectionStateChanged
            // callback fires the sync request, also trigger one explicitly
            // here. Two sync requests are harmless (database appends are
            // idempotent on message ID), and this guarantees a catch-up
            // happens even if the reconnect callback chain ever changes.
            if activeSessionId != nil {
                requestSessionSync()
            }
        }
    }

    /// Reconnect the index WebSocket if it was dropped (e.g., by iOS suspending the app).
    /// Also reconnects the active session room if one was open.
    ///
    /// The session client is reconnected unconditionally (not gated on
    /// `isConnected`) because URLSessionWebSocketTask can hold a backgrounded
    /// task in `.running` state long after the underlying TCP connection has
    /// died, so `isConnected` would lie and the user would be left with a
    /// silently-dead transcript channel until they navigate away and back.
    /// Forcing a fresh socket here is cheap; missing transcript broadcasts
    /// is not. The session client also re-issues `requestSessionSync` on
    /// reconnect (via `onConnectionStateChanged`), so any broadcasts dropped
    /// while we were backgrounded are caught up via the syncResponse cursor.
    private func reconnectIfNeeded() {
        if !indexClient.isConnected {
            logger.info("[Reconnect] Index client disconnected, reconnecting...")
            indexClient.reconnect()
        }
        if let sessionId = activeSessionId {
            logger.info("[Reconnect] Forcing session client reconnect for \(sessionId)")
            sessionClient.reconnect()
        }
    }

    // MARK: - Connection

    /// Connect to the index room and begin syncing.
    /// The `authUserId` is the Stytch user ID from the JWT's `sub` claim, used for room ID construction.
    /// This may differ from the pairing `userId` (which can be an email or analytics ID).
    /// The `orgId` is the Stytch organization ID from B2B discovery, required for org-scoped room IDs.
    public func connect(authToken: String, authUserId: String? = nil, orgId: String) {
        self.authToken = authToken
        self.authUserId = authUserId
        self.orgId = orgId
        let roomId = "org:\(orgId):user:\(effectiveUserId):index"
        // A different room is a different identity: index work decrypted for the
        // previous one must never reach this account's database.
        if roomId != connectedIndexRoomId {
            connectedIndexRoomId = roomId
            startIndexIngestionGeneration()
        }
        logger.info("[Connect] IndexRoom roomId=\(roomId), orgId=\(orgId), effectiveUserId=\(self.effectiveUserId), authUserId=\(authUserId ?? "nil"), pairingUserId=\(self.userId)")
        indexClient.connect(serverUrl: serverUrl, roomId: roomId, authToken: authToken)

        // If a session room is active, reconnect it with the fresh token.
        // Without this, the session client keeps the old JWT and the server
        // rejects reconnect attempts after the JWT expires.
        if let sessionId = activeSessionId {
            let sessionRoomId = "org:\(orgId):user:\(effectiveUserId):session:\(sessionId)"
            logger.info("[Connect] Reconnecting session room with fresh token: \(sessionRoomId)")
            sessionClient.connect(serverUrl: serverUrl, roomId: sessionRoomId, authToken: authToken)
        }
    }

    /// The user ID to use for room routing. Prefers authUserId (from JWT) over pairing userId.
    private var effectiveUserId: String {
        authUserId ?? userId
    }

    /// Disconnect from all rooms.
    public func disconnect() {
        pendingCreationDrafts.removeAll()
        pendingSessionDrafts.removeAll()
        leaveSessionRoom()
        indexClient.disconnect()
        // Drop the backlog this connection produced. A reconnect requests the
        // index again from the last committed cursor, so nothing is lost, and a
        // late outcome cannot report completion for a connection that is gone.
        connectedIndexRoomId = nil
        startIndexIngestionGeneration()
    }

    // MARK: - Session Room

    /// Join a session room to sync messages.
    public func joinSessionRoom(sessionId: String) {
        guard let authToken = authToken else {
            return
        }

        // Leave current session room if any
        if activeSessionId != nil {
            leaveSessionRoom()
        }

        activeSessionId = sessionId
        sessionSyncBuffer = []

        let roomId = "org:\(orgId ?? ""):user:\(effectiveUserId):session:\(sessionId)"
        sessionClient.connect(serverUrl: serverUrl, roomId: roomId, authToken: authToken)

        // If the session is already mid-turn when we join, start pings now.
        // The normal start path is the !executing -> executing transition in
        // handleMetadataBroadcast, but that only fires on a state change --
        // joining a session that's already running wouldn't trigger it.
        if let session = try? database.session(byId: sessionId), session.isExecuting {
            sessionClient.startPings()
        }
    }

    /// Leave the current session room.
    ///
    /// Pass `expectedSessionId` to scope the leave to a specific session.
    /// This prevents a SwiftUI lifecycle race where the outgoing view's
    /// `.onDisappear` fires AFTER the incoming view's `.task` has already
    /// joined a new room -- in that case, calling a bare `leaveSessionRoom()`
    /// would tear down the new session's socket and null out activeSessionId,
    /// leaving the new session stuck forever waiting for a sync response.
    public func leaveSessionRoom(expectedSessionId: String? = nil) {
        if let expectedSessionId = expectedSessionId,
           activeSessionId != expectedSessionId {
            logger.info("leaveSessionRoom: skipping stale leave for \(expectedSessionId) — active is \(self.activeSessionId ?? "nil")")
            return
        }
        sessionClient.disconnect()
        activeSessionId = nil
        sessionSyncBuffer = []
    }

    // MARK: - Index Client Setup

    private func setupIndexClient() {
        indexClient.onConnectionStateChanged = { [weak self] connected in
            Task { @MainActor in
                self?.isConnected = connected
                if connected {
                    // Versioned replication probes first; the probe's
                    // unknown_message_type answer is what falls back to the
                    // legacy index request (see IndexReplicationClient).
                    self?.indexLoadState = .loading
                    self?.replication?.start()
                    if NotificationManager.shared.shouldRegisterForPush,
                       let token = NotificationManager.shared.deviceToken {
                        self?.registerPushToken(token)
                    } else {
                        self?.unregisterPushToken()
                    }
                    // ActivityKit hands out a push-to-start token once per
                    // launch, which is routinely before the socket is up. A
                    // token that only existed while we were disconnected is a
                    // card that never appears, with nothing to see in any log.
                    if FleetActivityController.shared.shouldRegister {
                        FleetActivityController.shared.resendTokens()
                    } else {
                        self?.unregisterLiveActivityToken(kind: nil)
                    }
                }
            }
        }

        // The awaited handler (as used by document sync) reads one message at a
        // time. Handling stays cheap -- decode, then hand the entry to the
        // ingestion queue -- and only suspends while that queue is over its
        // byte budget, so a history burst throttles the socket instead of
        // growing an unbounded backlog. Command responses and session control
        // are handled inline and never wait behind history work.
        indexClient.onMessageAsync = { [weak self] data in
            guard let self else { return }
            await self.receiveIndexMessage(data)
            await self.ingestion.awaitCapacity()
        }
    }

    /// Fetch one session and its ancestors immediately, whatever the list has
    /// paged in. Used by notification, deep-link and voice navigation.
    ///
    /// Navigation takes priority over history fill: the request goes out at the
    /// next page boundary and the bootstrap resumes afterwards from where it
    /// left off. It never advances the replication cursor. On a legacy server
    /// this falls back to a full index sync, which is the only way that protocol
    /// can fetch a row it has not seen.
    public func requestSessionIndexLookup(sessionId: String) {
        guard indexCoverage.compatibility == .v2 else {
            // Legacy has no way to ask for one row, so this is a full index
            // sync. Coalesced against the one already running: a navigation
            // poller must not restart the whole index on every tick.
            guard awaitedIndexResponseId == nil else {
                logger.info("Session lookup for \(sessionId) folded into the index sync already in flight")
                return
            }
            requestIndexSync(fullSync: true)
            return
        }
        replication?.lookup(sessionIds: [sessionId])
    }

    /// Request a full index sync (ignoring watermark). Called by AppState on pull-to-refresh.
    ///
    /// On a versioned server this restarts replication -- a bounded recent seed
    /// followed by whatever coverage is still owed -- rather than pulling the
    /// whole unbounded legacy envelope again.
    public func requestFullSync() {
        if indexCoverage.compatibility == .v2 {
            indexLoadState = .loading
            replication?.start()
        } else {
            requestIndexSync(fullSync: true)
        }
    }

    /// Request the index from the server.
    /// By default, sends the last sync watermark for incremental sync.
    /// Pass `fullSync: true` to request everything (e.g., pull-to-refresh).
    private func requestIndexSync(fullSync: Bool = false, attempt: Int = 0) {
        indexLoadState = .loading
        let since: Int? = fullSync ? nil : (try? database.syncState(forRoom: "index"))?.lastSyncedAt

        let request = IndexSyncRequest(projectId: nil, since: since)
        guard let data = try? JSONEncoder().encode(request),
              let json = String(data: data, encoding: .utf8) else { return }

        indexClient.sendRaw(json) { [weak self] error in
            guard let self = self, error != nil else { return }
            guard attempt < 3 else {
                self.indexLoadState = .failed
                return
            }

            self.logger.info("Index sync request failed, retrying (attempt \(attempt + 1))")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.requestIndexSync(fullSync: fullSync, attempt: attempt + 1)
            }
        }
    }

    // MARK: - Message Handling

    /// Production entry point. The JSON decode -- thousands of entry structs for
    /// a cold index -- runs on the decoder actor, and only the routing decision
    /// comes back to the main actor. The socket handler awaits this before
    /// reading the next message, so arrival order is preserved without a
    /// detached task per message.
    func receiveIndexMessage(_ data: Data) async {
        let decoded = await indexDecoder.decode(data)
        route(decoded)
    }

    /// Synchronous entry point kept for callers that cannot await. It runs the
    /// same decode on the caller's thread and the same routing, so the two paths
    /// cannot drift apart.
    func handleIndexMessage(_ data: Data) {
        route(IndexMessageDecoder.decode(data))
    }

    /// A v2 server suppresses legacy index broadcasts. One that arrives anyway
    /// is late traffic from before negotiation: it carries no revision, so
    /// applying it could overwrite a newer versioned row with an older one.
    private var ignoresLegacyIndexTraffic: Bool {
        indexCoverage.compatibility == .v2
    }

    private func route(_ decoded: DecodedIndexMessageResult) {
        switch decoded.message {
        case .syncResponse(let response):
            handleIndexSyncResponse(response, decoded: decoded)
        case .session(let entry):
            guard !ignoresLegacyIndexTraffic else { return }
            ingestion.submit(.session(entry), byteCount: decoded.byteCount)
        case .delete(let sessionId):
            guard !ignoresLegacyIndexTraffic else { return }
            logger.info("Session deleted: \(sessionId)")
            ingestion.submit(.delete(sessionId: sessionId), byteCount: decoded.byteCount)
        case .project(let entry):
            guard !ignoresLegacyIndexTraffic else { return }
            ingestion.submit(.project(entry), byteCount: decoded.byteCount)
        case .page(let response):
            handleIndexPageResponse(response, decoded: decoded)
        case .changesAvailable(let revision):
            handleIndexChangesAvailable(revision: revision)
        case .undecodable(let type):
            logger.warning("Could not decode index message\(type.map { " of type \($0)" } ?? "")")
            if type == "indexSyncResponse" || type == "indexPageResponse" {
                indexLoadState = .failed
            }
        case .control(let type, let data):
            routeControl(type: type, data: data)
        }
    }

    private func routeControl(type: String, data: Data) {
        switch type {
        case "createSessionResponseBroadcast":
            handleCreateSessionResponse(data)
        case "devicesList":
            handleDevicesList(data)
        case "deviceJoined":
            handleDeviceJoined(data)
        case "deviceLeft":
            handleDeviceLeft(data)
        case "settingsSyncBroadcast":
            handleSettingsSyncBroadcast(data)
        case "createWorktreeResponseBroadcast":
            // Response to our worktree creation request - the worktree session
            // will appear via indexBroadcast, so no special handling needed
            break
        case "voiceToolResponseBroadcast":
            handleVoiceToolResponse(data)
        case "error":
            handleIndexError(data)
        default:
            logger.info("Unhandled message type: \(type)")
        }
    }

    // MARK: - Index Sync Response

    private func handleIndexSyncResponse(_ response: IndexSyncResponse, decoded: DecodedIndexMessageResult) {
        indexLoadState = .loading

        let isIncremental = response.since != nil
        if !isIncremental, let total = response.totalSessionCount, total != response.sessions.count {
            logger.warning("INDEX TRUNCATION DETECTED! Server COUNT(*)=\(total) but received \(response.sessions.count) sessions")
        }
        logger.info("Index sync received: \(response.sessions.count) sessions, \(response.projects.count) projects\(isIncremental ? " (incremental)" : "") (server total: \(response.totalSessionCount.map(String.init) ?? "unknown"))")

        // Decryption and every database write happen on the ingestion queue,
        // in arrival order with the live broadcasts around them.
        indexResponseCounter += 1
        awaitedIndexResponseId = indexResponseCounter
        lastIndexDecodeWasOffMainActor = decoded.decodedOffMainActor
        ingestion.submit(
            .syncResponse(response, id: indexResponseCounter, decodeMs: decoded.decodeMs),
            byteCount: decoded.byteCount
        )
    }

    // MARK: - Real-time Broadcasts

    private func handleCreateSessionResponse(_ data: Data) {
        guard let broadcast = try? decoder.decode(CreateSessionResponseBroadcast.self, from: data) else {
            logger.error("Failed to decode create_session_response_broadcast")
            return
        }
        let draft = pendingCreationDrafts.removeValue(forKey: broadcast.response.requestId)
        if broadcast.response.success {
            let sessionId = broadcast.response.sessionId ?? "unknown"
            logger.info("Session created: \(sessionId)")
            if let sessionId = broadcast.response.sessionId {
                if let draft {
                    pendingSessionDrafts[sessionId] = draft
                    applyPendingCreationDrafts()
                    if pendingSessionDrafts[sessionId] != nil { requestSessionIndexLookup(sessionId: sessionId) }
                }
                onSessionCreated?(broadcast.response.requestId, sessionId)
            }
        } else {
            logger.error("Session creation failed: \(broadcast.response.error ?? "unknown error")")
        }
    }

    private func applyPendingCreationDrafts() {
        for (sessionId, draft) in pendingSessionDrafts {
            guard (try? database.session(byId: sessionId)) != nil else { continue }
            updateDraftInput(sessionId: sessionId, draftInput: draft)
            pendingSessionDrafts.removeValue(forKey: sessionId)
        }
    }

    // MARK: - Voice Tool Proxy (mobile -> desktop)

    /// Result of a proxied voice tool call.
    public struct VoiceToolCallResult {
        public let success: Bool
        public let result: String?
        public let error: String?
    }

    /// Continuations awaiting a desktop voice-tool response, keyed by requestId.
    private var pendingVoiceToolCalls: [String: CheckedContinuation<VoiceToolCallResult, Never>] = [:]

    /// Voice-tool request timeout. The memory engine lives on the desktop; if no
    /// desktop is connected the request never gets answered, so we resolve
    /// gracefully after this window.
    private static let voiceToolTimeoutNs: UInt64 = 30_000_000_000 // 30s

    /// Run a desktop-hosted voice tool (e.g. project-memory lookup) by proxying
    /// it over the sync channel. Returns the tool result, or a graceful failure
    /// if the desktop is unavailable / doesn't respond in time.
    public func callVoiceTool(toolName: String, argsJson: String, projectId: String) async -> VoiceToolCallResult {
        let encryptedProjectId: String
        let toolNameEnc: (encrypted: String, iv: String)
        let argsEnc: (encrypted: String, iv: String)
        do {
            encryptedProjectId = try crypto.encryptProjectId(projectId)
            toolNameEnc = try crypto.encrypt(plaintext: toolName)
            argsEnc = try crypto.encrypt(plaintext: argsJson)
        } catch {
            return VoiceToolCallResult(success: false, result: nil, error: "Failed to encrypt voice tool request")
        }

        let requestId = UUID().uuidString
        let message = VoiceToolRequestMessage(
            request: EncryptedVoiceToolRequest(
                requestId: requestId,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedToolName: toolNameEnc.encrypted,
                toolNameIv: toolNameEnc.iv,
                encryptedArgs: argsEnc.encrypted,
                argsIv: argsEnc.iv,
                timestamp: Int(Date().timeIntervalSince1970 * 1000)
            )
        )

        guard let data = try? JSONEncoder().encode(message),
              let json = String(data: data, encoding: .utf8) else {
            return VoiceToolCallResult(success: false, result: nil, error: "Failed to encode voice tool request")
        }

        return await withCheckedContinuation { continuation in
            pendingVoiceToolCalls[requestId] = continuation
            indexClient.sendRaw(json)

            // Timeout fallback (desktop offline / slow).
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: SyncManager.voiceToolTimeoutNs)
                guard let self else { return }
                if let pending = self.pendingVoiceToolCalls.removeValue(forKey: requestId) {
                    pending.resume(returning: VoiceToolCallResult(
                        success: false,
                        result: nil,
                        error: "Project memory is unavailable because your desktop isn't connected."
                    ))
                }
            }
        }
    }

    private func handleVoiceToolResponse(_ data: Data) {
        guard let broadcast = try? decoder.decode(VoiceToolResponseBroadcast.self, from: data) else {
            logger.error("Failed to decode voiceToolResponseBroadcast")
            return
        }
        let resp = broadcast.response
        guard let continuation = pendingVoiceToolCalls.removeValue(forKey: resp.requestId) else {
            return // already resolved by timeout, or not ours
        }
        var resultText: String?
        if let enc = resp.encryptedResult, let iv = resp.resultIv {
            resultText = crypto.decryptOrNil(encryptedBase64: enc, ivBase64: iv)
        }
        var errorText: String?
        if let enc = resp.encryptedError, let iv = resp.errorIv {
            errorText = crypto.decryptOrNil(encryptedBase64: enc, ivBase64: iv)
        }
        continuation.resume(returning: VoiceToolCallResult(
            success: resp.success,
            result: resultText,
            error: errorText
        ))
    }

    // MARK: - Device Presence

    private func handleDevicesList(_ data: Data) {
        struct DevicesListMessage: Codable {
            let devices: [DeviceInfo]
        }
        guard let msg = try? decoder.decode(DevicesListMessage.self, from: data) else { return }
        connectedDevices = msg.devices
    }

    private func handleDeviceJoined(_ data: Data) {
        struct DeviceJoinedMessage: Codable {
            let device: DeviceInfo
        }
        guard let msg = try? decoder.decode(DeviceJoinedMessage.self, from: data) else { return }
        if !connectedDevices.contains(where: { $0.deviceId == msg.device.deviceId }) {
            connectedDevices.append(msg.device)
        }
    }

    private func handleDeviceLeft(_ data: Data) {
        struct DeviceLeftMessage: Codable {
            let deviceId: String
        }
        guard let msg = try? decoder.decode(DeviceLeftMessage.self, from: data) else { return }
        connectedDevices.removeAll { $0.deviceId == msg.deviceId }
    }

    // MARK: - Settings Sync

    private func handleSettingsSyncBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(SettingsSyncBroadcast.self, from: data) else {
            logger.error("Failed to decode settingsSyncBroadcast")
            return
        }

        let payload = broadcast.settings
        logger.info("Received settings sync from device: \(payload.deviceId), version: \(payload.version)")

        // Decrypt the settings JSON using the shared encryption key
        guard let settingsJson = crypto.decryptOrNil(
            encryptedBase64: payload.encryptedSettings,
            ivBase64: payload.settingsIv
        ) else {
            logger.error("Failed to decrypt synced settings")
            return
        }

        guard let settingsData = settingsJson.data(using: .utf8),
              let settings = try? JSONDecoder().decode(SyncedSettings.self, from: settingsData) else {
            logger.error("Failed to parse decrypted settings JSON")
            return
        }

        logger.info("Decrypted settings: version=\(settings.version), hasOpenAIKey=\(settings.openaiApiKey != nil)")

        // Store the OpenAI API key in the Keychain
        do {
            if try applySyncedOpenAIKey(settings.openaiApiKey, store: KeychainManager.storeOpenAIApiKey, delete: KeychainManager.deleteOpenAIApiKey) {
                NotificationCenter.default.post(name: .init("OpenAIApiKeySynced"), object: nil)
            }
        } catch {
            logger.error("Could not apply synced OpenAI credential to Keychain")
        }

        #if os(iOS)
        // Store voice mode settings if present. preferredAgentLanguage is a
        // top-level field, so persist it even when voiceMode itself is absent --
        // it pins the voice agent's spoken language to the desktop default.
        if settings.voiceMode != nil || settings.preferredAgentLanguage != nil {
            var currentSettings = VoiceModeSettings.load()
            if let voiceMode = settings.voiceMode {
                if let voice = voiceMode.voice {
                    currentSettings.voice = voice
                }
                if let delay = voiceMode.submitDelayMs {
                    currentSettings.promptConfirmationDelay = TimeInterval(delay) / 1000.0
                }
            }
            currentSettings.language = settings.preferredAgentLanguage
            currentSettings.save()
        }
        #endif

        // Store available models from desktop for the model picker and persist
        if let models = settings.availableModels {
            availableModels = models
            ModelPreferences.saveAvailableModels(models, defaultModel: settings.defaultModel)
            logger.info("Synced \(models.count) available models from desktop")
        }
        if let defaultModel = settings.defaultModel {
            desktopDefaultModel = defaultModel
            logger.info("Desktop default model: \(defaultModel)")
        }

        // Persist the meta-agent alpha gate from desktop and notify gated UI.
        let metaAgentEnabled = settings.metaAgentEnabled ?? false
        FeaturePreferences.setMetaAgentEnabled(metaAgentEnabled)
        NotificationCenter.default.post(name: .init("MetaAgentEnabledSynced"), object: nil)
        logger.info("Meta Agent alpha gate from desktop: \(metaAgentEnabled)")

        onSettingsSynced?(settings)
    }

    // MARK: - Error Handling

    private func handleServerError(_ data: Data) {
        guard let error = try? decoder.decode(ServerError.self, from: data) else { return }
        logger.error("Server error [\(error.code)]: \(error.message)")
    }

    // MARK: - Session Client Setup

    private func setupSessionClient() {
        sessionClient.onConnectionStateChanged = { [weak self] connected in
            Task { @MainActor in
                guard let self = self else { return }
                self.logger.info("sessionClient connection state: \(connected) (activeSessionId=\(self.activeSessionId ?? "nil"))")
                if connected {
                    self.requestSessionSync()
                }
            }
        }

        sessionClient.onMessage = { [weak self] data in
            Task { @MainActor in
                self?.handleSessionMessage(data)
            }
        }
    }

    private func requestSessionSync(attempt: Int = 0) {
        guard let sessionId = activeSessionId else {
            logger.warning("requestSessionSync skipped: activeSessionId is nil (connection state fired without a target)")
            return
        }

        let localMessages = (try? database.messages(forSession: sessionId)) ?? []
        let localCount = localMessages.count
        let maxLocalSequence = localMessages.map(\.sequence).max() ?? 0
        let expectedCount = (try? database.session(byId: sessionId))?.lastSyncedSeq ?? 0
        let hasSparseLocalHistory = maxLocalSequence > localCount
        let isBelowExpectedCount = expectedCount > 0 && localCount < expectedCount

        // If the local cache has a high-sequence mobile message but is missing
        // earlier rows, a delta cursor would permanently skip the old transcript.
        let forceFullSync = hasSparseLocalHistory || isBelowExpectedCount

        let sinceSeq: Int?
        if forceFullSync {
            sinceSeq = nil
            logger.info("Session sync requesting full history for \(sessionId): localCount=\(localCount), maxLocalSequence=\(maxLocalSequence), expectedCount=\(expectedCount)")
        } else if let state = try? database.syncState(forRoom: sessionId) {
            sinceSeq = state.lastSequence > 0 ? state.lastSequence : nil
        } else {
            sinceSeq = nil
        }

        let request = SessionSyncRequest(sinceSeq: sinceSeq)
        guard let data = try? JSONEncoder().encode(request),
              let json = String(data: data, encoding: .utf8) else {
            logger.error("requestSessionSync failed to encode request for session \(sessionId)")
            return
        }

        // Always log the send attempt -- the stuck-at-"deferred initial load"
        // bug manifests when this line appears but no syncResponse ever returns,
        // so its presence/absence is a critical diagnostic signal.
        logger.info("requestSessionSync: sending sinceSeq=\(sinceSeq ?? -1) for session \(sessionId) (attempt \(attempt))")

        // Use completion-based send to detect failures and retry.
        // The WebSocket connection may not be fully established yet when this
        // is called (onConnectionStateChanged fires before the handshake completes).
        // Without a successful syncRequest, the server won't mark this connection
        // as synced and won't include it in message broadcasts.
        sessionClient.sendRaw(json) { [weak self] error in
            guard let self = self else { return }
            if let error = error {
                self.logger.warning("requestSessionSync send failed for \(sessionId): \(error.localizedDescription)")
                guard attempt < 3, self.activeSessionId == sessionId else { return }

                self.logger.info("Session sync request failed, retrying (attempt \(attempt + 1))")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    guard let self = self, self.activeSessionId == sessionId else { return }
                    self.requestSessionSync(attempt: attempt + 1)
                }
            } else {
                self.logger.debug("requestSessionSync: send acknowledged for \(sessionId)")
            }
        }
    }

    private func handleSessionMessage(_ data: Data) {
        guard let envelope = try? decoder.decode(ServerMessage.self, from: data) else {
            let rawPreview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
            logger.warning("Could not decode session message type — raw: \(rawPreview)")
            return
        }

        switch envelope.type {
        case "syncResponse":
            handleSessionSyncResponse(data)
        case "messageBroadcast":
            handleMessageBroadcast(data)
        case "metadataBroadcast":
            handleMetadataBroadcast(data)
        case "error":
            handleServerError(data)
        default:
            logger.info("Unhandled session message type: \(envelope.type)")
        }
    }

    // MARK: - Session Sync Response

    private func handleSessionSyncResponse(_ data: Data) {
        let response: SessionSyncResponse
        do {
            response = try decoder.decode(SessionSyncResponse.self, from: data)
            logger.info("handleSessionSyncResponse: \(response.messages.count) messages, hasMore=\(response.hasMore) for session \(self.activeSessionId ?? "nil")")
        } catch {
            let rawPreview = String(data: data.prefix(500), encoding: .utf8) ?? "<binary>"
            logger.error("Failed to decode session syncResponse: \(error.localizedDescription) — raw: \(rawPreview)")
            if let sessionId = activeSessionId {
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: 0, decryptedCount: 0, storedCount: 0,
                    failedMessageIds: [], failedSequences: [],
                    error: "Sync response decode failed: \(error.localizedDescription)"
                ))
            }
            return
        }

        // Buffer messages for batch insert
        sessionSyncBuffer.append(contentsOf: response.messages)

        if response.hasMore, let cursor = response.cursor {
            // Request next page
            let sinceSeq = Int(cursor)
            let request = SessionSyncRequest(sinceSeq: sinceSeq)
            if let data = try? JSONEncoder().encode(request),
               let json = String(data: data, encoding: .utf8) {
                sessionClient.sendRaw(json)
            }
        } else {
            // All pages received - decrypt and store
            commitSessionMessages()
        }
    }

    private func commitSessionMessages() {
        guard let sessionId = activeSessionId else { return }

        let totalCount = sessionSyncBuffer.count
        var failedIds: [String] = []
        var failedSeqs: [Int] = []

        let messages = sessionSyncBuffer.compactMap { entry -> Message? in
            let msg = decryptServerMessage(entry, sessionId: sessionId)
            if msg == nil {
                failedIds.append(entry.id)
                failedSeqs.append(entry.sequence)
            }
            return msg
        }

        sessionSyncBuffer = []

        // Log decryption results
        if !failedIds.isEmpty {
            logger.error("Decryption failed for \(failedIds.count)/\(totalCount) messages in session \(sessionId). Failed sequences: \(failedSeqs.prefix(10))")
        }

        do {
            try database.appendMessages(messages)

            // Update sync watermark to max sequence
            if let maxSeq = messages.map(\.sequence).max() {
                let now = Int(Date().timeIntervalSince1970 * 1000)
                let syncState = SyncState(
                    roomId: sessionId,
                    lastCursor: nil,
                    lastSequence: maxSeq,
                    lastSyncedAt: now
                )
                try database.updateSyncState(syncState)
            }

            logger.info("Stored \(messages.count)/\(totalCount) messages for session \(sessionId)")

            // Report diagnostics
            if messages.isEmpty && totalCount > 0 {
                logger.error("All \(totalCount) messages failed decryption for session \(sessionId)")
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: totalCount, decryptedCount: 0, storedCount: 0,
                    failedMessageIds: failedIds, failedSequences: failedSeqs,
                    error: "All \(totalCount) messages failed decryption"
                ))
            } else if messages.isEmpty && totalCount == 0 {
                logger.info("Session sync returned 0 messages for session \(sessionId) — transcript may not exist on server")
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: 0, decryptedCount: 0, storedCount: 0,
                    failedMessageIds: [], failedSequences: [],
                    error: nil
                ))
            } else if !failedIds.isEmpty {
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: totalCount, decryptedCount: messages.count,
                    storedCount: messages.count,
                    failedMessageIds: failedIds, failedSequences: failedSeqs,
                    error: "\(failedIds.count) of \(totalCount) messages failed decryption"
                ))
            } else {
                emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                    totalServerMessages: totalCount, decryptedCount: messages.count,
                    storedCount: messages.count,
                    failedMessageIds: [], failedSequences: [],
                    error: nil
                ))
            }
        } catch {
            logger.error("Failed to store session messages: \(error.localizedDescription)")
            emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                totalServerMessages: totalCount, decryptedCount: messages.count, storedCount: 0,
                failedMessageIds: failedIds, failedSequences: failedSeqs,
                error: "Database write failed: \(error.localizedDescription)"
            ))
        }
    }

    // MARK: - Real-time Session Messages

    private func handleMessageBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(MessageBroadcast.self, from: data),
              let sessionId = activeSessionId else {
            let rawPreview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
            logger.error("Failed to decode messageBroadcast — raw: \(rawPreview)")
            return
        }

        guard let message = decryptServerMessage(broadcast.message, sessionId: sessionId) else {
            // decryptServerMessage already logs the specific error
            return
        }

        do {
            try database.appendMessage(message)

            // Update sync watermark
            let now = Int(Date().timeIntervalSince1970 * 1000)
            let syncState = SyncState(
                roomId: sessionId,
                lastCursor: nil,
                lastSequence: message.sequence,
                lastSyncedAt: now
            )
            try database.updateSyncState(syncState)
        } catch {
            logger.error("Failed to store broadcast message: \(error.localizedDescription)")
        }
    }

    private func handleMetadataBroadcast(_ data: Data) {
        guard let broadcast = try? decoder.decode(MetadataBroadcast.self, from: data),
              let sessionId = activeSessionId else {
            return
        }

        // Update session metadata in the database
        do {
            if var session = try database.session(byId: sessionId) {
                let wasExecuting = session.isExecuting

                if let isExecuting = broadcast.metadata.isExecuting {
                    session.isExecuting = isExecuting
                }
                if let provider = broadcast.metadata.provider {
                    session.provider = provider
                }
                if let model = broadcast.metadata.model {
                    session.model = model
                }
                if let mode = broadcast.metadata.mode {
                    session.mode = mode
                }
                // Decrypt client metadata (context usage, pending prompt state, etc.)
                if let encryptedMeta = broadcast.metadata.encryptedClientMetadata,
                   let metaIv = broadcast.metadata.clientMetadataIv,
                   let metaJson = crypto.decryptOrNil(encryptedBase64: encryptedMeta, ivBase64: metaIv),
                   let metaData = metaJson.data(using: .utf8),
                   let clientMeta = try? JSONDecoder().decode(ClientMetadata.self, from: metaData) {
                    if let ctx = clientMeta.currentContext {
                        session.contextTokens = ctx.tokens
                        session.contextWindow = ctx.contextWindow
                    }
                    if let pending = clientMeta.hasPendingPrompt {
                        session.hasQueuedPrompts = pending
                    }
                    if let phase = clientMeta.phase {
                        session.phase = phase
                    }
                    if let tags = clientMeta.tags, !tags.isEmpty,
                       let tagData = try? JSONEncoder().encode(tags) {
                        session.tagsJson = String(data: tagData, encoding: .utf8)
                    }
                }
                // NOTE: Do NOT apply updatedAt from metadata broadcasts.
                // Metadata updates (read state, isExecuting, context) should not
                // change the sort timestamp. Only index sync and message appends
                // set updatedAt, ensuring the session list stays correctly sorted.
                try database.upsertSession(session)

                // Gate the session-client ping heartbeat on whether the AI is
                // currently producing output. Pings only matter while we're
                // expecting `messageBroadcast` events; running a 20s repeating
                // timer on an idle session kept the device awake on real
                // hardware. The transitions are:
                //   !executing -> executing : startPings (turn just began)
                //   executing -> !executing : stopPings  (turn just ended)
                if !wasExecuting && session.isExecuting {
                    sessionClient.startPings()
                } else if wasExecuting && !session.isExecuting {
                    sessionClient.stopPings()
                }

                // Detect execution completion (isExecuting: true -> false)
                if wasExecuting && !session.isExecuting {
                    let messages = try database.messages(forSession: sessionId)
                    let lastAssistant = messages.last { $0.source == "assistant" }
                    let summary = String((lastAssistant?.contentDecrypted ?? "Task completed").prefix(200))
                    onSessionCompleted?(sessionId, summary)
                }
            }
        } catch {
            logger.error("Failed to update session metadata: \(error.localizedDescription)")
        }
    }

    // MARK: - Message Decryption

    private func decryptServerMessage(_ entry: ServerMessageEntry, sessionId: String) -> Message? {
        let decrypted: String?
        do {
            decrypted = try crypto.decrypt(encryptedBase64: entry.encryptedContent, ivBase64: entry.iv)
        } catch {
            logger.error("Failed to decrypt message \(entry.id) seq=\(entry.sequence) in session \(sessionId): \(error.localizedDescription). encryptedContent length=\(entry.encryptedContent.count), iv length=\(entry.iv.count)")
            return nil
        }

        return Message(
            id: entry.id,
            sessionId: sessionId,
            sequence: entry.sequence,
            source: entry.source,
            direction: entry.direction,
            encryptedContent: entry.encryptedContent,
            iv: entry.iv,
            contentDecrypted: decrypted,
            metadataJson: nil,
            createdAt: entry.createdAt
        )
    }

    // MARK: - Draft Input Sync

    /// Update draft input for a session, persisting locally and pushing to sync.
    public func updateDraftInput(sessionId: String, draftInput: String) {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        logger.info("[Draft] updateDraftInput called: sessionId=\(sessionId), draftInput='\(draftInput.prefix(30))', draftUpdatedAt=\(now)")
        // Persist locally (including timestamp so GRDB observation carries it)
        try? database.updateSessionDraftInput(sessionId: sessionId, draftInput: draftInput.isEmpty ? nil : draftInput, draftUpdatedAt: now)

        // Push to sync via index update with encrypted client metadata
        guard let session = try? database.session(byId: sessionId) else {
            logger.warning("[Draft] Session not found in database: \(sessionId)")
            return
        }

        do {
            let clientMeta = ClientMetadata(
                currentContext: nil,
                hasPendingPrompt: nil,
                phase: session.phase,
                tags: session.tags.isEmpty ? nil : session.tags,
                draftInput: draftInput,  // Send "" explicitly when clearing so remote caches update
                draftUpdatedAt: now
            )
            let metaJson = try JSONEncoder().encode(clientMeta)
            guard let metaString = String(data: metaJson, encoding: .utf8) else { return }
            let encrypted = try crypto.encrypt(plaintext: metaString)

            let encryptedProjectId = try crypto.encryptProjectId(session.projectId)
            var indexEntry = IndexUpdateEntry(
                sessionId: sessionId,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedTitle: session.titleEncrypted,
                titleIv: session.titleIv,
                provider: session.provider ?? "claude-code",
                model: session.model,
                mode: session.mode,
                messageCount: (try? database.messages(forSession: sessionId).count) ?? 0,
                lastMessageAt: session.lastMessageAt ?? session.updatedAt,
                createdAt: session.createdAt,
                updatedAt: Int(Date().timeIntervalSince1970 * 1000),
                isExecuting: session.isExecuting,
                queuedPromptCount: nil,
                encryptedQueuedPrompts: nil
            )
            indexEntry.encryptedClientMetadata = encrypted.encrypted
            indexEntry.clientMetadataIv = encrypted.iv

            let indexMessage = IndexUpdateMessage(session: indexEntry)
            if let data = try? JSONEncoder().encode(indexMessage),
               let json = String(data: data, encoding: .utf8) {
                logger.info("[Draft] Sending indexUpdate via WebSocket, json length=\(json.count), hasClientMeta=\(indexEntry.encryptedClientMetadata != nil)")
                indexClient.sendRaw(json)
            } else {
                logger.error("[Draft] Failed to encode IndexUpdateMessage to JSON")
            }
        } catch {
            logger.error("[Draft] Failed to push draft input to sync: \(error.localizedDescription)")
        }
    }

    // MARK: - Send Prompt

    /// Send a prompt to the current session via the queued prompts system.
    /// Desktop picks up prompts from index_update broadcasts (not session room messages).
    public func sendPrompt(sessionId: String, text: String, attachments: [PendingAttachment] = []) async throws {
        logger.info("[SendPrompt] Starting: sessionId=\(sessionId), textLength=\(text.count), attachments=\(attachments.count), wsConnected=\(self.indexClient.isConnected), roomOrgId=\(self.orgId ?? "nil")")
        guard indexClient.isConnected else {
            logger.error("[SendPrompt] WebSocket not connected - cannot send prompt")
            throw SyncError.webSocketSendFailed("Not connected to sync server")
        }
        guard let session = try database.session(byId: sessionId) else {
            logger.error("[SendPrompt] Session not found: \(sessionId)")
            throw SyncError.sessionNotFound
        }

        let now = Int(Date().timeIntervalSince1970 * 1000)
        let promptId = UUID().uuidString

        // Encrypt the prompt text
        let encryptedPrompt = try crypto.encrypt(plaintext: text)

        // Encrypt image attachments
        var encryptedAttachments: [WireEncryptedAttachment]? = nil
        #if canImport(UIKit)
        if !attachments.isEmpty {
            encryptedAttachments = try attachments.compactMap { attachment in
                guard let compressed = ImageCompressor.compress(attachment.image) else { return nil }
                let encrypted = try crypto.encryptData(compressed.data)
                return WireEncryptedAttachment(
                    id: attachment.id,
                    filename: attachment.filename,
                    mimeType: "image/jpeg",
                    encryptedData: encrypted.encrypted,
                    iv: encrypted.iv,
                    size: compressed.data.count,
                    width: compressed.width,
                    height: compressed.height
                )
            }
        }
        #endif

        var queuedPrompt = EncryptedQueuedPrompt(
            id: promptId,
            encryptedPrompt: encryptedPrompt.encrypted,
            iv: encryptedPrompt.iv,
            timestamp: now,
            source: "keyboard"
        )
        queuedPrompt.encryptedAttachments = encryptedAttachments

        // Build the encrypted project ID for the index entry
        let encryptedProjectId = try crypto.encryptProjectId(session.projectId)

        // Send index_update with queued prompt via the index room
        let indexEntry = IndexUpdateEntry(
            sessionId: sessionId,
            encryptedProjectId: encryptedProjectId,
            projectIdIv: CryptoManager.projectIdIvBase64,
            encryptedTitle: session.titleEncrypted,
            titleIv: session.titleIv,
            provider: session.provider ?? "claude-code",
            model: session.model,
            mode: session.mode,
            messageCount: (try? database.messages(forSession: sessionId).count) ?? 0,
            lastMessageAt: now,
            createdAt: session.createdAt,
            updatedAt: now,
            isExecuting: session.isExecuting,
            queuedPromptCount: 1,
            encryptedQueuedPrompts: [queuedPrompt]
        )

        let indexMessage = IndexUpdateMessage(session: indexEntry)
        let data = try JSONEncoder().encode(indexMessage)
        guard let json = String(data: data, encoding: .utf8) else {
            throw SyncError.encodingFailed
        }

        // Send via WebSocket with completion handler to detect failures
        let sendResult = await withCheckedContinuation { continuation in
            indexClient.sendRaw(json) { error in
                continuation.resume(returning: error)
            }
        }
        if let sendError = sendResult {
            throw SyncError.webSocketSendFailed(sendError.localizedDescription)
        }

        // Store the prompt locally for immediate display in transcript
        let localSeq = try database.nextSequence(forSession: sessionId)
        let localMessage = Message(
            id: promptId,
            sessionId: sessionId,
            sequence: localSeq,
            source: "user",
            direction: "input",
            encryptedContent: encryptedPrompt.encrypted,
            iv: encryptedPrompt.iv,
            contentDecrypted: text,
            createdAt: now
        )
        try database.appendMessage(localMessage)
    }

    // MARK: - Interactive Prompt Responses

    /// Send a session_control message to the desktop via the index room.
    /// Used for interactive prompt responses (AskUserQuestion, ToolPermission, ExitPlanMode, GitCommit).
    /// Routes to the desktop that owns the session. Without a target the server
    /// broadcasts and every connected desktop acts on the control -- two
    /// desktops both cancelling, or both answering the same prompt.
    public func sendSessionControlMessage(sessionId: String, messageType: String, payload: [String: Any]? = nil) {
        var hostDeviceId: String?
        if let session = try? database.session(byId: sessionId) {
            hostDeviceId = session.hostDeviceId
        }
        let controlPayload = SessionControlPayload(
            sessionId: sessionId,
            messageType: messageType,
            payload: payload.map { dict in
                dict.mapValues { AnyCodable($0) }
            },
            timestamp: Int(Date().timeIntervalSince1970 * 1000),
            sentBy: "mobile",
            sentByDeviceId: WebSocketClient.deviceId,
            targetDeviceId: hostDeviceId
        )

        let message = SessionControlMessage(message: controlPayload)
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Sent session_control: \(messageType) for session \(sessionId)")
        }
    }

    /// Append a tool result to the session room for transcript storage.
    /// Some interactive responses (AskUserQuestion, ToolPermission) persist the response
    /// as a system message so it appears in the transcript.
    public func appendToolResult(sessionId: String, toolResultId: String, content: String) {
        guard let encryptedContent = try? crypto.encrypt(plaintext: content) else {
            logger.error("Failed to encrypt tool result content")
            return
        }

        let entry = ServerMessageEntry(
            id: toolResultId,
            sequence: 0, // Server assigns the real sequence
            createdAt: Int(Date().timeIntervalSince1970 * 1000),
            source: "system",
            direction: "input",
            encryptedContent: encryptedContent.encrypted,
            iv: encryptedContent.iv,
            metadata: nil
        )

        let request = AppendMessageRequest(message: entry)
        if let data = try? JSONEncoder().encode(request),
           let json = String(data: data, encoding: .utf8) {
            sessionClient.sendRaw(json)
            logger.info("Appended tool result \(toolResultId) to session room")
        }
    }

    enum SyncError: LocalizedError {
        case sessionNotFound
        case encodingFailed
        case webSocketSendFailed(String)

        var errorDescription: String? {
            switch self {
            case .sessionNotFound:
                return "Session not found"
            case .encodingFailed:
                return "Failed to encode message"
            case .webSocketSendFailed(let detail):
                return "Failed to send: \(detail)"
            }
        }
    }

    /// Diagnostic information from a session message sync operation.
    public struct SessionSyncDiagnostic {
        public let totalServerMessages: Int
        public let decryptedCount: Int
        public let storedCount: Int
        public let failedMessageIds: [String]
        public let failedSequences: [Int]
        public let error: String?
    }

    // MARK: - Session Actions

    // MARK: - Push Token Registration

    private func setupPushTokenForwarding() {
        NotificationManager.shared.onTokenReceived = { [weak self] token in
            Task { @MainActor in
                self?.registerPushToken(token)
            }
        }
        NotificationManager.shared.onPushDisabled = { [weak self] in
            Task { @MainActor in
                self?.unregisterPushToken()
            }
        }
        // If a token was already received before SyncManager was created, use it now.
        // This handles the case where NotificationManager.shared was accessed early
        // (e.g., from SettingsView) and got a token before the callback was set.
        if let existingToken = NotificationManager.shared.deviceToken {
            if NotificationManager.shared.shouldRegisterForPush {
                registerPushToken(existingToken)
            } else {
                unregisterPushToken()
            }
        }
    }

    /// Send the APNs push token to the sync server.
    public func registerPushToken(_ token: String) {
        guard NotificationManager.shared.shouldRegisterForPush else {
            logger.info("Skipping push token registration because push notifications are disabled in app or OS")
            return
        }

        let message = NotificationManager.makeRegisterTokenMessage(
            token: token,
            deviceId: WebSocketClient.deviceId
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Registered push token with server")
        }
    }

    public func unregisterPushToken() {
        let message = NotificationManager.makeUnregisterTokenMessage(
            deviceId: WebSocketClient.deviceId
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Unregistered push token with server")
        }
    }

    // MARK: - Live Activity Token Registration

    private func setupLiveActivityForwarding() {
        FleetActivityController.shared.onTokenReceived = { [weak self] token, kind in
            Task { @MainActor in
                self?.registerLiveActivityToken(token, kind: kind)
            }
        }
        FleetActivityController.shared.onTokenInvalidated = { [weak self] kind in
            Task { @MainActor in
                self?.unregisterLiveActivityToken(kind: kind)
            }
        }
        FleetActivityController.shared.start()
    }

    /// Send an ActivityKit token to the sync server.
    ///
    /// Kept apart from the APNs device token all the way down: the server stores
    /// the two kinds under different prefixes because a token in the wrong lane
    /// fails with an error indistinguishable from a bad token.
    public func registerLiveActivityToken(_ token: String, kind: LiveActivityTokenKind) {
        guard FleetActivityController.shared.shouldRegister else { return }
        let message = RegisterLiveActivityTokenMessage(
            token: token,
            kind: kind.rawValue,
            deviceId: WebSocketClient.deviceId,
            platform: "ios",
            environment: "production"
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Registered Live Activity \(kind.rawValue) token with server")
        }
    }

    public func unregisterLiveActivityToken(kind: LiveActivityTokenKind?) {
        let message = UnregisterLiveActivityTokenMessage(
            deviceId: WebSocketClient.deviceId,
            kind: kind?.rawValue
        )
        if let data = try? JSONEncoder().encode(message),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
            logger.info("Unregistered Live Activity token(s) with server")
        }
    }

    /// Mark a session as read locally and push lastReadAt through the sync server.
    public func markSessionRead(sessionId: String) {
        let now = Int(Date().timeIntervalSince1970 * 1000)

        // Update local SQLite
        do {
            try database.markSessionRead(sessionId)
        } catch {
            logger.error("Failed to mark session read locally: \(error.localizedDescription)")
        }

        // Push lastReadAt through index update to server
        guard let session = try? database.session(byId: sessionId) else { return }
        do {
            let encryptedProjectId = try crypto.encryptProjectId(session.projectId)

            // Build a minimal index update with lastReadAt
            var entry: [String: Any] = [
                "sessionId": session.id,
                "encryptedProjectId": encryptedProjectId,
                "projectIdIv": CryptoManager.projectIdIvBase64,
                "provider": session.provider ?? "unknown",
                "messageCount": 0,
                "lastMessageAt": session.lastMessageAt ?? session.updatedAt,
                "createdAt": session.createdAt,
                "updatedAt": session.updatedAt,
                "isExecuting": session.isExecuting,
                "lastReadAt": now,
            ]

            // Encrypt title if available
            if let title = session.titleDecrypted {
                let result = try crypto.encrypt(plaintext: title)
                entry["encryptedTitle"] = result.encrypted
                entry["titleIv"] = result.iv
            }

            let message: [String: Any] = [
                "type": "indexUpdate",
                "session": entry,
            ]

            if let data = try? JSONSerialization.data(withJSONObject: message),
               let json = String(data: data, encoding: .utf8) {
                indexClient.sendRaw(json)
            }
        } catch {
            logger.error("Failed to push lastReadAt to server: \(error.localizedDescription)")
        }
    }

    /// Request the desktop to create a new session in a project.
    /// Returns the generated `requestId` so the caller can correlate the
    /// asynchronous `createSessionResponseBroadcast` back to this request (e.g.
    /// to navigate only the device that asked for the new session).
    @discardableResult
    public func createSession(
        projectId: String,
        initialPrompt: String? = nil,
        sessionType: String? = nil,
        parentSessionId: String? = nil,
        provider: String? = nil,
        model: String? = nil,
        agentRole: String? = nil,
        targetDeviceId: String? = nil,
        initialDraft: String? = nil
    ) throws -> String {
        let encryptedProjectId = try crypto.encryptProjectId(projectId)

        var encryptedPrompt: String?
        var promptIv: String?
        if let prompt = initialPrompt {
            let result = try crypto.encrypt(plaintext: prompt)
            encryptedPrompt = result.encrypted
            promptIv = result.iv
        }

        let requestId = UUID().uuidString
        if let initialDraft { pendingCreationDrafts[requestId] = initialDraft }
        let request = CreateSessionRequestMessage(
            request: EncryptedCreateSessionRequest(
                requestId: requestId,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                encryptedInitialPrompt: encryptedPrompt,
                initialPromptIv: promptIv,
                sessionType: sessionType,
                parentSessionId: parentSessionId,
                provider: provider,
                model: model,
                agentRole: agentRole,
                timestamp: Int(Date().timeIntervalSince1970 * 1000),
                targetDeviceId: targetDeviceId
            )
        )

        if let data = try? JSONEncoder().encode(request),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
        }
        return requestId
    }

    /// Request the desktop to create a new git worktree.
    /// The desktop will create the worktree and the result will arrive via index broadcast.
    public func createWorktree(projectId: String) throws {
        let encryptedProjectId = try crypto.encryptProjectId(projectId)

        let request = CreateWorktreeRequestMessage(
            request: CreateWorktreeRequest(
                requestId: UUID().uuidString,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                timestamp: Int(Date().timeIntervalSince1970 * 1000)
            )
        )

        if let data = try? JSONEncoder().encode(request),
           let json = String(data: data, encoding: .utf8) {
            indexClient.sendRaw(json)
        }
    }

    /// Update a session's parent (for reparenting into a workstream).
    /// Updates the local database immediately for instant UI feedback.
    /// The change will propagate to desktop on the next index sync cycle.
    public func updateSessionParent(sessionId: String, parentSessionId: String) throws {
        try database.writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET parentSessionId = ? WHERE id = ?",
                arguments: [parentSessionId, sessionId]
            )
        }
    }

    /// Archive or unarchive a session.
    /// Updates the local database and sends a control message so the desktop
    /// can propagate the change to the sync server.
    public func setSessionArchived(sessionId: String, isArchived: Bool) throws {
        try database.writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET isArchived = ? WHERE id = ?",
                arguments: [isArchived, sessionId]
            )
        }

        sendSessionControlMessage(
            sessionId: sessionId,
            messageType: "archive",
            payload: ["isArchived": isArchived]
        )
    }
}
