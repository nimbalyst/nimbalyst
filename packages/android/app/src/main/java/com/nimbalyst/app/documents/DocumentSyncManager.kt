package com.nimbalyst.app.documents

import android.util.Log
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.sync.WebSocketClient
import com.nimbalyst.app.sync.WebSocketFactory
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URI
import java.util.concurrent.Callable
import java.util.concurrent.atomic.AtomicBoolean

/** Who document rooms connect as. Routing ids and the crypto key follow the index room's. */
data class DocumentSyncAccount(
    val serverUrl: String,
    val authToken: String,
    val orgId: String,
    val userId: String,
    val crypto: CryptoManager,
    /** Changes when the key changes (re-pair); a new key means a new account cache. */
    val cryptoIdentity: String,
) {
    /**
     * Names the account's cache and outbox. It includes the server: the same
     * ids paired to another server must not reuse (and replay) this outbox.
     */
    val accountKey: String get() = "${normalizedServerUrl(serverUrl)}|$legacyAccountKey"

    /** The key before it included the server; only used to find files left under it. */
    internal val legacyAccountKey: String get() = "$orgId:$userId:$cryptoIdentity"

    fun roomId(projectId: String): String = "org:$orgId:user:$userId:project:${sha256Hex(projectId)}"
}

/** Scheme and host lowercased, `ws(s)` read as `http(s)`, default port and trailing slash dropped. */
internal fun normalizedServerUrl(url: String): String {
    val trimmed = url.trim().trimEnd('/')
    val uri = runCatching { URI(trimmed) }.getOrNull()
    val host = uri?.host?.lowercase() ?: return trimmed.lowercase()
    val scheme = when (val raw = uri.scheme?.lowercase()) {
        "ws" -> "http"
        "wss" -> "https"
        else -> raw
    }
    val defaultPort = (scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80)
    val port = if (uri.port == -1 || defaultPort) "" else ":${uri.port}"
    return "$scheme://$host$port${uri.rawPath.orEmpty().trimEnd('/')}"
}

data class RemoteDocumentUpdate(val projectId: String, val syncId: String, val markdown: String)

/**
 * A save is durable on this device once it returns [Sent] or [Queued]: the
 * content and its outbox entry commit in one transaction. Neither means the
 * server has it; the entry stays until a manifest diff confirms it.
 */
sealed interface SaveOutcome {
    /** Handed to the open socket; awaiting the server's confirmation. */
    data object Sent : SaveOutcome
    /** The room is closed; sent when it reconnects. */
    data object Queued : SaveOutcome
    data class Failed(val message: String) : SaveOutcome
}

/** Keeps a project's room open while held. [release] is idempotent. */
class ProjectLease internal constructor(private val onRelease: () -> Unit) {
    private val released = AtomicBoolean(false)

    fun release() {
        if (released.compareAndSet(false, true)) onRelease()
    }
}

