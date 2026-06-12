package com.nimbalyst.app.data

import androidx.room.withTransaction

class NimbalystRepository(
    private val database: NimbalystDatabase
) {
    fun observeProjects() = database.projectDao().observeAll()

    fun observeActiveSessions() = database.sessionDao().observeActiveSessions()

    fun observeSessionsForProject(projectId: String) = database.sessionDao().observeSessionsForProject(projectId)

    fun observeSession(sessionId: String) = database.sessionDao().observeSession(sessionId)

    fun observeMessagesForSession(sessionId: String) =
        database.messageDao().observeLatestMessagesForSession(sessionId, MOBILE_SESSION_MESSAGE_LIMIT)

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

    suspend fun getCachedTranscriptPage(sessionId: String, cursorKey: Long): TranscriptPageEntity? =
        database.transcriptPageDao().getPage(sessionId, cursorKey)

    suspend fun saveTranscriptPage(page: TranscriptPageEntity) {
        database.withTransaction {
            database.transcriptPageDao().upsert(page)
            val count = database.transcriptPageDao().countForSession(page.sessionId)
            if (count > TRANSCRIPT_PAGE_CACHE_LIMIT) {
                database.transcriptPageDao().deleteOldest(page.sessionId, count - TRANSCRIPT_PAGE_CACHE_LIMIT)
            }
        }
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
        const val MOBILE_SESSION_MESSAGE_LIMIT = 60
        // ~600 pages x ~400 raw messages covers very deep scrollback while
        // bounding per-session cache growth (pages are a few hundred KB each).
        const val TRANSCRIPT_PAGE_CACHE_LIMIT = 600
    }
}
