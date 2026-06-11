package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonSyntaxException
import com.nimbalyst.app.attachments.ImageCompressor
import com.nimbalyst.app.attachments.PendingAttachment
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.MessageEntity
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.QueuedPromptEntity
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.pairing.PairingStore
import android.content.Context
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class SyncManager(
    private val context: Context,
    private val repository: NimbalystRepository,
    private val pairingStore: PairingStore,
    private val notificationManager: NotificationManager,
    private val scope: CoroutineScope,
) {
    private val gson = Gson()

    companion object {
        private const val TAG = "SyncManager"
    }
    private val indexClient = WebSocketClient(scope)
    private val sessionClient = WebSocketClient(scope)
    private val _state = MutableStateFlow(SyncConnectionState())
    private val _connectedDevices = MutableStateFlow<List<DeviceInfo>>(emptyList())
    private val _availableModels = MutableStateFlow<List<SyncedAvailableModel>>(emptyList())
    private val _desktopDefaultModel = MutableStateFlow<String?>(null)
    // sessionId -> pre-projected transcript tail JSON (oversized sessions whose
    // per-message sync the server disabled). Rendered in place of synced messages.
    private val _transcriptTails = MutableStateFlow<Map<String, String>>(emptyMap())
    // sessionId -> latest cursor-based projected transcript page requested by
    // the WebView when the user scrolls upward.
    private val _transcriptHistoryPages = MutableStateFlow<Map<String, String>>(emptyMap())

    private var activeCredentials: PairingCredentials? = null
    private var crypto: CryptoManager? = null
    private var jwtRefreshJob: Job? = null
    private var pendingSessionJoin: String? = null
    private var lastJwtRefreshAttempt: Long = 0

    val state: StateFlow<SyncConnectionState> = _state.asStateFlow()
    val connectedDevices: StateFlow<List<DeviceInfo>> = _connectedDevices.asStateFlow()
    val availableModels: StateFlow<List<SyncedAvailableModel>> = _availableModels.asStateFlow()
    val desktopDefaultModel: StateFlow<String?> = _desktopDefaultModel.asStateFlow()
    val transcriptTails: StateFlow<Map<String, String>> = _transcriptTails.asStateFlow()
    val transcriptHistoryPages: StateFlow<Map<String, String>> = _transcriptHistoryPages.asStateFlow()

    init {
        indexClient.onConnectionStateChanged = { connected ->
            _state.update {
                it.copy(
                    indexConnected = connected,
                    isConnecting = false,
                    lastError = if (connected) null else it.lastError
                )
            }
            if (connected) {
                notificationManager.state.value.deviceToken?.let(::registerPushToken)
                requestFullSync()
                startJwtRefreshTimer()
                // If a session join was deferred waiting for index reconnection, do it now
                pendingSessionJoin?.let { sessionId ->
                    pendingSessionJoin = null
                    Log.d(TAG, "[indexClient] Resuming deferred session join: $sessionId")
                    connectSessionClient(sessionId)
                }
            }
        }
        indexClient.onTextMessage = { message ->
            scope.launch {
                handleIndexMessage(message)
            }
        }
        indexClient.onFailure = { error ->
            _state.update { it.copy(isConnecting = false, lastError = error) }
        }
        indexClient.onHttpError = { code ->
            if (code == 401) {
                val now = System.currentTimeMillis()
                if (now - lastJwtRefreshAttempt < 30_000) {
                    Log.w(TAG, "[indexClient] 401 but JWT was refreshed recently, not retrying")
                } else {
                    Log.w(TAG, "[indexClient] 401 - refreshing JWT")
                    lastJwtRefreshAttempt = now
                    scope.launch { refreshJwt() }
                }
            }
        }

        sessionClient.onConnectionStateChanged = { connected ->
            val sessionId = _state.value.activeSessionId
            Log.d(TAG, "[sessionClient] connection=$connected activeSessionId=$sessionId")
            _state.update {
                it.copy(
                    sessionConnected = connected,
                    lastError = if (connected) null else it.lastError
                )
            }
            if (connected && sessionId != null) {
                scope.launch {
                    Log.d(TAG, "[sessionClient] Sending syncRequest for $sessionId")
                    requestSessionSync(sessionId)
                }
            }
        }
        sessionClient.onTextMessage = { message ->
            scope.launch {
                val type = decodeEnvelope(message)?.type
                Log.d(TAG, "[sessionClient] Received message type=$type len=${message.length}")
                handleSessionMessage(message)
            }
        }
        sessionClient.onFailure = { error ->
            Log.e(TAG, "[sessionClient] WebSocket failure: $error")
            _state.update { it.copy(lastError = error) }
        }
        sessionClient.onHttpError = { code ->
            if (code == 401) {
                val now = System.currentTimeMillis()
                if (now - lastJwtRefreshAttempt < 30_000) {
                    Log.w(TAG, "[sessionClient] 401 but JWT was refreshed recently, not retrying")
                } else {
                    val sessionId = _state.value.activeSessionId
                    Log.w(TAG, "[sessionClient] 401 - refreshing JWT and retrying session $sessionId")
                    if (sessionId != null) {
                        pendingSessionJoin = sessionId
                        lastJwtRefreshAttempt = now
                        scope.launch { refreshJwt() }
                    }
                }
            }
        }

        notificationManager.onTokenReceived = { token ->
            registerPushToken(token)
        }
    }

    fun connectIfConfigured() {
        if (pairingStore.state.value.isSyncConfigured) {
            connect()
        }
    }

    fun connect() {
        val credentials = pairingStore.state.value.credentials
        if (credentials == null || !credentials.hasAuthToken) {
            _state.update {
                it.copy(
                    isConnecting = false,
                    lastError = "Sync requires a session JWT."
                )
            }
            return
        }

        val jwtClaims = extractJwtClaims(credentials.authJwt.orEmpty())
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
        crypto = CryptoManager.fromSeed(credentials.encryptionSeed, cryptoUserId)
        _state.update { it.copy(isConnecting = true, lastError = null) }

        scope.launch {
            repository.clearPrototypeData()
        }

        val roomId = "org:$orgId:user:$routeUserId:index"
        SyncForegroundService.start(context)
        indexClient.connect(
            serverUrl = credentials.serverUrl,
            roomId = roomId,
            authToken = credentials.authJwt.orEmpty()
        )
    }

    fun disconnect(stopForegroundService: Boolean = true) {
        if (stopForegroundService) {
            SyncForegroundService.stop(context)
        }
        stopJwtRefreshTimer()
        leaveSessionRoom()
        indexClient.disconnect()
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
        if (!indexClient.isConnected) {
            connectIfConfigured()
            return
        }
        indexClient.sendRaw(gson.toJson(IndexSyncRequest()))
    }

    fun joinSessionRoom(sessionId: String) {
        _state.update { it.copy(activeSessionId = sessionId) }

        // If the index client isn't connected, we need to reconnect first
        // (likely expired JWT). Queue the session join for after reconnection.
        if (!indexClient.isConnected) {
            Log.w(TAG, "[joinSessionRoom] Index not connected, reconnecting first")
            pendingSessionJoin = sessionId
            scope.launch {
                // Try JWT refresh first, then reconnect
                refreshJwt()
                // After reconnect, the index onConnectionStateChanged callback
                // will fire, and we check pendingSessionJoin there.
            }
            return
        }

        connectSessionClient(sessionId)
    }

    private fun connectSessionClient(sessionId: String) {
        val credentials = activeCredentials ?: pairingStore.state.value.credentials
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
            authToken = credentials.authJwt.orEmpty()
        )
    }

    fun createSession(
        projectId: String,
        initialPrompt: String? = null
    ): Result<Unit> {
        val crypto = crypto ?: return Result.failure(IllegalStateException("Sync is not ready."))
        if (!indexClient.isConnected) {
            return Result.failure(IllegalStateException("Index room is not connected."))
        }

        return runCatching {
            val encryptedProjectId = crypto.encryptProjectId(projectId)
            val encryptedPrompt = initialPrompt
                ?.takeIf { it.isNotBlank() }
                ?.let { crypto.encrypt(it) }

            val request = CreateSessionRequestMessage(
                request = EncryptedCreateSessionRequest(
                    requestId = UUID.randomUUID().toString(),
                    encryptedProjectId = encryptedProjectId,
                    projectIdIv = CryptoManager.projectIdIvBase64,
                    encryptedInitialPrompt = encryptedPrompt?.encrypted,
                    initialPromptIv = encryptedPrompt?.iv,
                    timestamp = System.currentTimeMillis()
                )
            )

            val sent = indexClient.sendRaw(gson.toJson(request))
            if (!sent) {
                throw IllegalStateException("Failed to send create session request.")
            }
        }
    }

    suspend fun sendPrompt(
        sessionId: String,
        text: String,
        attachments: List<PendingAttachment> = emptyList()
    ): Result<Unit> {
        val promptText = text.trim()
        if (promptText.isBlank() && attachments.isEmpty()) {
            return Result.failure(IllegalArgumentException("Prompt cannot be empty."))
        }

        val crypto = crypto ?: return Result.failure(IllegalStateException("Sync is not ready."))
        if (!indexClient.isConnected) {
            return Result.failure(IllegalStateException("Index room is not connected."))
        }

        val session = repository.getSession(sessionId)
            ?: return Result.failure(IllegalStateException("Session not found."))

        return try {
            val now = System.currentTimeMillis()
            val promptId = UUID.randomUUID().toString()
            val encryptedPrompt = crypto.encrypt(promptText)
            val encryptedProjectId = crypto.encryptProjectId(session.projectId)
            val queuedPrompt = EncryptedQueuedPrompt(
                id = promptId,
                encryptedPrompt = encryptedPrompt.encrypted,
                iv = encryptedPrompt.iv,
                timestamp = now,
                source = "keyboard"
            ).also { prompt ->
                val encryptedAttachments = attachments.mapNotNull { attachment ->
                    val compressed = ImageCompressor.compress(attachment.bitmap) ?: return@mapNotNull null
                    val encrypted = crypto.encryptData(compressed.data)
                    WireEncryptedAttachment(
                        id = attachment.id,
                        filename = attachment.filename,
                        mimeType = "image/jpeg",
                        encryptedData = encrypted.encrypted,
                        iv = encrypted.iv,
                        size = compressed.data.size,
                        width = compressed.width,
                        height = compressed.height
                    )
                }
                prompt.encryptedAttachments = encryptedAttachments.takeIf { it.isNotEmpty() }
            }

            val update = IndexUpdateMessage(
                session = IndexUpdateEntry(
                    sessionId = sessionId,
                    encryptedProjectId = encryptedProjectId,
                    projectIdIv = CryptoManager.projectIdIvBase64,
                    encryptedTitle = session.titleEncrypted,
                    titleIv = session.titleIv,
                    provider = session.provider ?: "claude-code",
                    model = session.model,
                    mode = session.mode,
                    messageCount = repository.messageCount(sessionId),
                    lastMessageAt = now,
                    createdAt = session.createdAt,
                    updatedAt = now,
                    isExecuting = session.isExecuting,
                    queuedPromptCount = 1,
                    encryptedQueuedPrompts = listOf(queuedPrompt)
                )
            )

            val sent = indexClient.sendRaw(gson.toJson(update))
            if (!sent) {
                throw IllegalStateException("Failed to send prompt update.")
            }

            repository.upsertSession(
                session.copy(
                    updatedAt = now,
                    lastMessageAt = now
                )
            )
            _state.update { it.copy(lastError = null) }
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    fun sendSessionControlMessage(
        sessionId: String,
        messageType: String,
        payload: JsonObject? = null
    ): Result<Unit> {
        if (!indexClient.isConnected) {
            Log.w(TAG, "Cannot send session control message type=$messageType sessionId=$sessionId: index room is not connected")
            return Result.failure(IllegalStateException("Index room is not connected."))
        }

        val message = SessionControlMessage(
            message = SessionControlPayload(
                sessionId = sessionId,
                messageType = messageType,
                payload = payload,
                timestamp = System.currentTimeMillis()
            )
        )
        return if (indexClient.sendRaw(gson.toJson(message))) {
            Result.success(Unit)
        } else {
            Log.w(TAG, "Failed to send session control message type=$messageType sessionId=$sessionId")
            Result.failure(IllegalStateException("Failed to send session control message."))
        }
    }

    fun requestTranscriptHistoryPage(
        sessionId: String,
        beforeRawMessageId: Long?,
        count: Int = 240
    ): Result<String> {
        val requestId = UUID.randomUUID().toString()
        val payload = JsonObject().apply {
            addProperty("requestId", requestId)
            addProperty("count", count.coerceIn(40, 450))
            if (beforeRawMessageId == null) {
                add("beforeRawMessageId", com.google.gson.JsonNull.INSTANCE)
            } else {
                addProperty("beforeRawMessageId", beforeRawMessageId)
            }
        }

        return sendSessionControlMessage(
            sessionId = sessionId,
            messageType = "load_transcript_history",
            payload = payload
        ).map { requestId }
    }

    fun registerPushToken(token: String): Result<Unit> {
        if (!indexClient.isConnected) {
            return Result.failure(IllegalStateException("Index room is not connected."))
        }

        val message = RegisterPushTokenMessage(
            token = token,
            platform = "android",
            deviceId = WebSocketClient.getDeviceId(context)
        )
        return if (indexClient.sendRaw(gson.toJson(message))) {
            Result.success(Unit)
        } else {
            Result.failure(IllegalStateException("Failed to register push token."))
        }
    }

    fun appendToolResult(
        sessionId: String,
        toolResultId: String,
        content: String
    ): Result<Unit> {
        val crypto = crypto ?: return Result.failure(IllegalStateException("Sync is not ready."))
        if (_state.value.activeSessionId != sessionId || !sessionClient.isConnected) {
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
            when (action) {
                "askUserQuestionSubmit" -> {
                    val answers = body.getAsJsonObject("answers") ?: JsonObject()
                    val response = JsonObject().apply { add("answers", answers.deepCopy()) }
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "ask_user_question",
                            "promptId" to promptId,
                            "response" to response
                        )
                    ).getOrThrow()
                    appendToolResult(sessionId, promptId, gson.toJson(response))
                        .onFailure { Log.w(TAG, "appendToolResult failed (non-fatal): ${it.message}") }
                }

                "askUserQuestionCancel" -> {
                    val response = JsonObject().apply {
                        add("answers", JsonObject())
                        addProperty("cancelled", true)
                    }
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "ask_user_question",
                            "promptId" to promptId,
                            "response" to response
                        )
                    ).getOrThrow()
                }

                "requestUserInputSubmit" -> {
                    val answers = body.getAsJsonObject("answers") ?: JsonObject()
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "request_user_input",
                            "promptId" to promptId,
                            "response" to jsonObject(
                                "answers" to answers,
                                "cancelled" to false
                            )
                        )
                    ).getOrThrow()
                }

                "requestUserInputCancel" -> {
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "request_user_input",
                            "promptId" to promptId,
                            "response" to jsonObject(
                                "answers" to JsonObject(),
                                "cancelled" to true
                            )
                        )
                    ).getOrThrow()
                }

                "toolPermissionSubmit" -> {
                    val response = body.getAsJsonObject("response") ?: JsonObject()
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "tool_permission",
                            "promptId" to promptId,
                            "response" to response
                        )
                    ).getOrThrow()
                    appendToolResult(sessionId, promptId, gson.toJson(response))
                        .onFailure { Log.w(TAG, "appendToolResult failed (non-fatal): ${it.message}") }
                }

                "exitPlanModeApprove" -> {
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "exit_plan_mode",
                            "promptId" to promptId,
                            "response" to jsonObject("approved" to true)
                        )
                    ).getOrThrow()
                }

                "exitPlanModeDeny" -> {
                    val response = jsonObject("approved" to false)
                    body.get("feedback")?.takeIf { !it.isJsonNull }?.asString?.let {
                        response.addProperty("feedback", it)
                    }
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "exit_plan_mode",
                            "promptId" to promptId,
                            "response" to response
                        )
                    ).getOrThrow()
                }

                "exitPlanModeStartNewSession" -> {
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "exit_plan_mode",
                            "promptId" to promptId,
                            "response" to jsonObject("approved" to false, "startNewSession" to true)
                        )
                    ).getOrThrow()
                }

                "exitPlanModeCancel" -> {
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "exit_plan_mode",
                            "promptId" to promptId,
                            "response" to jsonObject("approved" to false)
                        )
                    ).getOrThrow()
                }

                "gitCommit" -> {
                    val response = jsonObject(
                        "action" to "committed",
                        "files" to body.getAsJsonArray("files"),
                        "message" to body.get("message")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
                    )
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "git_commit",
                            "promptId" to promptId,
                            "response" to response
                        )
                    ).getOrThrow()
                }

                "gitCommitCancel" -> {
                    val response = jsonObject("action" to "cancelled")
                    sendSessionControlMessage(
                        sessionId = sessionId,
                        messageType = "prompt_response",
                        payload = jsonObject(
                            "promptType" to "git_commit",
                            "promptId" to promptId,
                            "response" to response
                        )
                    ).getOrThrow()
                    appendToolResult(sessionId, promptId, gson.toJson(response))
                        .onFailure { Log.w(TAG, "appendToolResult failed (non-fatal): ${it.message}") }
                }

                else -> throw IllegalArgumentException("Unsupported interactive action: $action")
            }

            _state.update { it.copy(lastError = null) }
            Result.success(Unit)
        } catch (error: Exception) {
            Result.failure(error)
        }
    }

    fun leaveSessionRoom() {
        sessionClient.disconnect()
        _state.update { it.copy(sessionConnected = false, activeSessionId = null) }
    }

    private suspend fun handleIndexMessage(message: String) {
        val type = decodeEnvelope(message)?.type
        when (type) {
            "indexSyncResponse" -> handleIndexSyncResponse(message)
            "indexBroadcast" -> handleIndexBroadcast(message)
            "indexDeleteBroadcast" -> handleIndexDeleteBroadcast(message)
            "projectBroadcast" -> handleProjectBroadcast(message)
            "createSessionResponseBroadcast" -> handleCreateSessionResponse(message)
            "settingsSyncBroadcast" -> handleSettingsSyncBroadcast(message)
            "devicesList" -> handleDevicesList(message)
            "deviceJoined" -> handleDeviceJoined(message)
            "deviceLeft" -> handleDeviceLeft(message)
            "error" -> handleServerError(message)
            null -> Log.w(TAG, "Index message with no type field")
            else -> Log.d(TAG, "Unhandled index message type: $type")
        }
    }

    private suspend fun handleSessionMessage(message: String) {
        val type = decodeEnvelope(message)?.type
        when (type) {
            "syncResponse" -> handleSessionSyncResponse(message)
            "messageBroadcast" -> handleMessageBroadcast(message)
            "metadataBroadcast" -> handleMetadataBroadcast(message)
            "error" -> handleServerError(message)
            null -> Log.w(TAG, "Session message with no type field")
            else -> Log.d(TAG, "Unhandled session message type: $type")
        }
    }

    private fun decodeEnvelope(message: String): ServerMessageEnvelope? {
        return try {
            gson.fromJson(message, ServerMessageEnvelope::class.java)
        } catch (e: JsonSyntaxException) {
            Log.w(TAG, "Failed to decode message envelope: ${e.message}")
            null
        }
    }

    private suspend fun handleIndexSyncResponse(message: String) {
        val response = parse<IndexSyncResponse>(message) ?: return
        val projects = response.projects.mapNotNull(::processProjectEntry)
        val sessions = response.sessions.mapNotNull { processSessionEntry(it) }
        val syncedAt = System.currentTimeMillis()
        repository.replaceIndexSnapshot(
            projects = projects,
            sessions = sessions.map { it.session },
            syncedAt = syncedAt
        )
        sessions.forEach { syncQueuedPrompts(it) }
        _state.update { it.copy(lastIndexSyncAt = syncedAt, lastError = null) }
    }

    private suspend fun handleIndexBroadcast(message: String) {
        val broadcast = parse<IndexBroadcast>(message) ?: return
        processSessionEntry(broadcast.session)?.let { processed ->
            repository.upsertSession(processed.session)
            syncQueuedPrompts(processed)
        }
    }

    private suspend fun handleIndexDeleteBroadcast(message: String) {
        val broadcast = parse<IndexDeleteBroadcast>(message) ?: return
        repository.deleteSession(broadcast.sessionId)
    }

    private suspend fun handleProjectBroadcast(message: String) {
        val broadcast = parse<ProjectBroadcast>(message) ?: return
        val project = processProjectEntry(broadcast.project) ?: return
        repository.replaceIndexSnapshot(
            projects = listOf(project),
            sessions = emptyList(),
            syncedAt = System.currentTimeMillis()
        )
    }

    private fun handleCreateSessionResponse(message: String) {
        val broadcast = parse<CreateSessionResponseBroadcast>(message) ?: return
        if (broadcast.response.success) {
            _state.update { it.copy(lastError = null) }
        } else {
            _state.update {
                it.copy(lastError = broadcast.response.error ?: "Desktop rejected the session creation request.")
            }
        }
    }

    private fun handleSettingsSyncBroadcast(message: String) {
        val broadcast = parse<SettingsSyncBroadcast>(message) ?: return
        val settingsJson = crypto?.decryptOrNull(
            broadcast.settings.encryptedSettings,
            broadcast.settings.settingsIv
        ) ?: return
        val settings = parse<SyncedSettings>(settingsJson) ?: return

        _availableModels.value = settings.availableModels.orEmpty()
        _desktopDefaultModel.value = settings.defaultModel
        _state.update { it.copy(lastError = null) }
    }

    private suspend fun handleSessionSyncResponse(message: String) {
        val sessionId = _state.value.activeSessionId ?: run {
            Log.w(TAG, "[sessionSync] No activeSessionId, ignoring syncResponse"); return
        }
        val response = parse<SessionSyncResponse>(message) ?: run {
            Log.w(TAG, "[sessionSync] Failed to parse SessionSyncResponse"); return
        }
        Log.d(TAG, "[sessionSync] Got syncResponse: ${response.messages.size} encrypted messages, hasMore=${response.hasMore}, cursor=${response.cursor}")
        response.metadata?.let { mergeSessionMetadata(sessionId, it) }

        val decryptedMessages = response.messages.mapNotNull { processMessageEntry(it, sessionId) }
        Log.d(TAG, "[sessionSync] Decrypted ${decryptedMessages.size}/${response.messages.size} messages")
        val lastSequence = maxOf(
            repository.syncState(sessionId)?.lastSequence ?: 0,
            decryptedMessages.maxOfOrNull { it.sequence } ?: 0
        )
        val syncedAt = System.currentTimeMillis()

        repository.persistSessionMessages(
            sessionId = sessionId,
            messages = decryptedMessages,
            cursor = response.cursor,
            lastSequence = lastSequence,
            syncedAt = syncedAt
        )
        val storedCount = repository.messageCount(sessionId)
        Log.d(TAG, "[sessionSync] After persist: $storedCount messages in DB for $sessionId")
        _state.update { it.copy(lastSessionSyncAt = syncedAt, lastError = null) }

        if (response.hasMore) {
            requestSessionSync(sessionId, lastSequence)
        }
    }

    private suspend fun handleMessageBroadcast(message: String) {
        val sessionId = _state.value.activeSessionId ?: return
        val broadcast = parse<MessageBroadcast>(message) ?: return
        val decrypted = processMessageEntry(broadcast.message, sessionId) ?: return
        repository.persistSessionMessages(
            sessionId = sessionId,
            messages = listOf(decrypted),
            cursor = null,
            lastSequence = decrypted.sequence,
            syncedAt = System.currentTimeMillis()
        )
    }

    private suspend fun handleMetadataBroadcast(message: String) {
        val sessionId = _state.value.activeSessionId ?: return
        val broadcast = parse<MetadataBroadcast>(message) ?: return
        mergeSessionMetadata(sessionId, broadcast.metadata)
    }

    private fun handleDevicesList(message: String) {
        val devices = parse<DevicesListMessage>(message)?.devices ?: return
        _connectedDevices.value = devices
    }

    private fun handleDeviceJoined(message: String) {
        val device = parse<DeviceJoinedMessage>(message)?.device ?: return
        _connectedDevices.update { current ->
            if (current.any { it.deviceId == device.deviceId }) current else current + device
        }
    }

    private fun handleDeviceLeft(message: String) {
        val deviceId = parse<DeviceLeftMessage>(message)?.deviceId ?: return
        _connectedDevices.update { current -> current.filterNot { it.deviceId == deviceId } }
    }

    private fun handleServerError(message: String) {
        val serverError = parse<ServerErrorMessage>(message) ?: return
        _state.update { it.copy(lastError = "${serverError.code}: ${serverError.message}") }
    }

    private suspend fun requestSessionSync(sessionId: String, explicitSinceSeq: Int? = null) {
        val sinceSeq = explicitSinceSeq ?: repository.syncState(sessionId)?.lastSequence
        val effectiveSinceSeq = sinceSeq?.takeIf { it > 0 }
        Log.d(TAG, "[requestSessionSync] sessionId=$sessionId sinceSeq=$effectiveSinceSeq")
        sessionClient.sendRaw(
            gson.toJson(
                SessionSyncRequest(sinceSeq = effectiveSinceSeq)
            )
        )
    }

    private fun processProjectEntry(entry: ServerProjectEntry): ProjectEntity? {
        val crypto = crypto ?: return null
        val projectId = crypto.decryptOrNull(entry.encryptedProjectId, entry.projectIdIv) ?: return null
        return ProjectEntity(
            id = projectId,
            name = File(projectId).name.ifBlank { projectId },
            sessionCount = entry.sessionCount ?: 0,
            lastUpdatedAt = entry.lastActivityAt,
            sortOrder = 0,
            commandsJson = null
        )
    }

    private suspend fun processSessionEntry(entry: ServerSessionEntry): ProcessedSessionEntry? {
        val crypto = crypto ?: return null
        val projectId = crypto.decryptOrNull(entry.encryptedProjectId, entry.projectIdIv) ?: return null
        val existing = repository.getSession(entry.sessionId)
        val titleDecrypted = crypto.decryptOrNull(entry.encryptedTitle, entry.titleIv)
        val clientMetadata = decodeClientMetadata(entry.encryptedClientMetadata, entry.clientMetadataIv)
        val agentStatus = clientMetadata?.agentStatus
        val now = System.currentTimeMillis()
        val isBareExecutingStale = entry.isExecuting == true &&
            agentStatus == null &&
            isStatusTimestampStale(entry.updatedAt, now)
        val shouldClearAgentStatus = agentStatus.isTerminalAgentStatus() ||
            agentStatus.isStaleActiveAgentStatus(now) ||
            isBareExecutingStale ||
            entry.isExecuting == false ||
            (agentStatus == null && existing.hasStaleActiveAgentStatus(now))
        val effectiveIsExecuting = when {
            agentStatus.isTerminalAgentStatus() -> false
            agentStatus.isStaleActiveAgentStatus(now) -> false
            entry.isExecuting == false -> false
            entry.isExecuting == true -> !isBareExecutingStale
            else -> existing?.effectiveIsExecuting(now) ?: false
        }
        captureTranscriptTail(entry.sessionId, clientMetadata)
        captureTranscriptHistoryPage(entry.sessionId, clientMetadata)

        return ProcessedSessionEntry(
            session = SessionEntity(
                id = entry.sessionId,
                projectId = projectId,
                titleEncrypted = entry.encryptedTitle,
                titleIv = entry.titleIv,
                titleDecrypted = titleDecrypted ?: existing?.titleDecrypted,
                provider = entry.provider ?: existing?.provider,
                model = entry.model ?: existing?.model,
                mode = entry.mode ?: existing?.mode,
                sessionType = entry.sessionType ?: existing?.sessionType,
                parentSessionId = entry.parentSessionId ?: existing?.parentSessionId,
                phase = clientMetadata?.phase ?: existing?.phase,
                tagsJson = clientMetadata?.tags?.takeIf { it.isNotEmpty() }?.let(gson::toJson) ?: existing?.tagsJson,
                worktreeId = entry.worktreeId ?: existing?.worktreeId,
                isArchived = entry.isArchived ?: existing?.isArchived ?: false,
                isPinned = entry.isPinned ?: existing?.isPinned ?: false,
                branchedFromSessionId = entry.branchedFromSessionId ?: existing?.branchedFromSessionId,
                branchPointMessageId = entry.branchPointMessageId ?: existing?.branchPointMessageId,
                branchedAt = entry.branchedAt ?: existing?.branchedAt,
                isExecuting = effectiveIsExecuting,
                agentStatusKind = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.kind
                    else -> existing?.agentStatusKind
                },
                agentStatusLabel = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.label
                    else -> existing?.agentStatusLabel
                },
                agentStatusDetail = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.detail
                    else -> existing?.agentStatusDetail
                },
                agentStatusUpdatedAt = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.updatedAt
                    else -> existing?.agentStatusUpdatedAt
                },
                hasQueuedPrompts = clientMetadata?.hasPendingPrompt
                    ?: entry.hasPendingPrompt
                    ?: when {
                        entry.queuedPromptCount == 0 -> false
                        entry.queuedPromptCount != null -> entry.queuedPromptCount > 0
                        else -> existing?.hasQueuedPrompts ?: false
                    },
                contextTokens = clientMetadata?.currentContext?.tokens ?: existing?.contextTokens,
                contextWindow = clientMetadata?.currentContext?.contextWindow ?: existing?.contextWindow,
                createdAt = entry.createdAt,
                updatedAt = entry.updatedAt,
                lastSyncedSeq = existing?.lastSyncedSeq ?: 0,
                lastReadAt = entry.lastReadAt ?: existing?.lastReadAt,
                lastMessageAt = entry.lastMessageAt ?: existing?.lastMessageAt,
                draftInput = null,
                draftUpdatedAt = null
            ),
            queuedPrompts = decryptQueuedPrompts(entry.sessionId, entry.encryptedQueuedPrompts),
            clearQueuedPrompts = entry.queuedPromptCount == 0 || entry.encryptedQueuedPrompts?.isEmpty() == true
        )
    }

    private fun processMessageEntry(entry: ServerMessageEntry, sessionId: String): MessageEntity? {
        val crypto = crypto ?: return null
        val contentDecrypted = crypto.decryptOrNull(entry.encryptedContent, entry.iv) ?: return null
        return MessageEntity(
            id = entry.id,
            sessionId = sessionId,
            sequence = entry.sequence,
            source = entry.source,
            direction = entry.direction,
            encryptedContent = entry.encryptedContent,
            iv = entry.iv,
            contentDecrypted = contentDecrypted,
            metadataJson = entry.metadata?.toString(),
            createdAt = entry.createdAt
        )
    }

    private suspend fun mergeSessionMetadata(
        sessionId: String,
        metadata: SessionRoomMetadata
    ) {
        val existing = repository.getSession(sessionId) ?: return
        val crypto = crypto ?: return
        val clientMetadata = decodeClientMetadata(metadata.encryptedClientMetadata, metadata.clientMetadataIv)
        val agentStatus = clientMetadata?.agentStatus
        val now = System.currentTimeMillis()
        val isBareExecutingStale = metadata.isExecuting == true &&
            agentStatus == null &&
            isStatusTimestampStale(metadata.updatedAt ?: existing.updatedAt, now)
        val shouldClearAgentStatus = agentStatus.isTerminalAgentStatus() ||
            agentStatus.isStaleActiveAgentStatus(now) ||
            isBareExecutingStale ||
            metadata.isExecuting == false ||
            (agentStatus == null && existing.hasStaleActiveAgentStatus(now))
        val effectiveIsExecuting = when {
            agentStatus.isTerminalAgentStatus() -> false
            agentStatus.isStaleActiveAgentStatus(now) -> false
            metadata.isExecuting == false -> false
            metadata.isExecuting == true -> !isBareExecutingStale
            else -> existing.effectiveIsExecuting(now)
        }
        captureTranscriptTail(sessionId, clientMetadata)
        captureTranscriptHistoryPage(sessionId, clientMetadata)
        val titleDecrypted = if (metadata.title != null) {
            metadata.title
        } else {
            crypto.decryptOrNull(existing.titleEncrypted, existing.titleIv)
        }
        val projectId = when {
            !metadata.encryptedProjectId.isNullOrBlank() && !metadata.projectIdIv.isNullOrBlank() ->
                crypto.decryptOrNull(metadata.encryptedProjectId, metadata.projectIdIv) ?: existing.projectId
            else -> existing.projectId
        }

        repository.upsertSession(
            existing.copy(
                projectId = projectId,
                titleDecrypted = titleDecrypted ?: existing.titleDecrypted,
                provider = metadata.provider ?: existing.provider,
                model = metadata.model ?: existing.model,
                mode = metadata.mode ?: existing.mode,
                isExecuting = effectiveIsExecuting,
                agentStatusKind = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.kind
                    else -> existing.agentStatusKind
                },
                agentStatusLabel = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.label
                    else -> existing.agentStatusLabel
                },
                agentStatusDetail = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.detail
                    else -> existing.agentStatusDetail
                },
                agentStatusUpdatedAt = when {
                    shouldClearAgentStatus -> null
                    agentStatus != null -> agentStatus.updatedAt
                    else -> existing.agentStatusUpdatedAt
                },
                updatedAt = metadata.updatedAt ?: existing.updatedAt,
                createdAt = metadata.createdAt ?: existing.createdAt,
                phase = clientMetadata?.phase ?: existing.phase,
                tagsJson = clientMetadata?.tags?.takeIf { it.isNotEmpty() }?.let(gson::toJson) ?: existing.tagsJson,
                hasQueuedPrompts = clientMetadata?.hasPendingPrompt ?: existing.hasQueuedPrompts,
                contextTokens = clientMetadata?.currentContext?.tokens ?: existing.contextTokens,
                contextWindow = clientMetadata?.currentContext?.contextWindow ?: existing.contextWindow,
                draftInput = null,
                draftUpdatedAt = null
            )
        )
    }

    private suspend fun syncQueuedPrompts(entry: ProcessedSessionEntry) {
        when {
            entry.queuedPrompts != null -> repository.replaceRemoteQueuedPrompts(
                sessionId = entry.session.id,
                prompts = entry.queuedPrompts
            )
            entry.clearQueuedPrompts -> repository.clearRemoteQueuedPrompts(entry.session.id)
        }
    }

    private fun decryptQueuedPrompts(
        sessionId: String,
        encryptedPrompts: List<EncryptedQueuedPrompt>?
    ): List<QueuedPromptEntity>? {
        val crypto = crypto ?: return null
        val prompts = encryptedPrompts?.takeIf { it.isNotEmpty() } ?: return null
        return prompts.mapNotNull { prompt ->
            val plaintext = crypto.decryptOrNull(prompt.encryptedPrompt, prompt.iv) ?: return@mapNotNull null
            QueuedPromptEntity(
                id = prompt.id,
                sessionId = sessionId,
                promptTextEncrypted = prompt.encryptedPrompt,
                iv = prompt.iv,
                createdAt = prompt.timestamp,
                sentAt = null,
                promptTextDecrypted = plaintext,
                source = prompt.source ?: "desktop"
            )
        }
    }

    // Cache the desktop-published transcript tail for an oversized session so the
    // detail screen can render it when per-message sync is unavailable. Only set
    // (never clear) on absence, since not every index update carries the tail.
    private fun captureTranscriptTail(sessionId: String, clientMetadata: ClientMetadata?) {
        val tail = clientMetadata?.mobileTranscriptTailJson
        if (tail.isNullOrBlank()) return
        Log.d(TAG, "[transcriptTail] captured for $sessionId (${tail.length} chars)")
        _transcriptTails.update { current ->
            if (current[sessionId] == tail) current else current + (sessionId to tail)
        }
    }

    private fun captureTranscriptHistoryPage(sessionId: String, clientMetadata: ClientMetadata?) {
        val page = clientMetadata?.mobileTranscriptHistoryPageJson
        if (page.isNullOrBlank()) return
        Log.d(TAG, "[transcriptHistoryPage] captured for $sessionId (${page.length} chars)")
        _transcriptHistoryPages.update { current ->
            if (current[sessionId] == page) current else current + (sessionId to page)
        }
    }

    private fun decodeClientMetadata(
        encryptedMetadata: String?,
        metadataIv: String?
    ): ClientMetadata? {
        val crypto = crypto ?: return null
        val json = crypto.decryptOrNull(encryptedMetadata, metadataIv) ?: return null
        return parse<ClientMetadata>(json)
    }

    private inline fun <reified T> parse(json: String): T? {
        return try {
            gson.fromJson(json, T::class.java)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse ${T::class.java.simpleName}: ${e.message}")
            null
        }
    }

    private fun jsonObject(vararg entries: Pair<String, Any?>): JsonObject {
        return JsonObject().apply {
            entries.forEach { (key, value) ->
                when (value) {
                    null -> add(key, com.google.gson.JsonNull.INSTANCE)
                    is String -> addProperty(key, value)
                    is Boolean -> addProperty(key, value)
                    is Number -> addProperty(key, value)
                    is JsonObject -> add(key, value.deepCopy())
                    is com.google.gson.JsonArray -> add(key, value.deepCopy())
                    is com.google.gson.JsonElement -> add(key, value.deepCopy())
                    else -> add(key, gson.toJsonTree(value))
                }
            }
        }
    }

    private fun extractJwtClaims(jwt: String): JwtClaims? {
        val parts = jwt.split('.')
        if (parts.size != 3) {
            return null
        }

        val payload = runCatching {
            val normalized = parts[1]
                .replace('-', '+')
                .replace('_', '/')
                .let { value ->
                    val padding = value.length % 4
                    if (padding == 0) value else value + "=".repeat(4 - padding)
                }
            String(java.util.Base64.getDecoder().decode(normalized), StandardCharsets.UTF_8)
        }.getOrNull() ?: return null

        val json = parse<JsonObject>(payload) ?: return null
        val orgId = json.getAsJsonObject("https://stytch.com/organization")
            ?.get("organization_id")
            ?.takeIf { !it.isJsonNull }
            ?.asString

        return JwtClaims(
            sub = json.get("sub")?.takeIf { !it.isJsonNull }?.asString,
            orgId = orgId
        )
    }

    // -- JWT Refresh --
    // Stytch JWTs expire after ~5 minutes. Refresh every 4 minutes to stay connected.

    private fun startJwtRefreshTimer() {
        stopJwtRefreshTimer()
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

    private suspend fun refreshJwt() {
        val credentials = pairingStore.state.value.credentials ?: return
        val sessionToken = credentials.sessionToken
        if (sessionToken.isNullOrBlank()) {
            Log.d(TAG, "No session token available for JWT refresh")
            return
        }

        val baseUrl = credentials.serverUrl
            .replace("wss://", "https://")
            .replace("ws://", "http://")
            .trimEnd('/')

        try {
            val url = URL("$baseUrl/auth/refresh")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                outputStream.write("""{"session_token":"$sessionToken"}""".toByteArray())
            }

            val responseCode = connection.responseCode
            if (responseCode != 200) {
                Log.w(TAG, "JWT refresh failed with status $responseCode")
                return
            }

            val responseBody = connection.inputStream.bufferedReader().readText()
            val json = parse<JsonObject>(responseBody) ?: return

            val newJwt = json.get("session_jwt")?.takeIf { !it.isJsonNull }?.asString
            if (newJwt.isNullOrBlank()) {
                Log.w(TAG, "JWT refresh response missing session_jwt")
                return
            }

            val newSessionToken = json.get("session_token")?.takeIf { !it.isJsonNull }?.asString
                ?: sessionToken
            val newUserId = json.get("user_id")?.takeIf { !it.isJsonNull }?.asString
                ?: credentials.authUserId
            val newEmail = json.get("email")?.takeIf { !it.isJsonNull }?.asString
                ?: credentials.authEmail
            val newExpiresAt = json.get("expires_at")?.takeIf { !it.isJsonNull }?.asString
                ?: credentials.authExpiresAt
            val newOrgId = json.get("org_id")?.takeIf { !it.isJsonNull }?.asString
                ?: credentials.orgId

            pairingStore.savePairing(
                credentials.copy(
                    authJwt = newJwt,
                    sessionToken = newSessionToken,
                    authUserId = newUserId,
                    authEmail = newEmail,
                    authExpiresAt = newExpiresAt,
                    orgId = newOrgId
                )
            )

            // Reconnect with the fresh JWT, keeping the foreground service
            // alive so the refresh cycle never drops the background network
            // exemption.
            disconnect(stopForegroundService = false)
            connect()

            Log.d(TAG, "JWT refreshed successfully")
        } catch (e: Exception) {
            Log.w(TAG, "JWT refresh request failed: ${e.message}")
        }
    }
}

