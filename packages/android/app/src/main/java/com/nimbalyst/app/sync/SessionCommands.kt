package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystRepository
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Session controls and edits the phone sends to the index room: cancel,
 * archive, reparent, worktree creation and interactive prompt responses.
 * Every control is addressed to the session's host (`hostDeviceId`); without a
 * target the server broadcasts it and every connected desktop acts on it.
 *
 * Archive and reparent are optimistic local writes: the row changes first and
 * the registry republishes it after a reconnect if the send did not land.
 * Cancel and prompt responses are never replayed.
 */
internal class SessionCommands(
    private val repository: NimbalystRepository,
    private val gson: Gson,
    private val indexUpdates: SessionIndexUpdates,
    private val deviceId: () -> String,
    private val crypto: () -> CryptoManager?,
    private val requests: SyncRequestRegistry,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** Host per session, for the non-suspending control path. Warmed on read. */
    private val hostBySession = ConcurrentHashMap<String, String>()

    /** Caches [sessionId]'s host so [sendControlNow] can address it without a DB read. */
    suspend fun warmHost(sessionId: String) {
        repository.getSession(sessionId)?.hostDeviceId?.let { hostBySession[sessionId] = it }
    }

    /** Suspending control send: reads the session's host from Room. */
    suspend fun sendControl(sessionId: String, messageType: String, payload: JsonObject? = null): Result<Unit> {
        warmHost(sessionId)
        return sendControlNow(sessionId, messageType, payload)
    }

    /**
     * Control send for callers that cannot suspend (interactive prompt
     * responses). Uses the cached host; an uncached session is broadcast, which
     * is what every control did before hosts were known.
     */
    fun sendControlNow(sessionId: String, messageType: String, payload: JsonObject? = null): Result<Unit> =
        landed(requests.send(SyncRequestKind.SESSION_CONTROL, controlJson(sessionId, messageType, payload, hostBySession[sessionId])))

    suspend fun cancelSession(sessionId: String): Result<Unit> = sendControl(sessionId, "cancel")

    /**
     * Writes the flag locally first, then asks the host to propagate it. A
     * failure means the send did not land now; the row keeps the change and it
     * is republished, as the row then says, after reconnect.
     */
    suspend fun setSessionArchived(sessionId: String, isArchived: Boolean): Result<Unit> {
        repository.setSessionArchived(sessionId, isArchived)
        val json = archiveJson(sessionId) ?: return Result.failure(IllegalStateException("Session not found."))
        return landed(
            requests.send(
                SyncRequestKind.ARCHIVE, json,
                coalesceKey = "archive:$sessionId",
                rebuild = { archiveJson(sessionId) }
            )
        )
    }

    /**
     * Writes the parent locally first, then publishes it; republished after
     * reconnect if it did not land. Clears carry explicit null; the desktop
     * validates the move and publishes the authoritative parent and manager.
     */
    suspend fun updateSessionParent(sessionId: String, parentSessionId: String?): Result<Unit> {
        repository.setSessionParent(sessionId, parentSessionId)
        val json = parentJson(sessionId) ?: return Result.failure(IllegalStateException("Session not found."))
        return landed(
            requests.send(
                SyncRequestKind.REPARENT, json,
                coalesceKey = "parent:$sessionId",
                rebuild = { parentJson(sessionId) }
            )
        )
    }

    /**
     * Asks a desktop to create a git worktree. The worktree session arrives
     * through the index; the response only says whether the desktop tried.
     * No answer within the registry timeout is reported as a timeout.
     */
    fun createWorktree(projectId: String, targetDeviceId: String? = null): Result<String> {
        val crypto = crypto() ?: return Result.failure(IllegalStateException("Sync is not ready."))
        val requestId = UUID.randomUUID().toString()
        val json = gson.toJson(
            CreateWorktreeRequestMessage(
                request = CreateWorktreeRequest(
                    requestId = requestId,
                    encryptedProjectId = crypto.encryptProjectId(projectId),
                    projectIdIv = CryptoManager.projectIdIvBase64,
                    timestamp = clock()
                ),
                targetDeviceId = targetDeviceId
            )
        )
        return if (requests.request(SyncRequestKind.CREATE_WORKTREE, requestId, json)) {
            Result.success(requestId)
        } else {
            Result.failure(IllegalStateException("Failed to send the worktree request."))
        }
    }

    fun receiveWorktreeResponse(response: CreateWorktreeResponse) {
        requests.resolve(
            response.requestId,
            detail = if (response.success) null else response.error ?: "The desktop could not create the worktree."
        )
    }

    /** Another account may connect next; nothing cached for this one may address it. */
    fun clear() {
        hostBySession.clear()
    }

    private suspend fun archiveJson(sessionId: String): String? {
        val session = repository.getSession(sessionId) ?: return null
        session.hostDeviceId?.let { hostBySession[sessionId] = it }
        val payload = JsonObject().apply { addProperty("isArchived", session.isArchived) }
        return controlJson(sessionId, "archive", payload, session.hostDeviceId)
    }

    private suspend fun parentJson(sessionId: String): String? {
        val crypto = crypto() ?: return null
        val session = repository.getSession(sessionId) ?: return null
        return indexUpdates.parent(session, session.parentSessionId, crypto)
    }

    private fun controlJson(sessionId: String, messageType: String, payload: JsonObject?, targetDeviceId: String?) =
        gson.toJson(
            SessionControlMessage(
                message = SessionControlPayload(
                    sessionId = sessionId,
                    messageType = messageType,
                    payload = payload,
                    timestamp = clock(),
                    sentByDeviceId = deviceId(),
                    targetDeviceId = targetDeviceId
                )
            )
        )

    private fun landed(accepted: Boolean): Result<Unit> =
        if (accepted) Result.success(Unit) else Result.failure(IllegalStateException("The desktop is not connected."))
}
