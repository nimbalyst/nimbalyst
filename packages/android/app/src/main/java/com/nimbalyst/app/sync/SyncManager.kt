package com.nimbalyst.app.sync

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.nimbalyst.app.attachments.PendingAttachment
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.pairing.PairingStore
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Owns the sync lifecycle: credentials, the index and session sockets, JWT
 * refresh, and the public API the UI calls. Message application lives in
 * [IndexMessageHandler] and [SessionRoomHandler], each fed by its own serial
 * [SyncIngestionQueue]; outbound index updates are built by
 * [SessionIndexUpdates]. The public API is documented for the UI in
 * nimbalyst-local/orchestration/android-sync-api.md.
 */
class SyncManager internal constructor(
    private val context: Context,
    private val repository: NimbalystRepository,
    private val credentialStore: SyncCredentialStore,
    private val notificationManager: NotificationManager,
    private val scope: CoroutineScope,
    socketFactory: WebSocketFactory,
    private val tokenRefresher: TokenRefresher,
    authClock: () -> Long = System::currentTimeMillis,
) {
    constructor(
        context: Context,
        repository: NimbalystRepository,
        pairingStore: PairingStore,
        notificationManager: NotificationManager,
        scope: CoroutineScope,
    ) : this(
        context = context,
        repository = repository,
        credentialStore = PairingStoreCredentials(pairingStore),
        notificationManager = notificationManager,
        scope = scope,
        socketFactory = WebSocketClient.defaultSocketFactory,
        tokenRefresher = HttpTokenRefresher(Gson()),
    )

    private companion object {
        const val TAG = "SyncManager"
        const val REFRESH_RETRY_WINDOW_MS = 30_000L
    }

    private val gson = Gson()

    private val indexClient = WebSocketClient(scope, socketFactory = socketFactory)
    private val sessionClient = WebSocketClient(scope, socketFactory = socketFactory)
    private val _state = MutableStateFlow(SyncConnectionState())
    private val _connectedDevices = MutableStateFlow<List<DeviceInfo>>(emptyList())

    @Volatile private var activeCredentials: PairingCredentials? = null
    @Volatile private var crypto: CryptoManager? = null
    @Volatile private var indexRoomId: String? = null

    private val decoder = SessionEntryDecoder(gson)
    private val indexUpdates = SessionIndexUpdates(gson)
    private val presence = DevicePresence(context, gson)
    private val settings = SettingsSyncApplier(context)
    private val errors = SyncErrors()
    private val auth = AuthHealthTracker(authClock)
    private val signals = ExecutionSignals()
    private val indexRequests = IndexSyncRequests(gson, indexClient::sendRaw)
    private val requests = SyncRequestRegistry(scope, { channel, json ->
        if (channel == SyncChannel.INDEX) indexClient.sendRaw(json) else sessionClient.sendRaw(json)
    }, errors)
    private val commands = SessionCommands(repository, gson, indexUpdates, { presence.deviceId }, { crypto }, requests)
    private val sessionState = SessionStatePublisher(repository, decoder, indexUpdates, { crypto }, requests, scope)
    private val prompts = PromptSender(repository, indexUpdates, { crypto }, { indexClient.isConnected }, { json ->
        requests.sendConfirmed(SyncRequestKind.PROMPT, json)
    })
    private val creations = SessionCreationTracker(
        scope = scope,
        observeSession = repository::observeSession,
        lookup = ::requestSessionIndexLookup,
        onReady = { requestId, sessionId -> creationDrafts.remove(requestId)?.let { updateDraftInput(sessionId, it) } }
    )
    private val indexHandler = IndexMessageHandler(
        repository, decoder, gson, { crypto }, _state, _connectedDevices,
        settings, indexRequests, creations, commands, signals, errors,
        onPong = requests::deliveryConfirmed
    ) { replication }
    private val _indexCoverage = MutableStateFlow(IndexCoverage())
    @Volatile private var replication: IndexReplicationClient? = null
    private val sessionHandler: SessionRoomHandler = SessionRoomHandler(
        repository, decoder, gson, { crypto }, _state, signals, scope,
        requestCatchUp = { id -> sessionIngestion.submit { sessionHandler.requestSync(id) } },
        lookup = ::requestSessionIndexLookup
    ) { sessionId, json -> sessionClient.connectedTag == sessionId && sessionClient.sendRaw(json) }
    private val interactive = InteractiveResponses(gson, ::sendSessionControlMessage, ::appendToolResult)
    private val creationDrafts = ConcurrentHashMap<String, String>()
    private val indexIngestion = SyncIngestionQueue(scope, "index", ::reportIngestionFailure)
    private val sessionIngestion = SyncIngestionQueue(scope, "session", ::reportIngestionFailure)


    // Marketing screenshot capture (debug builds only). When on, every network
    // entry point is inert and the connection state is frozen at "desktop
    // connected" so captures show a live-looking device with no server.
    private var screenshotMode = false
    private var jwtRefreshJob: Job? = null
    @Volatile private var lastJwtRefreshAttempt: Long = 0

    val state: StateFlow<SyncConnectionState> = _state.asStateFlow()
    val connectedDevices: StateFlow<List<DeviceInfo>> = _connectedDevices.asStateFlow()
    val availableModels: StateFlow<List<SyncedAvailableModel>> = settings.availableModels
    val desktopDefaultModel: StateFlow<String?> = settings.defaultModel
    val metaAgentEnabled: StateFlow<Boolean> = settings.metaAgentEnabled
    val syncError: StateFlow<SyncError?> = errors.current
    /** OK, degraded after 3 failed refreshes (banner), signed out after 5 (show login). */
    val authHealth: StateFlow<AuthHealth> = auth.health
    val executionTransitions: SharedFlow<SessionExecutionTransition> = signals.transitions
    val pendingSessionCreations: StateFlow<Set<String>> = creations.pendingIds
    val sessionCreationCompletions: SharedFlow<SessionCreationOutcome> = creations.completions
    val indexCoverage: StateFlow<IndexCoverage> = _indexCoverage.asStateFlow()

    init {
        decoder.onClientMetadataKnown = sessionState::clientMetadataKnown
        // Only the index socket announces: presence is per device, not per room.
        indexClient.deviceAnnouncement = presence::announcement
        indexClient.onConnectionStateChanged = { connected ->
            _state.update {
                it.copy(
                    indexConnected = connected,
                    isConnecting = false,
                    lastError = if (connected) null else it.lastError
                )
            }
            if (connected) {
                onIndexConnected()
            } else {
                indexRequests.reset()
                creations.failAll(
                    "Disconnected before session creation was confirmed. " +
                        "Check the session list after reconnecting before trying again."
                )
                requests.disconnect()
            }
        }
        indexClient.onTextMessage = { message, _ ->
            indexIngestion.submit { indexHandler.handle(message) }
        }
        indexClient.onFailure = { error ->
            _state.update { it.copy(isConnecting = false, lastError = error) }
        }
        indexClient.onHttpError = { code -> if (code == 401) refreshAfterUnauthorized("indexClient") }

        sessionClient.onConnectionStateChanged = { connected ->
            val sessionId = sessionClient.connectedTag
            Log.d(TAG, "[sessionClient] connection=$connected sessionId=$sessionId")
            _state.update {
                it.copy(
                    sessionConnected = connected,
                    lastError = if (connected) null else it.lastError
                )
            }
            if (connected && sessionId != null) {
                sessionIngestion.submit { sessionHandler.requestSync(sessionId) }
            }
        }
        sessionClient.onTextMessage = { message, sessionId ->
            // Captured at arrival: the socket's own session, not whichever
            // session is active when the queue gets to it.
            if (sessionId != null) {
                sessionIngestion.submit { sessionHandler.handle(message, sessionId) }
            }
        }
        sessionClient.onFailure = { error ->
            Log.e(TAG, "[sessionClient] WebSocket failure: $error")
            _state.update { it.copy(lastError = error) }
        }
        sessionClient.onHttpError = { code -> if (code == 401) refreshAfterUnauthorized("sessionClient") }

        notificationManager.onTokenReceived = { token ->
            registerPushToken(token)
        }
        notificationManager.onTokenRemoved = {
            unregisterPushToken()
        }
    }

    /**
     * Freeze a fake "connected to desktop" state and disable all networking.
     * No-ops outside debug builds. Used by scripts/take-screenshots.sh.
     */
    fun enterScreenshotMode(devices: List<DeviceInfo>, syncedAt: Long) {
        val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) return
        screenshotMode = true
        _connectedDevices.value = devices
        _state.value = SyncConnectionState(
            indexConnected = true,
            sessionConnected = true,
            isConnecting = false,
            lastIndexSyncAt = syncedAt,
            lastSessionSyncAt = syncedAt
        )
    }

    fun connectIfConfigured() {
        if (credentialStore.credentials?.hasAuthToken == true) {
            connect()
        }
    }

    fun connect() {
        if (screenshotMode) return
        val credentials = credentialStore.credentials
        if (credentials == null || !credentials.hasAuthToken) {
            _state.update {
                it.copy(
                    isConnecting = false,
                    lastError = "Sync requires a session JWT."
                )
            }
            return
        }
        // A token after a forced sign-out means the user signed back in.
        if (auth.health.value is AuthHealth.SignedOut) auth.recordSuccess()

        val jwtClaims = extractJwtClaims(credentials.authJwt.orEmpty(), gson)
        val routeUserId = credentials.routingUserId ?: jwtClaims?.sub
        if (routeUserId.isNullOrBlank()) {
            _state.update { it.copy(isConnecting = false, lastError = "Missing routing user ID.") }
            return
        }
        val orgId = credentials.routingOrgId ?: jwtClaims?.orgId
        if (orgId.isNullOrBlank()) {
            _state.update { it.copy(isConnecting = false, lastError = "Missing org ID for room routing.") }
            return
        }
        val cryptoUserId = credentials.cryptoUserId ?: jwtClaims?.sub
        if (cryptoUserId.isNullOrBlank()) {
            _state.update { it.copy(isConnecting = false, lastError = "Missing auth user ID for key derivation.") }
            return
        }

        activeCredentials = credentials.copy(
            authUserId = credentials.authUserId ?: jwtClaims?.sub,
            orgId = credentials.orgId ?: jwtClaims?.orgId,
            personalUserId = credentials.personalUserId,
            personalOrgId = credentials.personalOrgId
        )
        val roomId = "org:$orgId:user:$routeUserId:index"
        val authToken = credentials.authJwt.orEmpty()

        if (roomId == indexRoomId && crypto != null) {
            // Same account and room: this is a credential refresh (the UI calls
            // connect whenever stored credentials change). Keep the open
            // sockets and the active session; only the token changes.
            applyAuthToken(authToken)
            return
        }

        if (indexRoomId != null) {
            // A different account. Nothing decoded for the old one may land in
            // this account's database.
            leaveSessionRoom()
            indexIngestion.reset()
            decoder.clear()
            sessionState.clear()
            replication?.cancel()
            replication = null
            _indexCoverage.value = IndexCoverage()
            commands.clear()
            sessionHandler.clear()
            requests.cancel()
        }
        indexRoomId = roomId
        crypto = CryptoManager.fromSeed(credentials.encryptionSeed, cryptoUserId)
        _state.update { it.copy(isConnecting = true, lastError = null) }

        indexIngestion.submit { repository.clearPrototypeData() }

        presence.markConnected()
        indexClient.connect(
            serverUrl = credentials.serverUrl,
            roomId = roomId,
            authToken = authToken
        )
    }

    fun disconnect() {
        if (screenshotMode) return
        stopJwtRefreshTimer()
        leaveSessionRoom()
        indexClient.disconnect()
        indexIngestion.reset()
        // The next connect may be a different account; nothing parked for
        // this one may be published there.
        decoder.clear()
        replication?.cancel()
        replication = null
        commands.clear()
        sessionHandler.clear()
        creationDrafts.clear()
        requests.cancel()
        errors.clear()
        indexRoomId = null
        _connectedDevices.value = emptyList()
        _state.update {
            it.copy(
                indexConnected = false,
                sessionConnected = false,
                isConnecting = false,
                activeSessionId = null
            )
        }
    }

    fun requestFullSync() {
        if (screenshotMode) return
        if (!indexClient.isConnected) {
            connectIfConfigured()
            return
        }
        if (v2Negotiated) indexIngestion.submit { replication?.start() } else indexRequests.requestFull()
    }

    /**
     * Asks for one session's row, e.g. to open a session that has not synced
     * yet. On v2 this is a lookup page (with ancestors); on a legacy server a
     * full index sync, folded into one already in flight.
     */
    fun requestSessionIndexLookup(sessionId: String) {
        if (screenshotMode) return
        when {
            !indexClient.isConnected -> connectIfConfigured()
            v2Negotiated -> indexIngestion.submit { replication?.lookup(listOf(sessionId)) }
            else -> indexRequests.lookup(sessionId)
        }
    }

    private val v2Negotiated: Boolean get() = _indexCoverage.value.compatibility == IndexCoverage.Compatibility.V2

    /** A fresh driver per index connection; its seed request doubles as the v2 probe. */
    private fun startReplication() {
        replication?.cancel()
        val client = IndexReplicationClient(
            gson = gson,
            store = repository.indexReplication,
            repository = repository,
            decoder = decoder,
            crypto = { crypto },
            send = indexClient::sendRaw,
            coverage = _indexCoverage,
            scope = scope,
            submit = indexIngestion::submit,
            onApplied = indexHandler::afterReplicatedPage,
            onBootstrapFinalized = indexHandler::bootstrapFinalized,
            onLegacyServer = { indexRequests.requestFull() }
        )
        replication = client
        client.setForeground(presence.isInForeground)
        indexIngestion.submit { client.start() }
    }

    fun joinSessionRoom(sessionId: String) {
        _state.update { it.copy(activeSessionId = sessionId) }
        if (screenshotMode) return
        scope.launch { commands.warmHost(sessionId) }
        connectSessionClient(sessionId)
        if (!indexClient.isConnected) {
            // Likely an expired JWT; the index connect callback rejoins the
            // active session once the fresh token lands.
            Log.w(TAG, "[joinSessionRoom] Index not connected, reconnecting")
            indexClient.ensureConnected()
        }
    }

    /**
     * Leave the session room. Pass [expectedSessionId] from a screen's dispose
     * path: navigating A to B disposes A after B has joined, and an unscoped
     * leave would tear down B's room.
     */
    fun leaveSessionRoom(expectedSessionId: String? = null) {
        if (screenshotMode) return
        val active = _state.value.activeSessionId
        if (expectedSessionId != null && active != expectedSessionId) {
            Log.d(TAG, "[leaveSessionRoom] skipping stale leave for $expectedSessionId; active is $active")
            return
        }
        sessionClient.disconnect()
        _state.update { it.copy(sessionConnected = false, activeSessionId = null) }
    }

    private fun connectSessionClient(sessionId: String) {
        val credentials = activeCredentials ?: credentialStore.credentials
        if (credentials == null || !credentials.hasAuthToken) {
            Log.w(TAG, "[connectSessionClient] No credentials or auth token")
            return
        }

        val effectiveUserId = credentials.routingUserId ?: run {
            Log.w(TAG, "[connectSessionClient] No routingUserId"); return
        }
        val orgId = credentials.routingOrgId ?: run {
            Log.w(TAG, "[connectSessionClient] No routingOrgId"); return
        }
        val roomId = "org:$orgId:user:$effectiveUserId:session:$sessionId"
        Log.d(TAG, "[connectSessionClient] sessionId=$sessionId roomId=$roomId")
        sessionClient.connect(
            serverUrl = credentials.serverUrl,
            roomId = roomId,
            authToken = credentials.authJwt.orEmpty(),
            tag = sessionId
        )
    }

    /** Called on every index (re)connect, including after a token refresh. */
    private fun onIndexConnected() {
        notificationManager.state.value.deviceToken?.let(::registerPushToken)
        startReplication()
        startJwtRefreshTimer()
        indexIngestion.submit { requests.reconnect() }
        rejoinActiveSession()
    }

    /**
     * Asks a host to create a session. Returns the requestId, or the reason no
     * request was sent. The outcome arrives on [sessionCreationCompletions] and
     * from [awaitSessionCreation].
     */
    fun createSession(options: SessionCreationOptions): Result<String> {
        val crypto = crypto ?: return Result.failure(IllegalStateException("Sync is not ready."))
        if (!indexClient.isConnected) {
            return Result.failure(IllegalStateException("Connect to sync before creating a session."))
        }
        return runCatching {
            val requestId = UUID.randomUUID().toString()
            val json = buildCreateSessionRequest(
                options, requestId, crypto, _connectedDevices.value, gson, System.currentTimeMillis()
            )
            creations.register(requestId)
            options.initialDraft?.let { creationDrafts[requestId] = it }
            if (!indexClient.sendRaw(json)) {
                creations.fail(requestId, "Failed to send create session request.")
                creationDrafts.remove(requestId)
                error("Failed to send create session request.")
            }
            requestId
        }
    }

    suspend fun awaitSessionCreation(requestId: String): SessionCreationOutcome = creations.await(requestId)

    @Deprecated("Use createSession(SessionCreationOptions)")
    fun createSession(projectId: String, initialPrompt: String? = null): Result<Unit> =
        createSession(SessionCreationOptions(projectId = projectId, initialPrompt = initialPrompt)).map { }

    suspend fun sendPrompt(
        sessionId: String,
        text: String,
        attachments: List<PendingAttachment> = emptyList()
    ): Result<Unit> = prompts.send(sessionId, text, attachments)
        .onSuccess { _state.update { it.copy(lastError = null) } }
        .map { }

    suspend fun cancelSession(sessionId: String): Result<Unit> = commands.cancelSession(sessionId)

    suspend fun setSessionArchived(sessionId: String, isArchived: Boolean): Result<Unit> =
        commands.setSessionArchived(sessionId, isArchived)

    /** Moves a session into [parentSessionId]'s workstream, or out of one when null. */
    suspend fun updateSessionParent(sessionId: String, parentSessionId: String?): Result<Unit> =
        commands.updateSessionParent(sessionId, parentSessionId)

    fun createWorktree(projectId: String, targetDeviceId: String? = null): Result<String> =
        commands.createWorktree(projectId, targetDeviceId)

    fun clearSyncError() = errors.clear()

    /** Addressed to the session's host once [joinSessionRoom] has read it. */
    fun sendSessionControlMessage(sessionId: String, messageType: String, payload: JsonObject? = null): Result<Unit> =
        commands.sendControlNow(sessionId, messageType, payload)

    fun registerPushToken(token: String): Result<Unit> = sendIndex(presence.registerPushToken(token), "register push token")

    fun unregisterPushToken(): Result<Unit> = sendIndex(presence.unregisterPushToken(), "unregister push token")

    private fun sendIndex(json: String, what: String): Result<Unit> = when {
        !indexClient.isConnected -> Result.failure(IllegalStateException("Index room is not connected."))
        indexClient.sendRaw(json) -> Result.success(Unit)
        else -> Result.failure(IllegalStateException("Failed to $what."))
    }

    fun appendToolResult(
        sessionId: String,
        toolResultId: String,
        content: String
    ): Result<Unit> {
        val crypto = crypto ?: return Result.failure(IllegalStateException("Sync is not ready."))
        if (sessionClient.connectedTag != sessionId || !sessionClient.isConnected) {
            return Result.failure(IllegalStateException("Session room is not connected."))
        }

        return try {
            val encryptedContent = crypto.encrypt(content)
            val request = AppendMessageRequest(
                message = ServerMessageEntry(
                    id = toolResultId,
                    sequence = 0,
                    createdAt = System.currentTimeMillis(),
                    source = "system",
                    direction = "input",
                    encryptedContent = encryptedContent.encrypted,
                    iv = encryptedContent.iv,
                    metadata = null
                )
            )
            if (sessionClient.sendRaw(gson.toJson(request))) {
                Result.success(Unit)
            } else {
                Result.failure(IllegalStateException("Failed to append tool result."))
            }
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    fun handleInteractiveResponse(
        sessionId: String,
        action: String,
        promptId: String,
        body: JsonObject
    ): Result<Unit> {
        return try {
            interactive.respond(sessionId, action, promptId, body)
            _state.update { it.copy(lastError = null) }
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    /** Saves the draft locally and publishes it; republished after reconnect if the send does not land. */
    suspend fun updateDraftInput(sessionId: String, draftInput: String) = sessionState.updateDraft(sessionId, draftInput)

    /** Marks [sessionId] read up to [readAt] locally and publishes the marker; republished after reconnect if needed. */
    suspend fun markSessionRead(sessionId: String, readAt: Long) = sessionState.markRead(sessionId, readAt)

    /** Report real user interaction; feeds the presence status other devices see. */
    fun reportUserActivity() {
        presence.reportActivity()
    }

    /**
     * The server withholds push from a device that announced itself active in
     * the last two minutes, so leaving the foreground is announced right away
     * rather than on the next 30s heartbeat.
     */
    fun setAppInForeground(inForeground: Boolean) {
        if (presence.isInForeground == inForeground) return
        presence.setForeground(inForeground)
        indexClient.announceNow()
        indexIngestion.submit { replication?.setForeground(inForeground) }
        // A backgrounded phone is often offline; refreshing then only piles up
        // failures. The token has likely expired by the time the user is back,
        // so refresh at once instead of waiting out the interval.
        if (!inForeground) {
            stopJwtRefreshTimer()
        } else if (indexRoomId != null && !screenshotMode) {
            startJwtRefreshTimer()
            scope.launch { refreshJwt() }
        }
    }

    /** Test hook: whether the periodic JWT refresh is running. */
    internal val isJwtRefreshScheduled: Boolean get() = jwtRefreshJob?.isActive == true

    /** Test hook: waits until both rooms have applied everything received so far. */
    internal suspend fun awaitIngestionIdle() {
        indexIngestion.awaitIdle()
        sessionIngestion.awaitIdle()
    }

    /** Test hook: session-room work queued after this waits for [gate]. */
    internal fun holdSessionIngestionForTest(gate: kotlinx.coroutines.Deferred<Unit>) = sessionIngestion.submit { gate.await() }

    private fun reportIngestionFailure(error: Throwable) {
        _state.update { it.copy(lastError = "Sync could not apply an update: ${error.message}") }
        errors.report(SyncErrorKind.STORAGE, "A synced change could not be saved on this device.")
    }

    // -- JWT Refresh --

    private fun startJwtRefreshTimer() {
        stopJwtRefreshTimer()
        if (!presence.isInForeground) return
        jwtRefreshJob = scope.launch {
            while (isActive) {
                delay(JWT_REFRESH_INTERVAL_MS)
                refreshJwt()
            }
        }
    }

    private fun stopJwtRefreshTimer() {
        jwtRefreshJob?.cancel()
        jwtRefreshJob = null
    }

    private fun refreshAfterUnauthorized(source: String) {
        val now = System.currentTimeMillis()
        if (now - lastJwtRefreshAttempt < REFRESH_RETRY_WINDOW_MS) {
            Log.w(TAG, "[$source] 401 but JWT was refreshed recently, not retrying")
            return
        }
        Log.w(TAG, "[$source] 401 - refreshing JWT")
        lastJwtRefreshAttempt = now
        scope.launch { refreshJwt() }
    }

    internal suspend fun refreshJwt() {
        val credentials = credentialStore.credentials ?: return
        val result = tokenRefresher.refresh(credentials)
        // A sign-out, sign-in or re-pair during the await: the answer is the previous
        // session's, and must neither overwrite nor sign out the one stored now.
        val current = credentialStore.credentials
        if (current == null || current.serverUrl != credentials.serverUrl || current.encryptionSeed != credentials.encryptionSeed ||
            current.authUserId != credentials.authUserId || current.sessionToken != credentials.sessionToken
        ) {
            Log.w(TAG, "Dropping a JWT refresh answer for a session that is no longer stored")
            return
        }
        val refreshed = when (result) {
            is TokenRefresh.Refreshed -> result.credentials
            // Offline or a server error: no verdict on the session, so it never counts toward sign-out.
            TokenRefresh.Unavailable -> return
            TokenRefresh.Rejected -> {
                if (auth.recordFailure() is AuthHealth.SignedOut) {
                    // Escalate rather than retry forever: clear the session so the UI shows login.
                    disconnect()
                    credentialStore.credentials?.let { credentialStore.save(it.signedOut()) }
                }
                return
            }
        }
        auth.recordSuccess()
        credentialStore.save(refreshed)
        activeCredentials = activeCredentials?.copy(
            authJwt = refreshed.authJwt,
            sessionToken = refreshed.sessionToken,
            authExpiresAt = refreshed.authExpiresAt
        ) ?: refreshed

        // Never disconnect here: that leaves the session room and clears the
        // active session, and nothing rejoins it (NIM-7271).
        applyAuthToken(refreshed.authJwt.orEmpty())
        Log.d(TAG, "JWT refreshed successfully")
    }

    /**
     * Installs a fresh token without tearing anything down: open sockets stay
     * open, and any room that dropped (typically on a 401) reconnects with it.
     */
    private fun applyAuthToken(authToken: String) {
        indexClient.updateAuthToken(authToken)
        sessionClient.updateAuthToken(authToken)
        indexClient.ensureConnected()
        rejoinActiveSession()
    }

    /** Brings the session room back for the session the user has open. */
    private fun rejoinActiveSession() {
        val sessionId = _state.value.activeSessionId ?: return
        if (sessionClient.connectedTag == sessionId) {
            sessionClient.ensureConnected()
        } else {
            connectSessionClient(sessionId)
        }
    }
}