private const val JWT_REFRESH_INTERVAL_MS = 4L * 60L * 1000L  // 4 minutes
private const val ACTIVE_AGENT_STATUS_TTL_MS = 5L * 60L * 1000L

private fun AgentStatus?.isTerminalAgentStatus(): Boolean {
    return when (this?.kind?.lowercase()) {
        "complete", "completed", "done", "idle" -> true
        else -> false
    }
}

private fun AgentStatus?.isActiveAgentStatus(): Boolean {
    return when (this?.kind?.lowercase()) {
        "thinking", "responding", "tool", "editing" -> true
        else -> false
    }
}

private fun AgentStatus?.isStaleActiveAgentStatus(now: Long = System.currentTimeMillis()): Boolean {
    if (!isActiveAgentStatus()) return false
    val updatedAt = this?.updatedAt ?: return true
    return isStatusTimestampStale(updatedAt, now)
}

private fun SessionEntity?.hasStaleActiveAgentStatus(now: Long = System.currentTimeMillis()): Boolean {
    val session = this ?: return false
    val isActiveStatus = when (session.agentStatusKind?.lowercase()) {
        "thinking", "responding", "tool", "editing" -> true
        else -> false
    }
    if (!isActiveStatus && !session.isExecuting) return false
    val updatedAt = session.agentStatusUpdatedAt ?: session.updatedAt
    return isStatusTimestampStale(updatedAt, now)
}

private fun SessionEntity.effectiveIsExecuting(now: Long = System.currentTimeMillis()): Boolean =
    isExecuting && !this.hasStaleActiveAgentStatus(now)

private fun isStatusTimestampStale(updatedAt: Long, now: Long): Boolean =
    updatedAt <= 0 || now - updatedAt > ACTIVE_AGENT_STATUS_TTL_MS

private data class JwtClaims(
    val sub: String?,
    val orgId: String?
)

private data class ProcessedSessionEntry(
    val session: SessionEntity,
    val queuedPrompts: List<QueuedPromptEntity>?,
    val clearQueuedPrompts: Boolean,
)
