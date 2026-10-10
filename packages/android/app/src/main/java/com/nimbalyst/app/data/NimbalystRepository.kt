package com.nimbalyst.app.data

import androidx.room.withTransaction

class NimbalystRepository(
    private val database: NimbalystDatabase
) {
    /** Versioned index replication bookkeeping, in the same database. */
    val indexReplication = IndexReplicationStore(database)

    fun observeProjects() = database.projectDao().observeAll()

    fun observeActiveSessions() = database.sessionDao().observeActiveSessions()

    fun observeSessionsForProject(projectId: String) = database.sessionDao().observeSessionsForProject(projectId)

    fun observeSession(sessionId: String) = database.sessionDao().observeSession(sessionId)

    fun observeMessagesForSession(sessionId: String) = database.messageDao().observeMessagesForSession(sessionId)

    fun observeQueuedPromptsForSession(sessionId: String) =
        database.queuedPromptDao().observeQueuedPromptsForSession(sessionId)

    suspend fun replaceIndexSnapshot(
        projects: List<ProjectEntity>,
        sessions: List<SessionEntity>,
        syncedAt: Long
    ) {
        database.withTransaction {
            upsertProjectsKeepingConfig(projects)
            upsertSessionsWithParents(sessions)
            database.projectDao().refreshAllProjectStats()
            database.syncStateDao().upsert(
                SyncStateEntity(
                    roomId = INDEX_SYNC_ROOM_ID,
                    lastCursor = null,
                    lastSequence = 0,
                    lastSyncedAt = syncedAt
                )
            )
        }
    }

    /**
     * A project entry without a readable config leaves the decoded config
     * fields null; the stored commands, actions and remote hash stand until an
     * entry carries new ones. Must run inside a transaction.
     */
    private suspend fun upsertProjectsKeepingConfig(projects: List<ProjectEntity>) {
        if (projects.isEmpty()) return
        val stored = database.projectDao().getByIds(projects.map { it.id }).associateBy { it.id }
        database.projectDao().upsertAll(
            projects.map { project ->
                val existing = stored[project.id] ?: return@map project
                project.copy(
                    commandsJson = project.commandsJson ?: existing.commandsJson,
                    actionsJson = project.actionsJson ?: existing.actionsJson,
                    gitRemoteHash = project.gitRemoteHash ?: existing.gitRemoteHash,
                    // A present config (commandsJson set) says whether there is a wiki; no config keeps it.
                    localWikiFolder = if (project.commandsJson != null) project.localWikiFolder else existing.localWikiFolder,
                    localWikiTypesJson = if (project.commandsJson != null) project.localWikiTypesJson else existing.localWikiTypesJson,
                )
            }
        )
    }

    /**
     * Sessions reference projects by foreign key, but the index can name a
     * project it has not sent (a broadcast for a new workspace, or a project
     * entry that failed to decrypt). A placeholder row keeps the write valid;
     * the next project entry for that id replaces it. Must run inside a
     * transaction.
     */
    private suspend fun upsertSessionsWithParents(sessions: List<SessionEntity>) {
        if (sessions.isEmpty()) return
        database.projectDao().insertIfMissing(
            sessions.map { it.projectId }.distinct().map(::placeholderProject)
        )
        database.sessionDao().upsertAll(sessions)
    }

    /**
     * Applies a complete project list. A project missing from it is pruned only
     * when no session, cached or incoming, still names it: deleting a
     * referenced project would cascade through that session's cached history,
     * and a truncated snapshot's missing sessions are still cached.
     */
    suspend fun reconcileIndexSnapshot(
        projects: List<ProjectEntity>,
        sessions: List<SessionEntity>,
        syncedAt: Long,
        /**
         * The snapshot is the server's whole session list: not truncated, and
         * every entry readable. Only then is a missing row evidence the session
         * is gone; otherwise it may just not have been sent or decrypted.
         */
        pruneSessions: Boolean = false,
    ) {
        database.withTransaction {
            if (pruneSessions) {
                val keepSessions = sessions.mapTo(HashSet()) { it.id }
                // Work only this device has (an unsent draft, an undelivered
                // local prompt) is not the server's to account for.
                database.sessionDao().idsWithoutLocalWork().filterNot { it in keepSessions }
                    // SQLite caps bound parameters; accounts can hold thousands of sessions.
                    .chunked(500)
                    .forEach { database.sessionDao().deleteByIds(it) }
            }
            val keep = (projects.map { it.id } + sessions.map { it.projectId }).distinct()
            if (keep.isEmpty()) {
                database.projectDao().deleteAllUnreferenced()
            } else {
                database.projectDao().deleteUnreferencedNotIn(keep)
            }
            upsertProjectsKeepingConfig(projects)
            upsertSessionsWithParents(sessions)
            database.projectDao().deleteUnreferencedProvisional()
            database.syncStateDao().deleteOrphanedSessionRooms()
            database.projectDao().refreshAllProjectStats()
            database.syncStateDao().upsert(
                SyncStateEntity(
                    roomId = INDEX_SYNC_ROOM_ID,
                    lastCursor = null,
                    lastSequence = 0,
                    lastSyncedAt = syncedAt
                )
            )
        }
    }

    suspend fun upsertSession(session: SessionEntity) {
        database.withTransaction {
            upsertSessionsWithParents(listOf(session))
            database.projectDao().refreshProjectStats(session.projectId)
        }
    }

    suspend fun getSession(sessionId: String): SessionEntity? = database.sessionDao().getById(sessionId)

    /** Reads many rows in bounded batches rather than one query per id. */
    suspend fun getSessions(sessionIds: Collection<String>): Map<String, SessionEntity> =
        sessionIds.distinct().chunked(500)
            .flatMap { database.sessionDao().getByIds(it) }
            .associateBy { it.id }

    suspend fun deleteSession(sessionId: String) {
        database.withTransaction {
            val projectId = database.sessionDao().getById(sessionId)?.projectId ?: return@withTransaction
            database.sessionDao().deleteById(sessionId)
            database.syncStateDao().deleteOrphanedSessionRooms()
            database.projectDao().deleteUnreferencedProvisional()
            // Only this session's project changed; a delete broadcast must not
            // recount every project.
            database.projectDao().refreshProjectStats(projectId)
        }
    }

    /** Applies one project entry, e.g. a project broadcast, recounting only that project. */
    suspend fun upsertProject(project: ProjectEntity) {
        database.withTransaction {
            upsertProjectsKeepingConfig(listOf(project))
            database.projectDao().refreshProjectStats(project.id)
        }
    }

    /**
     * Stores room messages and moves the resume watermark (`sync_state.lastSequence`),
     * which means "every message up to here is stored" and is where the next
     * sync request starts.
     *
     * [historyThrough] is the end of a history page: the server returned every
     * message up to it, so the watermark may jump there. Live messages pass
     * null and only extend the watermark when they are contiguous with it; a
     * live message past a gap must never let a resume skip the gap.
     *
     * Returns false, storing nothing, when the session row has not landed yet.
     */
    suspend fun persistSessionMessages(
        sessionId: String,
        messages: List<MessageEntity>,
        cursor: String?,
        historyThrough: Int?,
        syncedAt: Long
    ): Boolean {
        return database.withTransaction {
            // Messages reference their session. A room can deliver before the
            // index row lands; the caller re-requests once the row commits.
            database.sessionDao().getById(sessionId) ?: return@withTransaction false
            if (messages.isNotEmpty()) {
                database.messageDao().upsertAll(messages)
                database.sessionDao().updateSyncWatermark(sessionId, messages.maxOf { it.sequence })
            }
            val previous = database.syncStateDao().getByRoomId(sessionId)
            var watermark = maxOf(historyThrough ?: 0, previous?.lastSequence ?: 0)
            val delivered = messages.map { it.sequence }.toSortedSet()
            while (delivered.contains(watermark + 1)) watermark++
            database.syncStateDao().upsert(
                SyncStateEntity(
                    roomId = sessionId,
                    lastCursor = cursor ?: previous?.lastCursor,
                    lastSequence = watermark,
                    lastSyncedAt = syncedAt
                )
            )
            // No project stats refresh: messages change neither a project's
            // session count nor its sessions' updatedAt.
            true
        }
    }

    suspend fun replaceRemoteQueuedPrompts(
        sessionId: String,
        prompts: List<QueuedPromptEntity>
    ) {
        database.withTransaction {
            database.queuedPromptDao().deleteRemoteForSession(sessionId)
            if (prompts.isNotEmpty()) {
                database.queuedPromptDao().upsertAll(prompts)
            }
        }
    }

    suspend fun clearRemoteQueuedPrompts(sessionId: String) {
        database.withTransaction {
            database.queuedPromptDao().deleteRemoteForSession(sessionId)
        }
    }

    suspend fun upsertQueuedPrompt(prompt: QueuedPromptEntity) {
        database.withTransaction {
            database.queuedPromptDao().upsert(prompt)
        }
    }

    suspend fun syncState(roomId: String): SyncStateEntity? = database.syncStateDao().getByRoomId(roomId)

    suspend fun markSessionRead(
        sessionId: String,
        lastReadAt: Long
    ) {
        database.withTransaction {
            database.sessionDao().updateLastReadAt(sessionId, lastReadAt)
        }
    }

    suspend fun setSessionArchived(sessionId: String, isArchived: Boolean) {
        database.withTransaction {
            val session = database.sessionDao().getById(sessionId) ?: return@withTransaction
            database.sessionDao().updateArchived(sessionId, isArchived)
            // Archived sessions leave the project's count.
            database.projectDao().refreshProjectStats(session.projectId)
        }
    }

    suspend fun setSessionParent(sessionId: String, parentSessionId: String?) {
        database.sessionDao().updateParent(sessionId, parentSessionId)
    }

    suspend fun updateDraftInput(sessionId: String, draftInput: String?, draftUpdatedAt: Long) {
        database.sessionDao().updateDraftInput(sessionId, draftInput, draftUpdatedAt)
    }

    suspend fun updateClientMetadata(sessionId: String, clientMetadataJson: String) {
        database.sessionDao().updateClientMetadata(sessionId, clientMetadataJson)
    }

    suspend fun messageCount(sessionId: String): Int =
        database.messageDao().countForSession(sessionId)

    suspend fun maxMessageSequence(sessionId: String): Int =
        database.messageDao().maxSequenceForSession(sessionId)

    suspend fun clearPrototypeData() {
        database.withTransaction {
            database.projectDao().deleteById(PROTOTYPE_PROJECT_ID)
        }
    }

    companion object {
        const val INDEX_SYNC_ROOM_ID = "index"

        /**
         * Older builds seeded a demo project into every new install. Removed on
         * connect and on unpair so existing installs lose it.
         */
        const val PROTOTYPE_PROJECT_ID = "/test/android"

        internal fun placeholderProject(projectId: String) = ProjectEntity(
            id = projectId,
            name = projectId.trimEnd('/').substringAfterLast('/').ifBlank { projectId },
            sessionCount = 0,
            lastUpdatedAt = null,
            sortOrder = 0,
            isProvisional = true
        )
    }
}
