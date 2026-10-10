package com.nimbalyst.app.sync

import android.util.Log
import androidx.annotation.VisibleForTesting
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.MessageEntity
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.QueuedPromptEntity
import com.nimbalyst.app.data.SessionEntity
import java.io.File
import java.util.concurrent.ConcurrentHashMap

internal data class ProcessedSessionEntry(
    val session: SessionEntity,
    val queuedPrompts: List<QueuedPromptEntity>?,
    val clearQueuedPrompts: Boolean,
)

/**
 * Turns decrypted wire entries into Room rows, merging each onto the row
 * already stored. Pure apart from two per-session caches: the last draft this
 * device pushed (to ignore self-echoes) and the newest client-metadata blob
 * seen from the server (so a draft push can carry the desktop's fields
 * forward). The blob is also stored on the row, which is what survives a
 * restart; the cache only covers a row write that has not landed yet.
 */
internal class SessionEntryDecoder(private val gson: Gson) {
    private val lastPushedDraftAt = ConcurrentHashMap<String, Long>()
    private val remoteClientMetadata = ConcurrentHashMap<String, JsonObject>()

    /** Fires when a session's server blob becomes known, so a draft held for lack of one can go out. */
    var onClientMetadataKnown: ((sessionId: String) -> Unit)? = null

    companion object {
        private const val TAG = "SessionEntryDecoder"

        /**
         * Returns true only when a remote draft update is newer than the last
         * draft push this device sent for the same session. Equal timestamps are
         * self-echoes from the server round trip and must not overwrite local
         * typing.
         */
        @VisibleForTesting
        internal fun shouldAcceptRemoteDraft(
            incomingDraftUpdatedAt: Long?,
            lastLocalPushAt: Long
        ): Boolean {
            val incomingTs = incomingDraftUpdatedAt ?: 0L
            return incomingTs > lastLocalPushAt
        }
    }

    /**
     * When this device's draft was last written: the stored stamp survives a
     * restart or account reconnect, the in-memory push time covers a push whose
     * row write has not landed. A remote draft must be strictly newer.
     */
    private fun localDraftAt(sessionId: String, existing: SessionEntity?): Long =
        maxOf(existing?.draftUpdatedAt ?: 0L, lastPushedDraftAt[sessionId] ?: 0L)

    fun recordDraftPush(sessionId: String, at: Long) {
        lastPushedDraftAt[sessionId] = at
    }

    /** The newest client-metadata blob known for [session], or null when the server's is unknown. */
    fun clientMetadataBase(session: SessionEntity): JsonObject? =
        remoteClientMetadata[session.id]?.deepCopy()
            ?: session.clientMetadataJson?.let { runCatching { gson.fromJson(it, JsonObject::class.java) }.getOrNull() }

    fun recordPublishedClientMetadata(sessionId: String, blob: JsonObject) {
        remoteClientMetadata[sessionId] = blob.deepCopy()
    }

    fun clear() {
        lastPushedDraftAt.clear()
        remoteClientMetadata.clear()
    }

    /**
     * Null [ProjectEntity.commandsJson]/[ProjectEntity.actionsJson] mean the
     * entry carried no readable config; the repository keeps the stored values
     * rather than blanking them for a stats-only broadcast. A config that is
     * present always yields both, "[]" when empty, and its
     * [ProjectEntity.localWikiFolder] is authoritative even when null.
     */
    fun decodeProject(entry: ServerProjectEntry, crypto: CryptoManager): ProjectEntity? {
        val projectId = crypto.decryptOrNull(entry.encryptedProjectId, entry.projectIdIv) ?: return null
        val configJson = crypto.decryptOrNull(entry.encryptedConfig, entry.configIv)
        val config = configJson?.let { gson.parseOrNull<ProjectConfig>(it, TAG) }
        val localWikiFolder = normalizeLocalWikiFolder(config?.localWiki?.folder)
        return ProjectEntity(
            id = projectId,
            name = File(projectId).name.ifBlank { projectId },
            sessionCount = entry.sessionCount ?: 0,
            lastUpdatedAt = entry.lastActivityAt,
            sortOrder = 0,
            commandsJson = config?.let { gson.toJson(it.commands.orEmpty()) },
            actionsJson = config?.let { gson.toJson(it.actions.orEmpty()) },
            gitRemoteHash = entry.gitRemoteHash,
            localWikiFolder = localWikiFolder,
            localWikiTypesJson = if (localWikiFolder == null) null else configJson?.let(::rawLocalWikiTypes),
        )
    }

