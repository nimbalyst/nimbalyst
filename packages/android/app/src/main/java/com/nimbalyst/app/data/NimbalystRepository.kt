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

    suspend fun upsertProject(project: ProjectEntity) {
        database.projectDao().upsertAll(listOf(project))
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

    suspend fun appendLocalSubmittedPrompt(
        sessionId: String,
        promptId: String,
        promptText: String,
        createdAt: Long
    ) {
        if (promptText.isBlank()) return
        database.withTransaction {
            val session = database.sessionDao().getById(sessionId) ?: return@withTransaction
            val nextSequence = database.messageDao().maxSequenceForSession(sessionId) + 1
            database.messageDao().upsertAll(
                listOf(
                    MessageEntity(
                        id = "mobile-local-$promptId",
                        sessionId = sessionId,
                        sequence = nextSequence,
                        source = "mobile",
                        direction = "input",
                        contentDecrypted = promptText,
                        metadataJson = """{"localEcho":true,"queuedPromptId":"$promptId"}""",
                        createdAt = createdAt
                    )
                )
            )
            database.sessionDao().upsertAll(
                listOf(
                    session.copy(
                        updatedAt = createdAt,
                        lastMessageAt = createdAt
                    )
                )
            )
            database.projectDao().refreshProjectStats(session.projectId)
        }
    }

    suspend fun replaceRemoteQueuedPrompts(
        sessionId: String,
        prompts: List<QueuedPromptEntity>,
        pruneLocalEchoesCreatedBefore: Long? = null
    ) {
        database.withTransaction {
            database.queuedPromptDao().deleteRemoteForSession(sessionId)
            if (prompts.isNotEmpty()) {
                database.queuedPromptDao().upsertAll(prompts)
            }
            if (pruneLocalEchoesCreatedBefore != null) {
                pruneLocalSubmittedPromptsLocked(
                    sessionId = sessionId,
                    activePromptIds = prompts.map { it.id },
                    createdBefore = pruneLocalEchoesCreatedBefore
                )
            }
        }
    }

    suspend fun clearRemoteQueuedPrompts(
        sessionId: String,
        pruneLocalEchoesCreatedBefore: Long? = null
    ) {
        database.withTransaction {
            database.queuedPromptDao().deleteRemoteForSession(sessionId)
            if (pruneLocalEchoesCreatedBefore != null) {
                pruneLocalSubmittedPromptsLocked(
                    sessionId = sessionId,
                    activePromptIds = emptyList(),
                    createdBefore = pruneLocalEchoesCreatedBefore
                )
            }
        }
    }

    suspend fun pruneLocalSubmittedPrompts(
        sessionId: String,
        activePromptIds: List<String>,
        createdBefore: Long
    ) {
        database.withTransaction {
            pruneLocalSubmittedPromptsLocked(
                sessionId = sessionId,
                activePromptIds = activePromptIds,
                createdBefore = createdBefore
            )
        }
    }

    suspend fun pruneOrphanedLocalSubmittedPrompts(createdBefore: Long) {
        database.withTransaction {
            database.messageDao().deleteOrphanedLocalEchoesCreatedBefore(createdBefore)
        }
    }

    private suspend fun pruneLocalSubmittedPromptsLocked(
        sessionId: String,
        activePromptIds: List<String>,
        createdBefore: Long
    ) {
        if (activePromptIds.isEmpty()) {
            database.messageDao().deleteLocalEchoesForSessionCreatedBefore(
                sessionId = sessionId,
                createdBefore = createdBefore
            )
            return
        }

        database.messageDao().deleteLocalEchoesExceptCreatedBefore(
            sessionId = sessionId,
            activeLocalEchoIds = activePromptIds.map { "mobile-local-$it" },
            createdBefore = createdBefore
        )
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
        // Keep normal-sized agent sessions projectable from local raw rows.
        // SessionDetailScreen switches to desktop-projected tails above 5,000
        // rows, so fetching one extra row lets that path detect oversized
        // sessions while allowing sessions below the threshold to render fully.
        const val MOBILE_SESSION_MESSAGE_LIMIT = 5_001
        // ~600 pages x ~400 raw messages covers very deep scrollback while
        // bounding per-session cache growth (pages are a few hundred KB each).
        const val TRANSCRIPT_PAGE_CACHE_LIMIT = 600
    }
}
