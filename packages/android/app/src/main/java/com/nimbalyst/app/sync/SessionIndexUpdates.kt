package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonNull
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.SessionEntity

/**
 * Builds the index messages the phone sends for its own edits. Each
 * publishes a write already committed to Room, built from the row read at send
 * time so a republish after reconnect sends what the row says now. Mirrors
 * iOS `SessionIndexUpdates`.
 */
internal class SessionIndexUpdates(private val gson: Gson) {

    data class DraftUpdate(val json: String, val clientMetadata: JsonObject)

    /**
     * Queues a prompt. This has to be a full indexUpdate (only it carries
     * queued prompts), so it is built from the row read at send time. No
     * message count: the phone may not have synced the transcript, and the
     * server keeps its own count when none is sent.
     */
    fun prompt(session: SessionEntity, prompt: EncryptedQueuedPrompt, crypto: CryptoManager): String = encode(
        base(session, crypto, updatedAt = prompt.timestamp).copy(
            lastMessageAt = prompt.timestamp,
            queuedPromptCount = 1,
            encryptedQueuedPrompts = listOf(prompt)
        )
    )

    /**
     * Publishes the composer draft as a client-metadata patch. An empty [draft]
     * is sent explicitly: an omitted draft means "unchanged" and other devices
     * would keep the old text.
     *
     * The server stores `encryptedClientMetadata` as one opaque blob and
     * replaces it whole, so the draft is written into the last blob seen from
     * the server ([remoteClientMetadata]). Sending only the draft would erase
     * the desktop's context usage, pending-prompt flag and naming marker for
     * every device until the desktop next republished them (NIM-7281). Fields
     * this build does not know about are carried through untouched. There is
     * no fallback built from the row: the caller holds the draft until a blob
     * is known.
     *
     * Prompts and moves ([prompt], [parent]) carry no blob at all, which the
     * server treats as "keep the stored one".
     */
    fun draft(
        session: SessionEntity,
        draft: String,
        draftUpdatedAt: Long,
        remoteClientMetadata: JsonObject,
        crypto: CryptoManager,
    ): DraftUpdate {
        val blob = remoteClientMetadata.deepCopy()
        blob.addProperty("draftInput", draft)
        blob.addProperty("draftUpdatedAt", draftUpdatedAt)
        val encrypted = crypto.encrypt(gson.toJson(blob))
        val json = gson.toJson(
            IndexClientMetadataPatchMessage(
                patch = IndexClientMetadataPatch(
                    sessionId = session.id,
                    encryptedClientMetadata = encrypted.encrypted,
                    clientMetadataIv = encrypted.iv
                )
            )
        )
        return DraftUpdate(json, blob)
    }

    /** Publishes the read marker, and nothing else. */
    fun readReceipt(session: SessionEntity, lastReadAt: Long): String = gson.toJson(
        IndexClientMetadataPatchMessage(patch = IndexClientMetadataPatch(sessionId = session.id, lastReadAt = lastReadAt))
    )

    /**
     * Publishes a move into (or out of) a workstream. Without this the desktop
     * reasserts the old parent on the next index page and the move silently
     * undoes itself. The row's own updatedAt is kept so a move does not
     * reorder the list.
     */
    fun parent(session: SessionEntity, parentSessionId: String?, crypto: CryptoManager): String {
        val entry = base(session, crypto, updatedAt = session.updatedAt).copy(parentSessionId = parentSessionId)
        val message = gson.toJsonTree(IndexUpdateMessage(session = entry)).asJsonObject
        if (parentSessionId == null) message.getAsJsonObject("session").add("parentSessionId", JsonNull.INSTANCE)
        return message.toString()
    }

    private fun base(session: SessionEntity, crypto: CryptoManager, updatedAt: Long): IndexUpdateEntry {
        // Pass the stored title ciphertext through, and re-encrypt only when we
        // have plaintext but no ciphertext, so a push never blanks the title.
        var encryptedTitle = session.titleEncrypted
        var titleIv = session.titleIv
        if (encryptedTitle == null && session.titleDecrypted != null) {
            val encrypted = crypto.encrypt(session.titleDecrypted)
            encryptedTitle = encrypted.encrypted
            titleIv = encrypted.iv
        }
        return IndexUpdateEntry(
            sessionId = session.id,
            encryptedProjectId = crypto.encryptProjectId(session.projectId),
            projectIdIv = CryptoManager.projectIdIvBase64,
            encryptedTitle = encryptedTitle,
            titleIv = titleIv,
            provider = session.provider ?: "claude-code",
            model = session.model,
            mode = session.mode,
            messageCount = null,
            lastMessageAt = session.lastMessageAt ?: session.updatedAt,
            createdAt = session.createdAt,
            updatedAt = updatedAt,
            // Execution belongs to the desktop; the phone's cached value may
            // predate a turn that started while this edit was in flight.
            isExecuting = null,
            sessionType = session.sessionType
        )
    }

    private fun encode(entry: IndexUpdateEntry): String = gson.toJson(IndexUpdateMessage(session = entry))
}