    /**
     * [serverRow] marks an entry read from the server's stored row (a snapshot
     * or replication page), where no blob means the server has none. A
     * broadcast echoes the sender's message, which may simply have omitted it.
     */
    fun decodeSession(
        entry: ServerSessionEntry,
        crypto: CryptoManager,
        existing: SessionEntity?,
        serverRow: Boolean = false,
    ): ProcessedSessionEntry? {
        val projectId = crypto.decryptOrNull(entry.encryptedProjectId, entry.projectIdIv) ?: return null
        val titleDecrypted = crypto.decryptOrNull(entry.encryptedTitle, entry.titleIv)
        val clientMetadata = decodeClientMetadata(entry.sessionId, entry.encryptedClientMetadata, entry.clientMetadataIv, crypto)
        if (serverRow && entry.encryptedClientMetadata == null && existing?.clientMetadataJson == null) {
            recordRemote(entry.sessionId, JsonObject())
        }
        val remoteDraftInput = clientMetadata?.draftInput
        val draftInput = remoteDraftInput?.ifBlank { null }
        val acceptDraft = remoteDraftInput != null && shouldAcceptRemoteDraft(
            incomingDraftUpdatedAt = clientMetadata?.draftUpdatedAt,
            lastLocalPushAt = localDraftAt(entry.sessionId, existing)
        )

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
                parentSessionId = if (entry.parentSessionIdPresent) entry.parentSessionId else entry.parentSessionId ?: existing?.parentSessionId,
                agentRole = entry.agentRole ?: existing?.agentRole,
                createdBySessionId = if (entry.createdBySessionIdPresent) entry.createdBySessionId else entry.createdBySessionId ?: existing?.createdBySessionId,
                hostDeviceId = entry.hostDeviceId ?: existing?.hostDeviceId,
                // Transient and never stored by the server: an entry is a full
                // snapshot of the sender's view, so absent means none pending.
                pendingExecution = entry.pendingExecution?.takeUnless { entry.isExecuting == true },
                phase = clientMetadata?.phase ?: existing?.phase,
                tagsJson = clientMetadata?.tags?.takeIf { it.isNotEmpty() }?.let(gson::toJson) ?: existing?.tagsJson,
                worktreeId = entry.worktreeId ?: existing?.worktreeId,
                isArchived = entry.isArchived ?: existing?.isArchived ?: false,
                isPinned = entry.isPinned ?: existing?.isPinned ?: false,
                branchedFromSessionId = entry.branchedFromSessionId ?: existing?.branchedFromSessionId,
                branchPointMessageId = entry.branchPointMessageId ?: existing?.branchPointMessageId,
                branchedAt = entry.branchedAt ?: existing?.branchedAt,
                isExecuting = entry.isExecuting ?: existing?.isExecuting ?: false,
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
                // Read state only moves forward. The server's value can trail a
                // read this device has not published yet.
                lastReadAt = listOfNotNull(entry.lastReadAt, existing?.lastReadAt).maxOrNull(),
                lastMessageAt = entry.lastMessageAt ?: existing?.lastMessageAt,
                draftInput = if (acceptDraft) draftInput else existing?.draftInput,
                draftUpdatedAt = if (acceptDraft) {
                    clientMetadata?.draftUpdatedAt ?: existing?.draftUpdatedAt
                } else {
                    existing?.draftUpdatedAt
                },
                clientMetadataJson = remoteBlobJson(entry.sessionId) ?: existing?.clientMetadataJson
            ),
            queuedPrompts = decryptQueuedPrompts(entry.sessionId, entry.encryptedQueuedPrompts, crypto),
            clearQueuedPrompts = entry.queuedPromptCount == 0 || entry.encryptedQueuedPrompts?.isEmpty() == true
        )
    }

    /**
     * Versioned pages apply entries strictly: a title or metadata blob this
     * key cannot read makes the whole entry unreadable, rather than landing a
     * row with its phase, draft and context silently blanked.
     */
    fun isFullyReadable(entry: ServerSessionEntry, crypto: CryptoManager): Boolean {
        if (entry.encryptedTitle != null && entry.titleIv != null &&
            crypto.decryptOrNull(entry.encryptedTitle, entry.titleIv) == null
        ) return false
        if (entry.encryptedClientMetadata != null && entry.clientMetadataIv != null) {
            val json = crypto.decryptOrNull(entry.encryptedClientMetadata, entry.clientMetadataIv) ?: return false
            if (runCatching { gson.fromJson(json, JsonObject::class.java) }.getOrNull() == null) return false
        }
        return true
    }

    fun decodeMessage(entry: ServerMessageEntry, sessionId: String, crypto: CryptoManager): MessageEntity? {
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

    /** Applies a session room's metadata to the stored row. */
    fun mergeRoomMetadata(
        existing: SessionEntity,
        metadata: SessionRoomMetadata,
        crypto: CryptoManager,
        /** Broadcasts pass false: read state, execution and context must not reorder the list. */
        applyUpdatedAt: Boolean = true,
    ): SessionEntity {
        val sessionId = existing.id
        val clientMetadata = decodeClientMetadata(sessionId, metadata.encryptedClientMetadata, metadata.clientMetadataIv, crypto)
        val remoteDraftInput = clientMetadata?.draftInput
        val draftInput = remoteDraftInput?.ifBlank { null }
        // Current servers send only ciphertext; `title` is the legacy plaintext.
        val roomTitle = crypto.decryptOrNull(metadata.encryptedTitle, metadata.titleIv)
        val titleDecrypted = roomTitle
            ?: metadata.title
            ?: crypto.decryptOrNull(existing.titleEncrypted, existing.titleIv)
        val projectId = when {
            !metadata.encryptedProjectId.isNullOrBlank() && !metadata.projectIdIv.isNullOrBlank() ->
                crypto.decryptOrNull(metadata.encryptedProjectId, metadata.projectIdIv) ?: existing.projectId
            else -> existing.projectId
        }
        val acceptDraft = remoteDraftInput != null && shouldAcceptRemoteDraft(
            incomingDraftUpdatedAt = clientMetadata?.draftUpdatedAt,
            lastLocalPushAt = localDraftAt(sessionId, existing)
        )

        return existing.copy(
            projectId = projectId,
            // Outbound index updates pass the stored ciphertext through, so keep
            // it in step with the title it decrypts to.
            titleEncrypted = if (roomTitle != null) metadata.encryptedTitle else existing.titleEncrypted,
            titleIv = if (roomTitle != null) metadata.titleIv else existing.titleIv,
            titleDecrypted = titleDecrypted ?: existing.titleDecrypted,
            provider = metadata.provider ?: existing.provider,
            model = metadata.model ?: existing.model,
            mode = metadata.mode ?: existing.mode,
            isExecuting = metadata.isExecuting ?: existing.isExecuting,
            // Room metadata is partial: absent keeps the pending turn until the
            // desktop reports it running.
            pendingExecution = when {
                metadata.isExecuting == true -> null
                else -> metadata.pendingExecution ?: existing.pendingExecution
            },
            updatedAt = metadata.updatedAt?.takeIf { applyUpdatedAt } ?: existing.updatedAt,
            createdAt = metadata.createdAt ?: existing.createdAt,
            phase = clientMetadata?.phase ?: existing.phase,
            tagsJson = clientMetadata?.tags?.takeIf { it.isNotEmpty() }?.let(gson::toJson) ?: existing.tagsJson,
            hasQueuedPrompts = clientMetadata?.hasPendingPrompt ?: existing.hasQueuedPrompts,
            contextTokens = clientMetadata?.currentContext?.tokens ?: existing.contextTokens,
            contextWindow = clientMetadata?.currentContext?.contextWindow ?: existing.contextWindow,
            draftInput = if (acceptDraft) draftInput else existing.draftInput,
            draftUpdatedAt = if (acceptDraft) {
                clientMetadata?.draftUpdatedAt ?: existing.draftUpdatedAt
            } else {
                existing.draftUpdatedAt
            },
            clientMetadataJson = remoteBlobJson(sessionId) ?: existing.clientMetadataJson
        )
    }

    private fun remoteBlobJson(sessionId: String): String? = remoteClientMetadata[sessionId]?.let(gson::toJson)

    private fun recordRemote(sessionId: String, raw: JsonObject) {
        remoteClientMetadata[sessionId] = raw
        onClientMetadataKnown?.invoke(sessionId)
    }

    fun decryptQueuedPrompts(
        sessionId: String,
        encryptedPrompts: List<EncryptedQueuedPrompt>?,
        crypto: CryptoManager,
    ): List<QueuedPromptEntity>? {
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

    private fun decodeClientMetadata(
        sessionId: String,
        encryptedMetadata: String?,
        metadataIv: String?,
        crypto: CryptoManager,
    ): ClientMetadata? {
        val json = crypto.decryptOrNull(encryptedMetadata, metadataIv) ?: return null
        return try {
            val raw = gson.fromJson(json, JsonObject::class.java) ?: return null
            recordRemote(sessionId, raw)
            gson.fromJson(raw, ClientMetadata::class.java)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse ClientMetadata: ${e.message}")
            null
        }
    }
}
