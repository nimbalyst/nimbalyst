package com.nimbalyst.app.data

import androidx.room.withTransaction

class NimbalystRepository(
    private val database: NimbalystDatabase
) {
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
            if (projects.isNotEmpty()) {
                database.projectDao().upsertAll(projects)
            }
            if (sessions.isNotEmpty()) {
                database.sessionDao().upsertAll(sessions)
            }
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

    suspend fun reconcileIndexSnapshot(
        projects: List<ProjectEntity>,
        sessions: List<SessionEntity>,
        syncedAt: Long
    ) {
        database.withTransaction {
            val projectIds = projects.map { it.id }
            if (projectIds.isEmpty()) {
                database.projectDao().deleteAll()
            } else {
                database.projectDao().deleteNotIn(projectIds)
            }
            if (projects.isNotEmpty()) {
                database.projectDao().upsertAll(projects)
            }
            if (sessions.isNotEmpty()) {
                database.sessionDao().upsertAll(sessions)
            }
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
            database.sessionDao().upsertAll(listOf(session))
            database.projectDao().refreshProjectStats(session.projectId)
        }
    }

    suspend fun getSession(sessionId: String): SessionEntity? = database.sessionDao().getById(sessionId)

    suspend fun deleteSession(sessionId: String) {
        database.withTransaction {
            database.sessionDao().deleteById(sessionId)
            database.projectDao().refreshAllProjectStats()
        }
    }

    suspend fun persistSessionMessages(
        sessionId: String,
        messages: List<MessageEntity>,
        cursor: String?,
        lastSequence: Int,
        syncedAt: Long
    ) {
        database.withTransaction {
            if (messages.isNotEmpty()) {
                database.messageDao().upsertAll(messages)
            }
            database.sessionDao().updateSyncWatermark(
                sessionId = sessionId,
                lastSyncedSeq = lastSequence
            )
            database.syncStateDao().upsert(
                SyncStateEntity(
                    roomId = sessionId,
                    lastCursor = cursor,
                    lastSequence = lastSequence,
                    lastSyncedAt = syncedAt
                )
            )
            database.projectDao().refreshAllProjectStats()
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

    suspend fun updateDraftInput(sessionId: String, draftInput: String?, draftUpdatedAt: Long) {
        database.sessionDao().updateDraftInput(sessionId, draftInput, draftUpdatedAt)
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
        const val PROTOTYPE_PROJECT_ID = "/test/android"
    }
}