/**
 * Syncs project files with each project's `ProjectSyncRoom`, one socket per
 * project, mirroring iOS `DocumentSyncManager`:
 *
 *  - Room: `org:{org}:user:{uid}:project:{sha256(projectId)}`.
 *  - On connect: a manifest of cached files, answered by batched
 *    `projectSyncResponse` messages that must arrive in order within
 *    [transferTimeoutMs] of each other.
 *  - Content, delete, and Yjs broadcasts update the cache.
 *  - Saves push the whole encrypted markdown; the server keeps the last write.
 *  - Every push or delete is committed to a persisted outbox with the content
 *    it describes. The server sends no ack, so an entry is removed only when
 *    a later manifest diff shows the server holds it; unconfirmed entries are
 *    resent, and a sync round after each resend confirms them.
 *  - A room is open only while a screen holds a [ProjectLease] and the app is
 *    in the foreground.
 *
 * All state is touched only on [dispatcher], which must run one task at a time.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DocumentSyncManager internal constructor(
    private val scope: CoroutineScope,
    private val dispatcher: CoroutineDispatcher,
    private val openDatabase: (DocumentSyncAccount) -> DocumentsDatabase,
    private val socketFactory: WebSocketFactory? = null,
    private val transferTimeoutMs: Long = 30_000L,
    private val reconnectDelayMs: Long = 3_000L,
    private val verifyDelayMs: Long = 1_500L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private class ProjectConnection(val client: WebSocketClient) {
        var connected = false
        /** Consecutive sync rounds that had to push something; bounded so a server that drops writes cannot loop. */
        var pushRounds = 0
        var verifyJob: Job? = null
    }

    private var account: DocumentSyncAccount? = null
    /** False until the first [setAccount]: a cold start is still resolving the account, not signed out. */
    private val signedIn = MutableStateFlow<Boolean?>(null)
    private val databases = mutableMapOf<String, DocumentsDatabase>()
    private val connections = mutableMapOf<String, ProjectConnection>()
    /** Lease counts by project; a held project reopens after an account change or a return to the foreground. */
    private val holders = mutableMapOf<String, Int>()
    private var suspended = false
    private val transfers = mutableMapOf<String, DocumentSyncTransfer>()
    private val transferTimeouts = mutableMapOf<String, Job>()
    /** The hashes each outstanding sync request reported, answered by the current transfer. */
    private val manifests = mutableMapOf<String, Map<String, String>>()
    private val findings = mutableMapOf<String, TransferFindings>()
    /** Verification rounds keep a Ready project Ready instead of flashing "Syncing". */
    private val quietTransfers = mutableSetOf<String>()
    private val unsaved = UnsavedEdits()

    private val _states = MutableStateFlow<Map<String, DocumentSyncState>>(emptyMap())
    val states: StateFlow<Map<String, DocumentSyncState>> = _states.asStateFlow()

    /** Edits a closing editor handed over that could not be saved on this device. The content is kept until one succeeds. */
    val saveFailures: StateFlow<List<DocumentSaveFailure>> = unsaved.failures

    private val _database = MutableStateFlow<DocumentsDatabase?>(null)
    private val _remoteUpdates = MutableSharedFlow<RemoteDocumentUpdate>(extraBufferCapacity = 16)

    /** Content pushed by another device, already decrypted. An open editor refreshes from it. */
    val remoteUpdates: SharedFlow<RemoteDocumentUpdate> = _remoteUpdates.asSharedFlow()

    fun state(projectId: String): DocumentSyncState = _states.value[projectId] ?: DocumentSyncState.Connecting

    // region Observation

    fun observeDocuments(projectId: String): Flow<List<DocumentSummary>> =
        _database.flatMapLatest { it?.documentsDao()?.observeSummaries(projectId) ?: flowOf(emptyList()) }

    fun observeDocument(projectId: String, relativePath: String): Flow<SyncedDocument?> =
        _database.flatMapLatest { it?.documentsDao()?.observeDocumentByPath(projectId, relativePath) ?: flowOf(null) }

    fun observeOutboxCount(projectId: String): Flow<Int> =
        _database.flatMapLatest { it?.documentsDao()?.observeOutboxCount(projectId) ?: flowOf(0) }

    /**
     * Whether [relativePath] can be opened. Unlike a single lookup, this waits
     * out a cold start (account and key still resolving, project still
     * syncing) and only reports [DocumentAvailability.Missing] once the
     * project's transfer has finished without the file.
     */
    fun observeAvailability(projectId: String, relativePath: String): Flow<DocumentAvailability> =
        combine(observeDocument(projectId, relativePath), signedIn, _states) { document, signedIn, states ->
            when {
                document != null -> DocumentAvailability.Available(document)
                signedIn == null -> DocumentAvailability.Waiting
                !signedIn -> DocumentAvailability.Failed(SIGNED_OUT)
                else -> when (val state = states[projectId]) {
                    DocumentSyncState.Ready -> DocumentAvailability.Missing
                    is DocumentSyncState.Failed -> DocumentAvailability.Failed(state.message)
                    else -> DocumentAvailability.Waiting
                }
            }
        }

    // endregion

    // region Connection

    /**
     * Sets or clears the account. A token refresh keeps open sockets and
     * reconnects only the rooms that are down; any other change moves every
     * open room to the new account and its own cache.
     */
    fun setAccount(next: DocumentSyncAccount?) = onDispatcher { applyAccount(next) }

    internal fun applyAccount(next: DocumentSyncAccount?) {
        val previous = account
        account = next
        signedIn.value = next != null
        if (next == null) {
            closeAll()
            _database.value = null
            return
        }
        if (previous != null && previous.accountKey == next.accountKey) {
            if (previous.authToken == next.authToken) return
            for ((projectId, connection) in connections.toMap()) {
                connection.client.updateAuthToken(next.authToken)
                if (!connection.connected || state(projectId) is DocumentSyncState.Failed) restart(projectId)
            }
            return
        }
        closeAll()
        _database.value = databases.getOrPut(next.accountKey) { openDatabase(next) }
        holders.keys.toList().forEach(::connect)
        // Edits a closing editor could not save while signed out belong to this account only.
        unsaved.retry(next.accountKey, ::save)
    }

    /**
     * Holds [projectId]'s room open until the lease is released; rooms are
     * reference-counted, so a list and an editor on the same project share
     * one socket. Asking before the account is known is fine: the room opens
     * once it arrives.
     */
    fun acquireProject(projectId: String): ProjectLease {
        onDispatcher {
            holders[projectId] = (holders[projectId] ?: 0) + 1
            connect(projectId)
        }
        return ProjectLease { onDispatcher { release(projectId) } }
    }

    private fun release(projectId: String) {
        val count = holders[projectId] ?: return
        if (count > 1) {
            holders[projectId] = count - 1
        } else {
            holders -= projectId
            close(projectId)
        }
    }

    fun retryProject(projectId: String) = onDispatcher { restart(projectId) }

    /** The app went to the background: close every room. Leases and the outbox stay. */
    fun suspendConnections() = onDispatcher {
        suspended = true
        closeAll()
    }

    /** Back in the foreground: reopen every held room. */
    fun resumeConnections() = onDispatcher {
        suspended = false
        holders.keys.toList().forEach(::connect)
    }

    private fun restart(projectId: String) {
        close(projectId)
        connect(projectId)
    }

    private fun connect(projectId: String) {
        if (suspended || projectId !in holders) return
        val current = account ?: run {
            // Before the first account arrives this is a cold start, not a sign-out.
            if (signedIn.value == null) setState(projectId, DocumentSyncState.Connecting) else failProject(projectId, SIGNED_OUT)
            return
        }
        connections[projectId]?.let { existing ->
            // Already open or opening (the client reconnects on its own); only
            // a failed room is torn down and reopened.
            if (state(projectId) !is DocumentSyncState.Failed) {
                existing.client.ensureConnected()
                return
            }
            close(projectId)
        }
        setState(projectId, DocumentSyncState.Connecting)
        scheduleTransferTimeout(projectId)

        val client = socketFactory?.let { WebSocketClient(scope, reconnectDelayMs, it) }
            ?: WebSocketClient(scope, reconnectDelayMs)
        val connection = ProjectConnection(client)
        connections[projectId] = connection
        val isCurrent = { connections[projectId] === connection }

        client.onConnectionStateChanged = { connected ->
            onDispatcher {
                if (!isCurrent()) return@onDispatcher
                connection.connected = connected
                if (connected) onConnected(projectId)
            }
        }
        client.onFailure = { message ->
            onDispatcher { if (isCurrent()) failProject(projectId, "File sync lost its connection: $message") }
        }
        client.onHttpError = { code ->
            if (code == 401) {
                onDispatcher { if (isCurrent()) failProject(projectId, "File sync needs a fresh sign-in. Please retry.") }
            }
        }
        client.onTextMessage = { text, _ ->
            onDispatcher { if (isCurrent()) handleMessage(text, projectId) }
        }
        client.connect(current.serverUrl, current.roomId(projectId), current.authToken, tag = projectId)
    }

    private fun close(projectId: String) {
        connections.remove(projectId)?.let { connection ->
            connection.verifyJob?.cancel()
            connection.client.disconnect()
        }
        transferTimeouts.remove(projectId)?.cancel()
        transfers.remove(projectId)
        manifests.remove(projectId)
        findings.remove(projectId)
        quietTransfers.remove(projectId)
        _states.update { it - projectId }
        // The outbox stays: the next connect's manifest diff decides what to resend.
    }

    private fun closeAll() {
        connections.keys.toList().forEach(::close)
    }

    private fun onConnected(projectId: String) {
        connections[projectId]?.pushRounds = 0
        requestSync(projectId, quiet = false)
    }

    // endregion

    // region Transfer

    internal fun beginTransfer(projectId: String, quiet: Boolean = false) {
        transfers[projectId] = DocumentSyncTransfer()
        findings[projectId] = TransferFindings()
        if (quiet && state(projectId) == DocumentSyncState.Ready) {
            quietTransfers += projectId
        } else {
            quietTransfers -= projectId
            setState(projectId, DocumentSyncState.Syncing(0))
        }
        scheduleTransferTimeout(projectId)
    }

    private fun scheduleTransferTimeout(projectId: String) {
        transferTimeouts.remove(projectId)?.cancel()
        transferTimeouts[projectId] = scope.launch(dispatcher) {
            delay(transferTimeoutMs)
            transferTimeouts.remove(projectId)
            failProject(projectId, "File sync timed out before finishing. Please retry.")
        }
    }

    private fun failProject(projectId: String, message: String) {
        transferTimeouts.remove(projectId)?.cancel()
        setState(projectId, DocumentSyncState.Failed(message))
        Log.e(TAG, "[DocSync] $projectId: $message")
    }

    private fun setState(projectId: String, state: DocumentSyncState) {
        _states.update { it + (projectId to state) }
    }

    /**
     * Sends the cache's manifest. The answer both downloads what changed and,
     * by what it leaves out, confirms the outbox (see [reconcileOutbox]).
     */
    private fun requestSync(projectId: String, quiet: Boolean) {
        val connection = connections[projectId]?.takeIf { it.connected } ?: return
        val database = _database.value ?: return
        beginTransfer(projectId, quiet)
        val sent = runCatching {
            val summaries = database.documentsDao().summaries(projectId)
            manifests[projectId] = summaries.associate { it.syncId to it.contentHash.orEmpty() }
            val manifest = summaries.map {
                ProjectSyncManifestEntry(it.syncId, it.contentHash.orEmpty(), it.lastModifiedAt ?: 0, it.hasYjs, it.yjsSeq)
            }
            connection.client.sendRaw(DocumentSyncWire.encode(ProjectSyncRequestMessage(manifest)))
        }
        if (sent.getOrNull() != true) {
            failProject(projectId, "Could not request files. Please retry.")
        }
    }

    /** A verification round shortly after a live push, coalescing a burst of saves. */
    private fun scheduleVerify(projectId: String) {
        val connection = connections[projectId] ?: return
        connection.verifyJob?.cancel()
        connection.verifyJob = scope.launch(dispatcher) {
            delay(verifyDelayMs)
            // A transfer in flight already ends in a reconcile that covers this push.
            if (connections[projectId] === connection && projectId !in manifests) requestSync(projectId, quiet = true)
        }
    }

    // endregion

    // region Inbound

    internal fun handleMessage(text: String, projectId: String) {
        if (state(projectId) is DocumentSyncState.Failed) return
        val message = runCatching { parseObject(text) }.getOrElse {
            failProject(projectId, "File sync received an unreadable message. Please retry.")
            return
        }
        when (message.optString("type")) {
            "projectSyncResponse" -> handleSyncResponse(message, projectId)
            "fileContentBroadcast" -> handleContentBroadcast(message, projectId)
            "fileDeleteBroadcast" -> withSyncId(message) { syncId ->
                withDatabase { database ->
                    // A pending push would resurrect the file another device just deleted.
                    database.runInTransaction {
                        database.documentsDao().delete(projectId, listOf(syncId))
                        database.documentsDao().clearOutbox(projectId, syncId)
                    }
                }
            }
            "fileYjsInitBroadcast" -> withSyncId(message) { syncId ->
                withDatabase { it.documentsDao().markYjs(projectId, syncId, clock()) }
            }
            "fileYjsUpdateBroadcast" -> withSyncId(message) { syncId ->
                val sequence = runCatching { message.requireLong("sequence") }.getOrNull() ?: return@withSyncId
                withDatabase { it.documentsDao().advanceYjsSeq(projectId, syncId, sequence, clock()) }
            }
            "error" -> failProject(projectId, message.optString("message") ?: "File sync failed. Please retry.")
            else -> Unit
        }
    }

    private fun handleSyncResponse(message: com.google.gson.JsonObject, projectId: String) {
        val crypto = account?.crypto
        val database = _database.value
        if (crypto == null || database == null) {
            failProject(projectId, "File sync is waiting for sign-in. Please retry after connecting.")
            return
        }
        try {
            val response = ProjectSyncResponse.parse(message)
            val transfer = (transfers[projectId] ?: DocumentSyncTransfer()).accept(response)
            applyDocumentSyncBatch(response, projectId, crypto, database, clock())
            transfers[projectId] = transfer
            findings.getOrPut(projectId, ::TransferFindings).add(response)
            if (transfer.complete) {
                transferTimeouts.remove(projectId)?.cancel()
                quietTransfers -= projectId
                setState(projectId, DocumentSyncState.Ready)
                reconcileOutbox(projectId)
            } else {
                if (projectId !in quietTransfers) setState(projectId, DocumentSyncState.Syncing(transfer.received))
                scheduleTransferTimeout(projectId)
            }
        } catch (error: DocumentSyncException) {
            failProject(projectId, error.message ?: "File sync received an invalid batch. Please retry.")
        } catch (error: Exception) {
            Log.e(TAG, "[DocSync] Batch failed", error)
            failProject(projectId, "Could not read or save downloaded files. Please retry.")
        }
    }

    private fun handleContentBroadcast(message: com.google.gson.JsonObject, projectId: String) {
        val crypto = account?.crypto ?: return
        val entry = runCatching { ProjectSyncFileEntry.from(message, hasYjsDefault = false) }.getOrElse {
            Log.e(TAG, "[DocSync] Malformed file content broadcast", it)
            return
        }
        val document = withDatabase { applyContentBroadcast(entry, projectId, crypto, it, clock()) } ?: return
        document.contentDecrypted?.let { _remoteUpdates.tryEmit(RemoteDocumentUpdate(projectId, document.syncId, it)) }
    }

    private inline fun withSyncId(message: com.google.gson.JsonObject, block: (String) -> Unit) {
        message.optString("syncId")?.let(block)
    }

    private inline fun <T> withDatabase(block: (DocumentsDatabase) -> T): T? {
        val database = _database.value ?: return null
        return try {
            block(database)
        } catch (error: Exception) {
            Log.e(TAG, "[DocSync] Failed to apply broadcast", error)
            null
        }
    }

    // endregion

    // region Outbound

    /**
     * Settles what the finished transfer confirmed, then resends the rest and
     * anything the server asked for, followed by a sync round to confirm them.
     * Runs only for a transfer that answers this manager's own manifest.
     */
    private fun reconcileOutbox(projectId: String) {
        val manifest = manifests.remove(projectId) ?: return
        val found = findings.remove(projectId) ?: return
        val database = _database.value ?: return
        val dao = database.documentsDao()
        val toSend = try {
            val plan = planOutboxReconciliation(dao.outbox(projectId), manifest, found)
            if (plan.settled.isNotEmpty()) dao.dequeue(plan.settled)
            plan.resend + plan.pushFromCache.mapNotNull { queueCachedPush(projectId, it, database) }
        } catch (error: Exception) {
            Log.e(TAG, "[DocSync] Could not reconcile the outbox for $projectId", error)
            return
        }
        val connection = connections[projectId]?.takeIf { it.connected } ?: return
        if (toSend.isEmpty()) {
            connection.pushRounds = 0
            return
        }
        if (++connection.pushRounds > MAX_PUSH_ROUNDS) {
            // Left queued: the next connect tries again.
            Log.w(TAG, "[DocSync] Server has not taken ${toSend.size} write(s) for $projectId after $MAX_PUSH_ROUNDS rounds")
            return
        }
        if (toSend.all { connection.client.sendRaw(it.payload) }) requestSync(projectId, quiet = true)
    }

    /** Queues the cached copy of a file the server says is newer here, e.g. after the server expired its copy. */
    private fun queueCachedPush(projectId: String, syncId: String, database: DocumentsDatabase): DocumentOutboxEntry? {
        val crypto = account?.crypto ?: return null
        val document = database.documentsDao().document(projectId, syncId) ?: return null
        val content = document.contentDecrypted?.let(crypto::encrypt)
        val encryptedContent = content?.encrypted ?: document.encryptedContent ?: return null
        val contentIv = content?.iv ?: document.contentIv ?: return null
        val hash = document.contentHash ?: return null
        val modifiedAt = document.lastModifiedAt ?: clock()
        val payload = pushPayload(crypto, document, encryptedContent, contentIv, hash, modifiedAt)
        val entry = outboxEntry(projectId, syncId, OutboxKind.PUSH, payload, hash, modifiedAt)
        return entry.copy(id = database.documentsDao().enqueue(entry))
    }

    /** Hands an already-committed entry to an open room, or leaves it for the next connect. */
    private fun sendNow(projectId: String, entry: DocumentOutboxEntry): SaveOutcome {
        val connection = connections[projectId]?.takeIf { it.connected } ?: return SaveOutcome.Queued
        if (!connection.client.sendRaw(entry.payload)) return SaveOutcome.Queued
        scheduleVerify(projectId)
        return SaveOutcome.Sent
    }

    /**
     * Saves [markdown] as the document's whole content: the local cache and
     * its outbox entry in one transaction, then an encrypted `fileContentPush`.
     * Last write wins on the server.
     */
    suspend fun saveDocument(projectId: String, relativePath: String, markdown: String): SaveOutcome =
        withContext(dispatcher) { save(projectId, relativePath, markdown) }

    /**
     * [saveDocument] for a caller that is going away, e.g. an editor being
     * closed. The content is held in memory until a save succeeds; a failure
     * lands in [saveFailures], and a signed-out edit is retried when the same
     * account signs back in.
     */
    fun saveInBackground(projectId: String, relativePath: String, markdown: String) = onDispatcher {
        unsaved.save(account?.accountKey, projectId, relativePath, markdown, ::save)
    }

    fun retrySave(failure: DocumentSaveFailure) = onDispatcher {
        unsaved.retryOne(failure, account?.accountKey, ::save)
    }

    /** Drops a failed edit the user has copied or no longer wants. */
    fun discardUnsaved(failure: DocumentSaveFailure) = onDispatcher { unsaved.discard(failure) }

    internal fun save(projectId: String, relativePath: String, markdown: String): SaveOutcome {
        val current = account ?: return SaveOutcome.Failed(SIGNED_OUT)
        val database = _database.value ?: return SaveOutcome.Failed(SIGNED_OUT)
        val dao = database.documentsDao()
        return try {
            val document = dao.documentByPath(projectId, relativePath)
                ?: return SaveOutcome.Failed("This file is no longer synced.")
            val now = clock()
            val hash = sha256Hex(markdown)
            val content = current.crypto.encrypt(markdown)
            val payload = pushPayload(current.crypto, document, content.encrypted, content.iv, hash, now)
            val entry = database.runInTransaction(
                Callable {
                    dao.upsert(
                        document.copy(
                            contentDecrypted = markdown,
                            encryptedContent = null,
                            contentIv = null,
                            contentHash = hash,
                            lastModifiedAt = now,
                            updatedAt = now,
                        )
                    )
                    val entry = outboxEntry(projectId, document.syncId, OutboxKind.PUSH, payload, hash, now)
                    entry.copy(id = dao.enqueue(entry))
                }
            )
            sendNow(projectId, entry)
        } catch (error: Exception) {
            Log.e(TAG, "[DocSync] Failed to save $relativePath", error)
            SaveOutcome.Failed("Could not save this file on this device.")
        }
    }

    fun deleteFile(projectId: String, syncId: String) = onDispatcher {
        val dao = _database.value?.documentsDao() ?: return@onDispatcher
        val payload = DocumentSyncWire.encode(FileDeleteMessage(syncId))
        val entry = outboxEntry(projectId, syncId, OutboxKind.DELETE, payload, contentHash = null, clock())
        runCatching { dao.enqueue(entry) }
            .onSuccess { sendNow(projectId, entry.copy(id = it)) }
            .onFailure { Log.e(TAG, "[DocSync] Could not queue the delete of $syncId", it) }
    }

    private fun outboxEntry(
        projectId: String,
        syncId: String,
        kind: OutboxKind,
        payload: String,
        contentHash: String?,
        modifiedAt: Long,
    ) = DocumentOutboxEntry(
        projectId = projectId,
        syncId = syncId,
        kind = kind,
        payload = payload,
        contentHash = contentHash,
        lastModifiedAt = modifiedAt,
        createdAt = clock(),
    )

    // endregion

    // region Reading

    /**
     * The document's markdown, decrypted on demand and cached. An edit that
     * could not be saved yet wins over the cache. Null when missing or
     * undecryptable.
     */
    suspend fun documentContent(projectId: String, relativePath: String): String? = withContext(dispatcher) {
        val crypto = account?.crypto ?: return@withContext null
        unsaved.content(account?.accountKey, projectId, relativePath)?.let { return@withContext it }
        val database = _database.value ?: return@withContext null
        val document = database.documentsDao().documentByPath(projectId, relativePath) ?: return@withContext null
        decryptDocumentContent(document, crypto, database, clock())
    }

    suspend fun document(projectId: String, relativePath: String): SyncedDocument? = withContext(dispatcher) {
        _database.value?.documentsDao()?.documentByPath(projectId, relativePath)
    }

    /**
     * The document at [relativePath], connecting the project's room to pull it
     * if it is not cached yet (a transcript link to a file the session just
     * created). Polls the cache until [timeoutMs], like iOS `awaitDocument`.
     */
    suspend fun awaitDocument(projectId: String, relativePath: String, timeoutMs: Long = 8_000L): SyncedDocument? {
        document(projectId, relativePath)?.let { return it }
        val lease = acquireProject(projectId)
        try {
            var waited = 0L
            while (waited < timeoutMs) {
                delay(AWAIT_POLL_MS)
                waited += AWAIT_POLL_MS
                document(projectId, relativePath)?.let { return it }
            }
            return document(projectId, relativePath)
        } finally {
            lease.release()
        }
    }

    // endregion

    private fun onDispatcher(block: () -> Unit) {
        scope.launch(dispatcher) { block() }
    }

    private companion object {
        const val TAG = "DocumentSync"
        const val AWAIT_POLL_MS = 300L
        const val MAX_PUSH_ROUNDS = 3
        const val SIGNED_OUT = "File sync is waiting for sign-in. Please retry after connecting."
    }
}
