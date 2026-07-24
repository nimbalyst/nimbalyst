package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface QueuedPromptDao {
    @Query("SELECT * FROM queued_prompts WHERE sessionId = :sessionId ORDER BY createdAt ASC")
    fun observeQueuedPromptsForSession(sessionId: String): Flow<List<QueuedPromptEntity>>

    @Query(
        """
        DELETE FROM queued_prompts
        WHERE sessionId = :sessionId
          AND (source IS NOT NULL OR sentAt IS NOT NULL)
        """
    )
    suspend fun deleteRemoteForSession(sessionId: String)

    @Upsert
    suspend fun upsertAll(prompts: List<QueuedPromptEntity>)

    @Upsert
    suspend fun upsert(prompt: QueuedPromptEntity)
}
