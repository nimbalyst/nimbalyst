package com.nimbalyst.app.sync

import android.util.Log
import com.google.gson.Gson
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystRepository
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/**
 * Applies messages from a session room. [handle] takes the session id of the
 * socket the message arrived on, never the currently active session: by the
 * time a message is applied the user may have opened another one.
 */
internal class SessionRoomHandler(
    private val repository: NimbalystRepository,
    private val decoder: SessionEntryDecoder,
    private val gson: Gson,
    private val crypto: () -> CryptoManager?,
    private val state: MutableStateFlow<SyncConnectionState>,
    private val signals: ExecutionSignals,
    private val scope: CoroutineScope,
    /** Re-requests a room's history, through the session ingestion queue. */
    private val requestCatchUp: (sessionId: String) -> Unit,
    /** Asks the index for a session row that has not arrived yet. */
    private val lookup: (sessionId: String) -> Unit,
    private val send: (sessionId: String, json: String) -> Boolean,
) {
    private val awaitingRow = ConcurrentHashMap<String, Job>()
    private val lastMetadataUpdatedAt = ConcurrentHashMap<String, Long>()

    suspend fun handle(message: String, sessionId: String) {
        when (val type = gson.parseOrNull<ServerMessageEnvelope>(message, TAG)?.type) {
            "syncResponse" -> handleSyncResponse(message, sessionId)
            "messageBroadcast" -> handleMessageBroadcast(message, sessionId)
            "metadataBroadcast" -> handleMetadataBroadcast(message, sessionId)
            "error" -> handleServerError(message)
            null -> Log.w(TAG, "Session message with no type field")
            else -> Log.d(TAG, "Unhandled session message type: $type")
        }
    }

    suspend fun requestSync(sessionId: String, explicitSinceSeq: Int? = null) {
        val sinceSeq = explicitSinceSeq ?: repository.syncState(sessionId)?.lastSequence
        val effectiveSinceSeq = sinceSeq?.takeIf { it > 0 }
        Log.d(TAG, "[requestSync] sessionId=$sessionId sinceSeq=$effectiveSinceSeq")
        send(sessionId, gson.toJson(SessionSyncRequest(sinceSeq = effectiveSinceSeq)))
    }

    private suspend fun handleSyncResponse(message: String, sessionId: String) {
        val crypto = crypto() ?: return
        val response = gson.parseOrNull<SessionSyncResponse>(message, TAG) ?: return
        Log.d(TAG, "[syncResponse] ${response.messages.size} messages, hasMore=${response.hasMore} for $sessionId")
        response.metadata?.let { mergeMetadata(sessionId, it, crypto) }

        val decryptedMessages = response.messages.mapNotNull { decoder.decodeMessage(it, sessionId, crypto) }
        // The page covers every row the server returned, readable or not:
        // asking again cannot make an unreadable message readable. The next
        // page follows the server's cursor, never the highest sequence seen,
        // which may be a live message past the rest of history.
        val pageEnd = response.cursor?.toIntOrNull() ?: response.messages.maxOfOrNull { it.sequence }
        val syncedAt = System.currentTimeMillis()

        val persisted = repository.persistSessionMessages(
            sessionId = sessionId,
            messages = decryptedMessages,
            cursor = response.cursor,
            historyThrough = pageEnd,
            syncedAt = syncedAt
        )
        if (!persisted) {
            Log.w(TAG, "[syncResponse] $sessionId is not in the index yet; history is requested again when it lands")
            catchUpWhenRowLands(sessionId)
            return
        }
        state.update { it.copy(lastSessionSyncAt = syncedAt, lastError = null) }

        if (response.hasMore && pageEnd != null) {
            requestSync(sessionId, pageEnd)
        }
    }

    private suspend fun handleMessageBroadcast(message: String, sessionId: String) {
        val crypto = crypto() ?: return
        val broadcast = gson.parseOrNull<MessageBroadcast>(message, TAG) ?: return
        val decrypted = decoder.decodeMessage(broadcast.message, sessionId, crypto) ?: return
        val persisted = repository.persistSessionMessages(
            sessionId = sessionId,
            messages = listOf(decrypted),
            cursor = null,
            historyThrough = null,
            syncedAt = System.currentTimeMillis()
        )
        if (!persisted) catchUpWhenRowLands(sessionId)
    }

    /**
     * The room delivered before the index row. Nothing was stored, so once
     * the row commits the room's history is requested again from the
     * watermark. Observes the committed row: a snapshot, a broadcast or a
     * lookup can each be the write that lands it.
     */
    private fun catchUpWhenRowLands(sessionId: String) {
        if (awaitingRow.containsKey(sessionId)) return
        awaitingRow[sessionId] = scope.launch {
            repository.observeSession(sessionId).first { it != null }
            awaitingRow.remove(sessionId)
            requestCatchUp(sessionId)
        }
        lookup(sessionId)
    }

    /** Another account may connect next. */
    fun clear() {
        awaitingRow.values.forEach { it.cancel() }
        awaitingRow.clear()
        lastMetadataUpdatedAt.clear()
    }

    /**
     * `updatedAt` is the only ordering signal a metadata broadcast carries. A
     * replayed executing:true after the executing:false already applied would
     * otherwise restart a finished turn (iOS #NIM-5924).
     */
    private suspend fun handleMetadataBroadcast(message: String, sessionId: String) {
        val crypto = crypto() ?: return
        val broadcast = gson.parseOrNull<MetadataBroadcast>(message, TAG) ?: return
        broadcast.metadata.updatedAt?.let { updatedAt ->
            if (updatedAt <= (lastMetadataUpdatedAt[sessionId] ?: Long.MIN_VALUE)) {
                Log.i(TAG, "Ignoring metadata broadcast for $sessionId at $updatedAt: not newer than what is applied")
                return
            }
            lastMetadataUpdatedAt[sessionId] = updatedAt
        }
        mergeMetadata(sessionId, broadcast.metadata, crypto, applyUpdatedAt = false)
    }

    private suspend fun mergeMetadata(
        sessionId: String,
        metadata: SessionRoomMetadata,
        crypto: CryptoManager,
        applyUpdatedAt: Boolean = true,
    ) {
        val existing = repository.getSession(sessionId) ?: return
        val merged = decoder.mergeRoomMetadata(existing, metadata, crypto, applyUpdatedAt)
        repository.upsertSession(merged)
        metadata.encryptedQueuedPrompts?.let { encrypted ->
            val prompts = decoder.decryptQueuedPrompts(sessionId, encrypted, crypto)
            if (prompts == null) repository.clearRemoteQueuedPrompts(sessionId) else repository.replaceRemoteQueuedPrompts(sessionId, prompts)
        }
        signals.committed(existing, merged)
    }

    private fun handleServerError(message: String) {
        val serverError = gson.parseOrNull<ServerErrorMessage>(message, TAG) ?: return
        state.update { it.copy(lastError = "${serverError.code}: ${serverError.message}") }
    }

    private companion object {
        const val TAG = "SessionRoomHandler"
    }
}
