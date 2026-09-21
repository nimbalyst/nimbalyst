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
    let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")

    private let crypto: CryptoManager
    private let database: DatabaseManager
    private let indexClient: WebSocketClient = {
        let client = WebSocketClient()
        client.sendsDeviceAnnounce = true
        return client
    }()
    private let sessionClient = WebSocketClient()
    let decoder = JSONDecoder()
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

    /// Called once a locally requested session is available in the database.
    /// Parameters: (requestId, sessionId). Other devices' responses are ignored.
    public var onSessionCreated: ((String, String) -> Void)?
    public lazy var sessionCreation: SessionCreationRequests = {
        let requests = SessionCreationRequests()
        requests.onFailure = { [weak self] requestId, message in
            self?.pendingCreationDrafts.removeValue(forKey: requestId)
            self?.sessionCreations.receive(CreateSessionResponse(requestId: requestId,
                success: false, sessionId: nil, error: message))
        }
        return requests
    }()
    lazy var sessionCreations = SessionCreationTracker(
        database: database,
        lookup: { [weak self] in self?.requestSessionIndexLookup(sessionId: $0) },
        onReady: { [weak self] requestId, sessionId in
            // #NIM-5925: the tracker fires on the committed GRDB row, which is
            // the only moment that is guaranteed to exist. Waiting for the next
            // bulk ingestion outcome dropped the draft whenever the row arrived
            // on a lookup page instead.
            self?.applyPendingCreationDrafts()
            self?.onSessionCreated?(requestId, sessionId)
        }
    )
    private var pendingCreationDrafts: [String: String] = [:]
    private var pendingSessionDrafts: [String: String] = [:]

    /// The last sync failure worth showing the user, or nil once it clears.
    /// Fed by the request registry and by the decrypt/storage paths that used to
    /// log and return. Rendering lives outside the sync layer.
    @Published public private(set) var syncError: SyncError?

    /// Collapses a burst of same-kind failures into one banner. See
    /// SyncErrorCoalescer -- alternating draft and read-receipt failures against
    /// one dead socket are a single interruption.
    private var errorCoalescer = SyncErrorCoalescer()

    /// The only way `syncError` is set. Every failure path goes through here so
    /// the coalescing rule cannot be bypassed by a new call site.
    private func report(_ error: SyncError) {
        guard let published = errorCoalescer.accept(error) else { return }
        syncError = published
    }

    public func clearSyncError() {
        syncError = nil
        errorCoalescer.clear()
    }

    /// Every outbound message that is not fire-and-forget. See SyncRequestRegistry.
    private(set) lazy var requests: SyncRequestRegistry = {
        let registry = SyncRequestRegistry(timeout: requestTimeout) { [weak self] channel, json, completion in
            guard let self else {
                completion(NSError(domain: "SyncManager", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "Sync stopped"]))
                return
            }
            if let sender = self.sender {
                sender(channel, json, completion)
                return
            }
            switch channel {
            case .index: self.indexClient.sendRaw(json, completion: completion)
            case .session: self.sessionClient.sendRaw(json, completion: completion)
            }
        }
        registry.onOutcome = { [weak self] outcome in
            guard let self, let error = outcome.error else { return }
            if outcome.kind == .voiceTool {
                // The caller is suspended on a continuation, not watching a
                // banner; resuming it is the whole report.
                self.voiceTools.fail(outcome.requestId, message: error.message)
                return
            }
            guard outcome.kind.isUserVisible else { return }
            self.report(error)
        }
        return registry
    }()

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

    /// The room the session socket is joined to, readable from the socket's own
    /// queue. #NIM-5924: session-room traffic carries no session id, so it used
    /// to be attributed to `activeSessionId` -- read on the main actor one hop
    /// later, by which time navigation may have moved on. Capturing the room at
    /// arrival is the closest thing to keying on the broadcast's own session
    /// that the wire currently allows.
    private let sessionRoom = SessionRoomBox()

    /// Last applied metadata timestamp per session, so a late or replayed
    /// metadata broadcast cannot re-run the executing -> idle transition.
    private var lastMetadataUpdatedAt: [String: Int] = [:]

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

    /// Replaces both sockets for tests. Production leaves this nil.
    private let sender: SyncRequestRegistry.Sender?
    /// Last settings broadcast accepted per desktop. See SettingsSyncApplier.
    private let settingsVersions: AppliedSettingsVersionStore

    /// Whether this manager may touch UNUserNotificationCenter and ActivityKit.
    ///
    /// Both trap with `bundleProxyForCurrentProcess is nil` outside an app
    /// bundle, which is every `swift test` run on macOS. The flag used to gate
    /// only the init-time callback wiring, so a test that merely called
    /// `connect` still crashed on the first `NotificationManager.shared` touch
    /// in the connection-state handler.
    let registersDeviceTokens: Bool
    private let requestTimeout: Duration

    /// Allows index import tests to run without an application notification center.
    init(
        crypto: CryptoManager,
        database: DatabaseManager,
        serverUrl: String,
        userId: String,
        registerDeviceCallbacks: Bool,
        requestTimeout: Duration = .seconds(30),
        sender: SyncRequestRegistry.Sender? = nil,
        settingsVersions: AppliedSettingsVersionStore = AppliedSettingsVersionStore()
    ) {
        self.crypto = crypto
        self.database = database
        self.serverUrl = serverUrl
        self.userId = userId
        self.sender = sender
        self.requestTimeout = requestTimeout
        self.settingsVersions = settingsVersions
        self.registersDeviceTokens = registerDeviceCallbacks

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
                // Not user-visible: the replication client re-drives its own
                // cursor from `start()` on the next connect, so a failed page
                // request is recorded and retried by its owner, not by a banner.
                self?.requests.send(kind: .indexRequest, channel: .index, json: json)
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
        replication?.onRequestTimeout = { [weak self] in
            guard let self else { return }
            if let recover = self.onReconnectNeeded { recover() }
            else { self.indexClient.reconnect() }
        }
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

    /// AppState coordinates credentials before recovery. Direct callers retain
    /// foreground recovery for standalone sync clients and transport tests.
    public func setAppInForeground(_ inForeground: Bool, recover: Bool = true) {
        indexClient.setAppInForeground(inForeground)
        sessionClient.setAppInForeground(inForeground)
        replication?.setForeground(inForeground)
        if inForeground && registersDeviceTokens { FleetActivityController.shared.resendTokens() }
        if inForeground && recover {
            indexClient.reconnect()
            if activeSessionId != nil { sessionClient.reconnect() }
        }
    }

    /// The app owns index retries so credentials are refreshed before connecting.
    public var onReconnectNeeded: (@MainActor () -> Void)? {
        didSet { indexClient.onReconnectNeeded = onReconnectNeeded }
    }

    func waitForConnection() async -> Bool { await indexClient.waitForReady() }

    /// Retire transport before awaiting auth, so creation cannot use a stale
    /// connected flag. Keep the selected session, cache and navigation intents.
    func prepareForRecovery() {
        indexClient.disconnect()
        sessionClient.disconnect()
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
        sessionCreation.disconnect()
        // A deliberate disconnect drops the parked writes too: on reconnect the
        // account may be a different one, and replaying a draft for an identity
        // we are no longer writing for would publish it to the wrong index.
        requests.cancel()
        connectedDevices = []
        pendingCreationDrafts.removeAll()
        pendingSessionDrafts.removeAll()
        sessionCreations.cancel()
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
        sessionRoom.sessionId = sessionId
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
        if let leaving = activeSessionId { lastMetadataUpdatedAt.removeValue(forKey: leaving) }
        activeSessionId = nil
        sessionRoom.sessionId = nil
        sessionSyncBuffer = []
    }

    // MARK: - Index Client Setup

    private func setupIndexClient() {
        indexClient.onWillConnect = { [weak self] in
            guard let self else { return }
            let lookups = self.replication?.pendingNavigationIds ?? []
            self.startIndexIngestionGeneration()
            self.replication?.restoreNavigation(lookups)
        }
        indexClient.onConnectionStateChanged = { [weak self] connected in
            self?.isConnected = connected
            if !connected {
                self?.sessionCreation.disconnect()
                self?.requests.disconnect()
                self?.connectedDevices = []
            }
            if connected {
                // Re-publish the optimistic local writes whose send never
                // landed, from the rows as they read now.
                self?.requests.reconnect()
                // Versioned replication probes first; the probe's
                // unknown_message_type answer is what falls back to the
                // legacy index request (see IndexReplicationClient).
                self?.indexLoadState = .loading
                self?.replication?.start()
                // ActivityKit hands out a push-to-start token once per
                // launch, which is routinely before the socket is up. A
                // token that only existed while we were disconnected is a
                // card that never appears, with nothing to see in any log.
                self?.registerDeviceTokensOnConnect()
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
        case .undecodable(let type, let detail):
            logger.warning("Could not decode index message\(type.map { " of type \($0)" } ?? ""): \(detail, privacy: .public)")
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
            handleCreateWorktreeResponse(data)
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
        _ = sessionCreation.receive(broadcast.response)
        let draft = pendingCreationDrafts.removeValue(forKey: broadcast.response.requestId)
        if broadcast.response.success {
            let sessionId = broadcast.response.sessionId ?? "unknown"
            logger.info("Session created: \(sessionId)")
            if let sessionId = broadcast.response.sessionId {
                if let draft {
                    pendingSessionDrafts[sessionId] = draft
                    applyPendingCreationDrafts()
                }
            }
        } else {
            logger.error("Session creation failed: \(broadcast.response.error ?? "unknown error")")
        }
        sessionCreations.receive(broadcast.response)
    }

    /// The worktree session itself arrives via the index, but the answer is the
    /// only thing that says the desktop got as far as trying. Without it the
    /// request had no tracker and no timeout: a failure looked like a slow one.
    private func handleCreateWorktreeResponse(_ data: Data) {
        guard let broadcast = try? decoder.decode(CreateWorktreeResponseBroadcast.self, from: data) else {
            logger.error("Failed to decode createWorktreeResponseBroadcast")
            return
        }
        let response = broadcast.response
        requests.resolve(
            requestId: response.requestId,
            detail: response.success ? nil : (response.error ?? "The desktop could not create the worktree.")
        )
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
    public typealias VoiceToolCallResult = VoiceToolProxy.Result

    private lazy var voiceTools = VoiceToolProxy(crypto: crypto) { [weak self] requestId, json in
        self?.requests.request(kind: .voiceTool, requestId: requestId, channel: .index, json: json)
    }

    /// Run a desktop-hosted voice tool (e.g. project-memory lookup) by proxying
    /// it over the sync channel. Returns the tool result, or a graceful failure
    /// if the desktop is unavailable / doesn't respond in time.
    public func callVoiceTool(toolName: String, argsJson: String, projectId: String) async -> VoiceToolCallResult {
        await voiceTools.call(toolName: toolName, argsJson: argsJson, projectId: projectId)
    }

    func callLiveVoiceTool(toolName: String, argsJson: String, scope: VoiceRelayScope) async -> VoiceToolCallResult {
        guard connectedDevices.contains(where: { $0.deviceId == scope.hostDeviceId && ($0.type == "desktop" || $0.type == "headless") }) else {
            return .init(success: false, result: nil, error: "The selected computer is unavailable.")
        }
        guard let data = try? JSONEncoder().encode(VoiceRelayRequest(scope: scope, tool: toolName, arguments: argsJson)),
              let json = String(data: data, encoding: .utf8) else {
            return .init(success: false, result: nil, error: "Could not encode voice request.")
        }
        return await voiceTools.call(toolName: "nimbalyst_live_v1", argsJson: json, projectId: scope.projectId, scope: scope)
    }

    private func handleVoiceToolResponse(_ data: Data) {
        guard let requestId = voiceTools.receive(data) else { return }
        requests.resolve(requestId: requestId)
    }

    // MARK: - Settings Sync

    func handleSettingsSyncBroadcast(_ data: Data) {
        switch SettingsSyncApplier.decode(data, crypto: crypto) {
        case .failure(let failure):
            logger.error("Settings sync rejected: \(failure.label)")
            if failure == .undecryptable {
                report(SyncError(kind: .decrypt,
                    message: "Settings from your desktop could not be read with this device's key."))
            }
        case .success(let accepted):
            let payload = accepted.payload
            // #NIM-5921: the desktop's counter restarts at zero on every desktop
            // launch, so a rejoin used to replay an old payload -- including the
            // OpenAI credential -- over newer state.
            guard SettingsSyncApplier.isFresh(
                version: payload.version,
                timestamp: payload.timestamp,
                lastApplied: settingsVersions.lastApplied(deviceId: payload.deviceId)
            ) else {
                logger.info("Settings sync rejected: \(SettingsSyncApplier.Failure.stale.label) (v\(payload.version) @\(payload.timestamp))")
                return
            }
            settingsVersions.record(deviceId: payload.deviceId, version: payload.version, timestamp: payload.timestamp)
            logger.info("Applying settings v\(payload.version) from device \(payload.deviceId)")
            SettingsSyncApplier.apply(accepted.settings)
            if let models = accepted.settings.availableModels {
                availableModels = models
            }
            if let defaultModel = accepted.settings.defaultModel {
                desktopDefaultModel = defaultModel
            }
            onSettingsSynced?(accepted.settings)
        }
    }

    // MARK: - Error Handling

    private func handleServerError(_ data: Data) {
        guard let error = try? decoder.decode(ServerError.self, from: data) else { return }
        logger.error("Server error [\(error.code)]: \(error.message)")
    }

    // MARK: - Session Client Setup

    private func setupSessionClient() {
        sessionClient.onConnectionStateChanged = { [weak self] connected in
            guard let self = self else { return }
            self.logger.info("sessionClient connection state: \(connected) (activeSessionId=\(self.activeSessionId ?? "nil"))")
            if connected {
                self.requestSessionSync()
            }
        }

        sessionClient.onMessage = { [weak self] data in
            // Read the room synchronously, on the queue the frame arrived on.
            guard let sessionId = self?.sessionRoom.sessionId else { return }
            Task { @MainActor in
                self?.handleSessionMessage(data, sessionId: sessionId)
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

    func handleSessionMessage(_ data: Data, sessionId: String) {
        guard let envelope = try? decoder.decode(ServerMessage.self, from: data) else {
            let rawPreview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
            logger.warning("Could not decode session message type — raw: \(rawPreview)")
            return
        }

        switch envelope.type {
        case "syncResponse":
            handleSessionSyncResponse(data, sessionId: sessionId)
        case "messageBroadcast":
            handleMessageBroadcast(data, sessionId: sessionId)
        case "metadataBroadcast":
            handleMetadataBroadcast(data, sessionId: sessionId)
        case "error":
            handleServerError(data)
        default:
            logger.info("Unhandled session message type: \(envelope.type)")
        }
    }

    // MARK: - Session Sync Response

    private func handleSessionSyncResponse(_ data: Data, sessionId: String) {
        let response: SessionSyncResponse
        do {
            response = try decoder.decode(SessionSyncResponse.self, from: data)
            logger.info("handleSessionSyncResponse: \(response.messages.count) messages, hasMore=\(response.hasMore) for session \(self.activeSessionId ?? "nil")")
        } catch {
            let rawPreview = String(data: data.prefix(500), encoding: .utf8) ?? "<binary>"
            logger.error("Failed to decode session syncResponse: \(error.localizedDescription) — raw: \(rawPreview)")
            emitSessionSyncDiagnostic(sessionId, SessionSyncDiagnostic(
                totalServerMessages: 0, decryptedCount: 0, storedCount: 0,
                failedMessageIds: [], failedSequences: [],
                error: "Sync response decode failed: \(error.localizedDescription)"
            ))
            report(SyncError(kind: .transport, message: "Part of this transcript could not be loaded."))
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
                requests.send(kind: .sessionSyncPage, channel: .session, json: json)
            }
        } else {
            // All pages received - decrypt and store
            commitSessionMessages(sessionId: sessionId)
        }
    }

    private func commitSessionMessages(sessionId: String) {
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

    private func handleMessageBroadcast(_ data: Data, sessionId: String) {
        guard let broadcast = try? decoder.decode(MessageBroadcast.self, from: data) else {
            let rawPreview = String(data: data.prefix(200), encoding: .utf8) ?? "<binary>"
            logger.error("Failed to decode messageBroadcast — raw: \(rawPreview)")
            return
        }

        guard let message = decryptServerMessage(broadcast.message, sessionId: sessionId) else {
            // decryptServerMessage already logs the specific error
            report(SyncError(kind: .decrypt, message: "A message in this transcript could not be read with this device's key."))
            return
        }

        do {
            try database.appendMessage(message)

            // #NIM-5924: the watermark only moves forward. A broadcast that
            // arrives late, or out of order after a reconnect, used to rewind
            // it, and the next delta request then re-fetched from the lower
            // sequence -- or skipped everything above it on the next advance.
            let lastSequence = (try? database.syncState(forRoom: sessionId))?.lastSequence ?? 0
            guard message.sequence > lastSequence else { return }
            try database.updateSyncState(SyncState(
                roomId: sessionId,
                lastCursor: nil,
                lastSequence: message.sequence,
                lastSyncedAt: Int(Date().timeIntervalSince1970 * 1000)
            ))
        } catch {
            logger.error("Failed to store broadcast message: \(error.localizedDescription)")
            report(SyncError(kind: .storage, message: "Could not save an incoming message on this device."))
        }
    }

    private func handleMetadataBroadcast(_ data: Data, sessionId: String) {
        guard let broadcast = try? decoder.decode(MetadataBroadcast.self, from: data) else {
            return
        }

        // #NIM-5924: `updatedAt` is the only ordering signal this payload
        // carries. Without comparing it, a replayed executing:true followed by
        // the already-applied executing:false fired onSessionCompleted twice --
        // two completion notifications for one turn.
        if let updatedAt = broadcast.metadata.updatedAt {
            guard updatedAt > (lastMetadataUpdatedAt[sessionId] ?? Int.min) else {
                logger.info("Ignoring metadata broadcast for \(sessionId) at \(updatedAt): not newer than what is applied")
                return
            }
            lastMetadataUpdatedAt[sessionId] = updatedAt
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
            let json = try draftIndexUpdate(session: session, draft: draftInput, draftUpdatedAt: now)
            logger.info("[Draft] Sending indexUpdate via WebSocket, json length=\(json.count)")
            // The local row is already committed, so a failed send is a
            // divergence, not a lost edit: park it and re-publish whatever the
            // row says after the socket comes back.
            requests.send(
                kind: .draftPush,
                channel: .index,
                json: json,
                coalesceKey: "draft:\(sessionId)",
                rebuild: { [weak self] in self?.rebuildDraftIndexUpdate(sessionId: sessionId) }
            )
        } catch {
            logger.error("[Draft] Failed to push draft input to sync: \(error.localizedDescription)")
            report(SyncError(kind: .transport, message: SyncRequestKind.draftPush.failureDescription))
        }
    }

    private func draftIndexUpdate(session: Session, draft: String, draftUpdatedAt: Int) throws -> String {
        try SessionIndexUpdates.draft(
            session: session,
            draft: draft,
            draftUpdatedAt: draftUpdatedAt,
            messageCount: try? database.messages(forSession: session.id).count,
            crypto: crypto
        )
    }

    /// Rebuilds the draft push from the committed row, so a replay publishes
    /// what the composer holds now rather than the edit that failed to send.
    private func rebuildDraftIndexUpdate(sessionId: String) -> String? {
        guard let session = try? database.session(byId: sessionId) else { return nil }
        return try? draftIndexUpdate(
            session: session,
            draft: session.draftInput ?? "",
            draftUpdatedAt: session.draftUpdatedAt ?? Int(Date().timeIntervalSince1970 * 1000)
        )
    }

    // MARK: - Send Prompt

    /// Send a prompt to the current session via the queued prompts system.
    /// Desktop picks up prompts from index_update broadcasts (not session room messages).
    @discardableResult
    public func sendPrompt(sessionId: String, text: String, attachments: [PendingAttachment] = [], promptId: String = UUID().uuidString) async throws -> String {
        logger.info("[SendPrompt] Starting: sessionId=\(sessionId), textLength=\(text.count), attachments=\(attachments.count), wsConnected=\(self.indexClient.isConnected), roomOrgId=\(self.orgId ?? "nil")")
        guard indexClient.isConnected else {
            logger.error("[SendPrompt] WebSocket not connected - cannot send prompt")
            throw PromptSendError.webSocketSendFailed("Not connected to sync server")
        }
        guard let session = try database.session(byId: sessionId) else {
            logger.error("[SendPrompt] Session not found: \(sessionId)")
            throw PromptSendError.sessionNotFound
        }

        let now = Int(Date().timeIntervalSince1970 * 1000)
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

        // Send index_update with queued prompt via the index room
        let json = try SessionIndexUpdates.prompt(
            session: session, prompt: queuedPrompt,
            messageCount: (try? database.messages(forSession: sessionId).count) ?? 0,
            crypto: crypto
        )

        // Send via WebSocket with completion handler to detect failures
        let sendResult = await withCheckedContinuation { continuation in
            indexClient.sendRaw(json) { error in
                continuation.resume(returning: error)
            }
        }
        if let sendError = sendResult {
            throw PromptSendError.webSocketSendFailed(sendError.localizedDescription)
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
        return promptId
    }

    // MARK: - Interactive Prompt Responses

    /// Send a session_control message to the desktop via the index room.
    /// Used for interactive prompt responses (AskUserQuestion, ToolPermission, ExitPlanMode, GitCommit).
    /// Routes to the desktop that owns the session. Without a target the server
    /// broadcasts and every connected desktop acts on the control -- two
    /// desktops both cancelling, or both answering the same prompt.
    ///
    /// `republish` is opt-in and belongs only to controls that mirror a local
    /// row (archive). An interactive prompt response must never be replayed on
    /// reconnect: by then the desktop has moved on and the answer is wrong.
    public func sendSessionControlMessage(
        sessionId: String,
        messageType: String,
        payload: [String: Any]? = nil,
        republish: (@MainActor () -> String?)? = nil
    ) {
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
        guard let data = try? JSONEncoder().encode(message),
              let json = String(data: data, encoding: .utf8) else {
            logger.error("Failed to encode session_control: \(messageType) for session \(sessionId)")
            report(SyncError(kind: .transport, message: SyncRequestKind.sessionControl.failureDescription))
            return
        }
        requests.send(
            kind: .sessionControl,
            channel: .index,
            json: json,
            coalesceKey: republish == nil ? nil : "control:\(messageType):\(sessionId)",
            rebuild: republish
        )
        logger.info("Sent session_control: \(messageType) for session \(sessionId)")
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
            requests.send(kind: .toolResult, channel: .session, json: json)
            logger.info("Appended tool result \(toolResultId) to session room")
        }
    }

    /// Thrown by the send paths a caller awaits directly. Distinct from the
    /// top-level `SyncError`, which is the reportable surface for failures
    /// nobody is awaiting.
    enum PromptSendError: LocalizedError {
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

    /// Mark a session as read locally and push lastReadAt through the sync server.
    public func markSessionRead(sessionId: String) {
        let now = Int(Date().timeIntervalSince1970 * 1000)

        // Update local SQLite
        do {
            try database.markSessionRead(sessionId)
        } catch {
            logger.error("Failed to mark session read locally: \(error.localizedDescription)")
            report(SyncError(kind: .storage, message: "Could not save the read marker on this device."))
        }

        // Push lastReadAt through index update to server
        guard let session = try? database.session(byId: sessionId) else { return }
        do {
            let json = try SessionIndexUpdates.readReceipt(session: session, lastReadAt: now, crypto: crypto)
            requests.send(
                kind: .readReceipt,
                channel: .index,
                json: json,
                coalesceKey: "read:\(sessionId)",
                rebuild: { [weak self] in self?.rebuildReadReceipt(sessionId: sessionId) }
            )
        } catch {
            logger.error("Failed to push lastReadAt to server: \(error.localizedDescription)")
            report(SyncError(kind: .transport, message: SyncRequestKind.readReceipt.failureDescription))
        }
    }

    private func rebuildReadReceipt(sessionId: String) -> String? {
        guard let session = try? database.session(byId: sessionId),
              let lastReadAt = session.lastReadAt else { return nil }
        return try? SessionIndexUpdates.readReceipt(session: session, lastReadAt: lastReadAt, crypto: crypto)
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
        let requestId = try sessionCreation.create(
            SessionCreationOptions(projectId: projectId, initialPrompt: initialPrompt,
                sessionType: sessionType, parentSessionId: parentSessionId,
                provider: provider, model: model, agentRole: agentRole, targetDeviceId: targetDeviceId),
            crypto: crypto, devices: connectedDevices, isConnected: isConnected,
            onRegistered: { [self] requestId in
                sessionCreations.register(requestId)
                if let initialDraft { pendingCreationDrafts[requestId] = initialDraft }
            },
            send: { [self] json, completion in
                if let sender { sender(.index, json, completion) }
                else { indexClient.sendRaw(json, completion: completion) }
            }
        )
        return requestId
    }

    /// Request the desktop to create a new git worktree.
    /// The worktree session arrives via index broadcast; the tracked request is
    /// what makes a desktop that never answers distinguishable from a slow one.
    /// Returns the requestId so a caller can correlate the outcome.
    @discardableResult
    public func createWorktree(projectId: String) throws -> String {
        let encryptedProjectId = try crypto.encryptProjectId(projectId)

        let requestId = UUID().uuidString
        let request = CreateWorktreeRequestMessage(
            request: CreateWorktreeRequest(
                requestId: requestId,
                encryptedProjectId: encryptedProjectId,
                projectIdIv: CryptoManager.projectIdIvBase64,
                timestamp: Int(Date().timeIntervalSince1970 * 1000)
            )
        )

        guard let data = try? JSONEncoder().encode(request),
              let json = String(data: data, encoding: .utf8) else {
            throw PromptSendError.encodingFailed
        }
        requests.request(kind: .createWorktree, requestId: requestId, channel: .index, json: json)
        return requestId
    }

    /// Update a session's parent (for reparenting into a workstream).
    ///
    /// Local first for instant UI feedback, then published. #NIM-5922: this
    /// used to write locally and send nothing, so the desktop reasserted the
    /// old parent on the next index page and the move silently undid itself.
    public func updateSessionParent(sessionId: String, parentSessionId: String) throws {
        try database.writer.write { db in
            try db.execute(
                sql: "UPDATE sessions SET parentSessionId = ? WHERE id = ?",
                arguments: [parentSessionId, sessionId]
            )
        }

        guard let session = try? database.session(byId: sessionId) else { return }
        do {
            let json = try SessionIndexUpdates.parent(session: session, parentSessionId: parentSessionId, crypto: crypto)
            requests.send(
                kind: .reparent,
                channel: .index,
                json: json,
                coalesceKey: "parent:\(sessionId)",
                rebuild: { [weak self] in self?.rebuildParentIndexUpdate(sessionId: sessionId) }
            )
        } catch {
            logger.error("Failed to publish reparent for \(sessionId): \(error.localizedDescription)")
            report(SyncError(kind: .transport, message: SyncRequestKind.reparent.failureDescription))
        }
    }

    private func rebuildParentIndexUpdate(sessionId: String) -> String? {
        guard let session = try? database.session(byId: sessionId),
              let parentSessionId = session.parentSessionId else { return nil }
        return try? SessionIndexUpdates.parent(session: session, parentSessionId: parentSessionId, crypto: crypto)
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
            payload: ["isArchived": isArchived],
            // The row is already flipped locally; a replay re-asserts whatever
            // it says now rather than the value that failed to send.
            republish: { [weak self] in self?.rebuildArchiveControl(sessionId: sessionId) }
        )
    }

    private func rebuildArchiveControl(sessionId: String) -> String? {
        guard let session = try? database.session(byId: sessionId) else { return nil }
        let controlPayload = SessionControlPayload(
            sessionId: sessionId,
            messageType: "archive",
            payload: ["isArchived": AnyCodable(session.isArchived)],
            timestamp: Int(Date().timeIntervalSince1970 * 1000),
            sentBy: "mobile",
            sentByDeviceId: WebSocketClient.deviceId,
            targetDeviceId: session.hostDeviceId
        )
        guard let data = try? JSONEncoder().encode(SessionControlMessage(message: controlPayload)) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
