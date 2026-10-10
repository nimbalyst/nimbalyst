package com.nimbalyst.app.sync

import android.util.Log
import androidx.annotation.VisibleForTesting
import com.google.gson.Gson
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.IndexReplicationStore
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.SessionEntity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/**
 * Applies messages from the index room. Called only from the index
 * [SyncIngestionQueue], so handlers run one at a time in arrival order.
 */
internal class IndexMessageHandler(
    private val repository: NimbalystRepository,
    private val decoder: SessionEntryDecoder,
    private val gson: Gson,
    private val crypto: () -> CryptoManager?,
    private val state: MutableStateFlow<SyncConnectionState>,
    private val connectedDevices: MutableStateFlow<List<DeviceInfo>>,
    private val settings: SettingsSyncApplier,
    private val indexRequests: IndexSyncRequests,
    private val creations: SessionCreationTracker,
    private val commands: SessionCommands,
    private val signals: ExecutionSignals,
    private val errors: SyncErrors,
    /** The room answered our `ping`: everything sent before it arrived. */
    private val onPong: () -> Unit = {},
    /** The versioned replication driver for the current connection, if any. */
    private val replication: () -> IndexReplicationClient? = { null },
) {
    companion object {
        private const val TAG = "IndexMessageHandler"

        /**
         * Applies an index snapshot to [repository], choosing between the
         * pruning path ([NimbalystRepository.reconcileIndexSnapshot]) and the
         * safe upsert-only path ([NimbalystRepository.replaceIndexSnapshot]).
         *
         * The gate: if [projects].size < [rawProjectCount], one or more entries
         * failed to decrypt. Pruning in that case would silently wipe
         * stale-but-valid cache entries. We fall back to upsert-only so those
         * entries survive until the next clean snapshot arrives.
         */
        @VisibleForTesting
        internal suspend fun applyIndexSnapshot(
            repository: NimbalystRepository,
            projects: List<ProjectEntity>,
            sessions: List<SessionEntity>,
            rawProjectCount: Int,
            syncedAt: Long,
            sessionsComplete: Boolean = false,
        ) {
            val canPrune = projects.size == rawProjectCount
            if (canPrune) {
                repository.reconcileIndexSnapshot(
                    projects = projects,
                    sessions = sessions,
                    syncedAt = syncedAt,
                    pruneSessions = sessionsComplete
                )
            } else {
                Log.w(
                    TAG,
                    "[handleIndexSyncResponse] decrypted ${projects.size}/$rawProjectCount project entries;" +
                        " skipping prune to avoid wiping stale-but-valid cache entries"
                )
                repository.replaceIndexSnapshot(
                    projects = projects,
                    sessions = sessions,
                    syncedAt = syncedAt
                )
            }
        }
    }

    suspend fun handle(message: String) {
        when (val type = parse<ServerMessageEnvelope>(message)?.type) {
            "indexSyncResponse" -> handleIndexSyncResponse(message)
            "indexBroadcast" -> handleIndexBroadcast(message)
            "indexDeleteBroadcast" -> handleIndexDeleteBroadcast(message)
            "projectBroadcast" -> handleProjectBroadcast(message)
            "indexPageResponse" -> parse<IndexPageResponse>(message)?.let { replication()?.handlePage(it) }
            "indexChangesAvailable" -> parse<IndexChangesAvailable>(message)?.let { replication()?.handleChangesAvailable(it.revision) }
            "createSessionResponseBroadcast" -> handleCreateSessionResponse(message)
            "createWorktreeResponseBroadcast" -> parse<CreateWorktreeResponseBroadcast>(message)
                ?.let { commands.receiveWorktreeResponse(it.response) }
            "settingsSyncBroadcast" -> handleSettingsSyncBroadcast(message)
            "devicesList" -> handleDevicesList(message)
            "deviceJoined" -> handleDeviceJoined(message)
            "deviceLeft" -> handleDeviceLeft(message)
            "error" -> handleServerError(message)
            "pong" -> onPong()
            null -> Log.w(TAG, "Index message with no type field")
            else -> Log.d(TAG, "Unhandled index message type: $type")
        }
    }

    private suspend fun handleIndexSyncResponse(message: String) {
        val crypto = crypto() ?: return
        val response = parse<IndexSyncResponse>(message) ?: return
        indexRequests.responseReceived()
        val rawProjectCount = response.projects.size
        val projects = response.projects.mapNotNull { decoder.decodeProject(it, crypto) }
        val previous = repository.getSessions(response.sessions.map { it.sessionId })
        val sessions = response.sessions.mapNotNull { entry ->
            decoder.decodeSession(entry, crypto, previous[entry.sessionId], serverRow = true)
        }
        val health = SnapshotHealth.of(response, readableSessions = sessions.size, readableProjects = projects.size)
        val syncedAt = System.currentTimeMillis()
        applyIndexSnapshot(
            repository = repository,
            projects = projects,
            sessions = sessions.map { it.session },
            rawProjectCount = rawProjectCount,
            syncedAt = syncedAt,
            sessionsComplete = health.isComplete
        )
        sessions.forEach {
            syncQueuedPrompts(it)
            signals.committed(previous[it.session.id], it.session)
        }
        state.update {
            it.copy(
                lastIndexSyncAt = syncedAt,
                lastError = null,
                unreadableSessionCount = health.unreadableSessions,
                encryptionMismatch = health.encryptionMismatch
            )
        }
        reportUnreadable(health.unreadableSessions, health.encryptionMismatch)
    }

    private fun reportUnreadable(unreadable: Int, encryptionMismatch: Boolean) {
        if (unreadable == 0) return
        errors.report(
            SyncErrorKind.DECRYPT,
            if (encryptionMismatch) {
                "None of your sessions could be read with this device's key. Pair this device with your desktop again."
            } else {
                "$unreadable sessions could not be read with this device's key."
            }
        )
    }

    private suspend fun handleIndexBroadcast(message: String) {
        val crypto = crypto() ?: return
        val broadcast = parse<IndexBroadcast>(message) ?: return
        val existing = repository.getSession(broadcast.session.sessionId)
        decoder.decodeSession(broadcast.session, crypto, existing)?.let { processed ->
            repository.upsertSession(processed.session)
            syncQueuedPrompts(processed)
            signals.committed(existing, processed.session)
        }
    }

    private suspend fun handleIndexDeleteBroadcast(message: String) {
        val broadcast = parse<IndexDeleteBroadcast>(message) ?: return
        repository.deleteSession(broadcast.sessionId)
    }

    private suspend fun handleProjectBroadcast(message: String) {
        val crypto = crypto() ?: return
        val broadcast = parse<ProjectBroadcast>(message) ?: return
        val project = decoder.decodeProject(broadcast.project, crypto) ?: return
        repository.upsertProject(project)
    }

    /** Only this device's requests complete; other devices' answers are ignored. */
    private fun handleCreateSessionResponse(message: String) {
        val broadcast = parse<CreateSessionResponseBroadcast>(message) ?: return
        creations.receive(broadcast.response)
    }

    private fun handleSettingsSyncBroadcast(message: String) {
        val broadcast = parse<SettingsSyncBroadcast>(message) ?: return
        val settingsJson = crypto()?.decryptOrNull(
            broadcast.settings.encryptedSettings,
            broadcast.settings.settingsIv
        ) ?: return
        if (!settings.accept(broadcast.settings, parse<SyncedSettings>(settingsJson) ?: return)) {
            Log.i(TAG, "Ignoring settings from ${broadcast.settings.deviceId}: not newer than what is applied")
            return
        }
        state.update { it.copy(lastError = null) }
    }

    private fun handleDevicesList(message: String) {
        val devices = parsePresence<DevicesListMessage>(message)?.devices ?: return
        connectedDevices.value = devices
        errors.clear(SyncErrorKind.PRESENCE)
    }

    private fun handleDeviceJoined(message: String) {
        val device = parsePresence<DeviceJoinedMessage>(message)?.device ?: return
        connectedDevices.update { current ->
            if (current.any { it.deviceId == device.deviceId }) current else current + device
        }
    }

    private fun handleDeviceLeft(message: String) {
        val deviceId = parse<DeviceLeftMessage>(message)?.deviceId ?: return
        connectedDevices.update { current -> current.filterNot { it.deviceId == deviceId } }
    }

    /**
     * Reports what a replicated page committed: execution signals and sync
     * time. Queue changes were written in the page's own transaction, and a
     * stale revision is not in [committed], so neither can describe something
     * that did not land.
     */
    suspend fun afterReplicatedPage(previous: Map<String, SessionEntity>, committed: List<SessionEntity>) {
        committed.forEach { signals.committed(previous[it.id], it) }
        val skipped = repository.indexReplication.skippedRowCount()
        state.update { it.copy(lastIndexSyncAt = System.currentTimeMillis(), lastError = null, unreadableSessionCount = skipped) }
    }

    /** A bootstrap proved complete coverage: only now can "nothing was readable" mean the key is wrong. */
    fun bootstrapFinalized(result: IndexReplicationStore.Finalization) {
        val mismatch = SnapshotHealth.isEncryptionMismatch(result.readableSessions, result.unreadableSessions)
        state.update { it.copy(encryptionMismatch = mismatch) }
        reportUnreadable(result.unreadableSessions, mismatch)
    }

    private fun handleServerError(message: String) {
        val serverError = parse<ServerErrorMessage>(message) ?: return
        // A failed page request belongs to the replication driver, not the banner.
        if (replication()?.handleError(serverError.code, serverError.requestId) == true) return
        state.update { it.copy(lastError = "${serverError.code}: ${serverError.message}") }
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

    private inline fun <reified T> parse(json: String): T? = gson.parseOrNull(json, TAG)

    private inline fun <reified T> parsePresence(json: String): T? = parse<T>(json) ?: run {
        errors.report(SyncErrorKind.PRESENCE, SyncErrorKind.PRESENCE.coalescedMessage)
        null
    }
}

internal inline fun <reified T> Gson.parseOrNull(json: String, tag: String): T? {
    return try {
        fromJson(json, T::class.java)
    } catch (e: Exception) {
        Log.w(tag, "Failed to parse ${T::class.java.simpleName}: ${e.message}")
        null
    }
}
