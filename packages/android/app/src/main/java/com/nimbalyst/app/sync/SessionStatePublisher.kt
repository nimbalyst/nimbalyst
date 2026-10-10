package com.nimbalyst.app.sync

import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystRepository
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Per-session state this device owns and publishes: the composer draft and
 * the read marker. Both are written to Room first and published as
 * client-metadata patches; a send that does not land is parked in the
 * registry and republished from the row after reconnect, so a burst of
 * offline edits goes out once with what the row says then.
 *
 * A draft for a session whose server metadata blob is unknown stays local:
 * publishing it over a guess would erase the desktop's fields for every
 * device. It goes out when the decoder reports a blob for that session.
 */
internal class SessionStatePublisher(
    private val repository: NimbalystRepository,
    private val decoder: SessionEntryDecoder,
    private val indexUpdates: SessionIndexUpdates,
    private val crypto: () -> CryptoManager?,
    private val requests: SyncRequestRegistry,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val awaitingBlob = ConcurrentHashMap.newKeySet<String>()

    suspend fun updateDraft(sessionId: String, draftInput: String) {
        val now = clock()
        repository.getSession(sessionId) ?: return
        repository.updateDraftInput(sessionId, draftInput.ifBlank { null }, now)
        decoder.recordDraftPush(sessionId, now)
        publishDraft(sessionId)
    }

    /** Wired to [SessionEntryDecoder.onClientMetadataKnown]. */
    fun clientMetadataKnown(sessionId: String) {
        if (awaitingBlob.remove(sessionId)) scope.launch { publishDraft(sessionId) }
    }

    /** The account changed; held drafts belong to the old one. */
    fun clear() = awaitingBlob.clear()

    private suspend fun publishDraft(sessionId: String) {
        val json = draftJson(sessionId) ?: return
        requests.send(SyncRequestKind.DRAFT_PUSH, json, coalesceKey = "draft:$sessionId", rebuild = { draftJson(sessionId) })
    }

    suspend fun markRead(sessionId: String, readAt: Long) {
        repository.markSessionRead(sessionId, readAt)
        val json = readReceiptJson(sessionId) ?: return
        requests.send(SyncRequestKind.READ_RECEIPT, json, coalesceKey = "read:$sessionId", rebuild = { readReceiptJson(sessionId) })
    }

    private suspend fun draftJson(sessionId: String): String? {
        val crypto = crypto() ?: return null
        val session = repository.getSession(sessionId) ?: return null
        val base = decoder.clientMetadataBase(session)
        if (base == null) {
            awaitingBlob += sessionId
            return null
        }
        val update = indexUpdates.draft(
            session = session,
            draft = session.draftInput.orEmpty(),
            draftUpdatedAt = session.draftUpdatedAt ?: clock(),
            remoteClientMetadata = base,
            crypto = crypto
        )
        // The blob this publishes becomes the base for the next one, here and after a restart.
        decoder.recordPublishedClientMetadata(sessionId, update.clientMetadata)
        repository.updateClientMetadata(sessionId, update.clientMetadata.toString())
        return update.json
    }

    private suspend fun readReceiptJson(sessionId: String): String? {
        val session = repository.getSession(sessionId) ?: return null
        return indexUpdates.readReceipt(session, session.lastReadAt ?: return null)
    }
}
