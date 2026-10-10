package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.SessionEntity
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch

/** What the phone asks the desktop to create. Mirrors iOS `SessionCreationOptions`. */
data class SessionCreationOptions(
    val projectId: String,
    val initialPrompt: String? = null,
    /** "session", "workstream" or "blitz"; null means a plain session. */
    val sessionType: String? = null,
    val parentSessionId: String? = null,
    val provider: String? = null,
    val model: String? = null,
    /** e.g. "meta-agent". */
    val agentRole: String? = null,
    /** The host to create on; null picks one with [ExecutionHosts.creationTarget]. */
    val targetDeviceId: String? = null,
    /** Composer text to seed into the new session once it exists. Never sent to the desktop. */
    val initialDraft: String? = null,
)

/** How one of this device's create requests ended. */
sealed interface SessionCreationOutcome {
    val requestId: String

    /** The desktop created the session and its row is readable in Room. */
    data class Created(override val requestId: String, val sessionId: String) : SessionCreationOutcome

    /**
     * The desktop refused, never answered, or the row never arrived. A timeout
     * reports uncertainty: the session may still appear, so never auto-retry.
     */
    data class Failed(override val requestId: String, val message: String) : SessionCreationOutcome
}

/**
 * Encrypts and addresses a create request. Throws with the user-facing reason
 * when there is no host to send it to.
 */
internal fun buildCreateSessionRequest(
    options: SessionCreationOptions,
    requestId: String,
    crypto: CryptoManager,
    devices: List<DeviceInfo>,
    gson: Gson,
    now: Long,
): String {
    val target = ExecutionHosts.creationTarget(devices, options.targetDeviceId)
        ?: throw IllegalStateException(
            if (options.targetDeviceId == null) {
                "No desktop is connected. Open Nimbalyst on your computer and try again."
            } else {
                "The selected machine is not connected."
            }
        )
    val prompt = options.initialPrompt?.takeIf { it.isNotBlank() }?.let(crypto::encrypt)
    return gson.toJson(
        CreateSessionRequestMessage(
            request = EncryptedCreateSessionRequest(
                requestId = requestId,
                encryptedProjectId = crypto.encryptProjectId(options.projectId),
                projectIdIv = CryptoManager.projectIdIvBase64,
                encryptedInitialPrompt = prompt?.encrypted,
                initialPromptIv = prompt?.iv,
                sessionType = options.sessionType,
                parentSessionId = options.parentSessionId,
                provider = options.provider,
                model = options.model,
                agentRole = options.agentRole,
                timestamp = now
            ),
            targetDeviceId = target.deviceId
        )
    )
}

/**
 * Completes only this device's create requests, and only once the returned
 * session is readable in Room: the acknowledgement can arrive before the index
 * row, or twice. One timeout covers both the answer and the row. Port of iOS
 * `SessionCreationRequests` + `SessionCreationTracker`.
 */
internal class SessionCreationTracker(
    private val scope: CoroutineScope,
    private val observeSession: (String) -> Flow<SessionEntity?>,
    /** Asks the index for a row that has not arrived yet. */
    private val lookup: (String) -> Unit,
    /** Runs after [SessionCreationOutcome.Created] is published. */
    private val onReady: suspend (requestId: String, sessionId: String) -> Unit,
    private val timeoutMs: Long = TIMEOUT_MS,
) {
    private class Pending(val timeout: Job, var sessionId: String? = null, var arrival: Job? = null)

    private val lock = Any()
    private val pending = ConcurrentHashMap<String, Pending>()
    private val _pendingIds = MutableStateFlow<Set<String>>(emptySet())
    private val _results = MutableStateFlow<Map<String, SessionCreationOutcome>>(emptyMap())
    private val _completions = MutableSharedFlow<SessionCreationOutcome>(extraBufferCapacity = 16)

    val pendingIds: StateFlow<Set<String>> = _pendingIds.asStateFlow()
    val completions: SharedFlow<SessionCreationOutcome> = _completions.asSharedFlow()

    fun register(requestId: String) {
        val timeout = scope.launch {
            delay(timeoutMs)
            finish(
                requestId,
                failure = "The desktop did not confirm session creation. It may still appear; " +
                    "check the session list before trying again."
            )
        }
        pending[requestId] = Pending(timeout)
        publishPending()
    }

    /** Ignores responses to other devices' requests and duplicate acknowledgements. */
    fun receive(response: CreateSessionResponse) {
        val request = pending[response.requestId] ?: return
        synchronized(request) {
            if (request.sessionId != null) return
            val sessionId = response.sessionId?.takeIf { it.isNotEmpty() }
            if (!response.success || sessionId == null) {
                finish(response.requestId, failure = response.error ?: "The desktop did not return a created session.")
                return
            }
            request.sessionId = sessionId
            // Observe the committed row rather than an ingestion callback: a
            // snapshot, a broadcast or a lookup can each be the write that lands it.
            request.arrival = scope.launch {
                observeSession(sessionId).first { it != null }
                finish(response.requestId, sessionId = sessionId)
            }
        }
        // Already readable means already finished; a lookup would only cost a sync.
        if (pending.containsKey(response.requestId)) lookup(response.sessionId!!)
    }

    fun fail(requestId: String, message: String) = finish(requestId, failure = message)

    /** The index socket dropped: nothing in flight can be confirmed on this connection. */
    fun failAll(message: String) {
        pending.keys.toList().forEach { finish(it, failure = message) }
    }

    /** Waits for [requestId] to finish. An id this tracker never saw fails immediately. */
    suspend fun await(requestId: String): SessionCreationOutcome {
        // Checked under the lock [finish] holds, so a request is always either
        // pending or has a result: never neither, mid-completion.
        synchronized(lock) {
            _results.value[requestId]?.let { return it }
            if (!pending.containsKey(requestId)) {
                return SessionCreationOutcome.Failed(requestId, "Unknown session creation request.")
            }
        }
        return _results.mapNotNull { it[requestId] }.first()
    }

    private fun finish(requestId: String, sessionId: String? = null, failure: String? = null) {
        val outcome = if (sessionId != null) {
            SessionCreationOutcome.Created(requestId, sessionId)
        } else {
            SessionCreationOutcome.Failed(requestId, failure ?: "Session creation failed.")
        }
        val request = synchronized(lock) {
            val request = pending.remove(requestId) ?: return
            _results.value = (_results.value + (requestId to outcome)).entries
                .toList().takeLast(MAX_REMEMBERED).associate { it.key to it.value }
            request
        }
        request.timeout.cancel()
        request.arrival?.cancel()
        publishPending()
        _completions.tryEmit(outcome)
        if (outcome is SessionCreationOutcome.Created) {
            scope.launch { onReady(requestId, outcome.sessionId) }
        }
    }

    private fun publishPending() {
        _pendingIds.value = pending.keys.toSet()
    }

    companion object {
        const val TIMEOUT_MS = 30_000L
        private const val MAX_REMEMBERED = 32
    }
}
