package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE sessionId = :sessionId ORDER BY sequence ASC")
    fun observeMessagesForSession(sessionId: String): Flow<List<MessageEntity>>

    @Query(
        """
        SELECT * FROM (
            SELECT * FROM messages
            WHERE sessionId = :sessionId
            ORDER BY sequence DESC
            LIMIT :limit
        )
        ORDER BY sequence ASC
        """
    )
    fun observeLatestMessagesForSession(sessionId: String, limit: Int): Flow<List<MessageEntity>>

    @Query("SELECT COUNT(*) FROM messages WHERE sessionId = :sessionId")
    suspend fun countForSession(sessionId: String): Int

    @Query("SELECT COALESCE(MAX(sequence), 0) FROM messages WHERE sessionId = :sessionId")
    suspend fun maxSequenceForSession(sessionId: String): Int

    @Query("DELETE FROM messages WHERE sessionId = :sessionId")
    suspend fun deleteForSession(sessionId: String)

    @Query(
        """
        DELETE FROM messages
        WHERE sessionId = :sessionId
          AND id LIKE 'mobile-local-%'
          AND createdAt <= :createdBefore
        """
    )
    suspend fun deleteLocalEchoesForSessionCreatedBefore(
        sessionId: String,
        createdBefore: Long
    )

    @Query(
        """
        DELETE FROM messages
        WHERE sessionId = :sessionId
          AND id LIKE 'mobile-local-%'
          AND id NOT IN (:activeLocalEchoIds)
          AND createdAt <= :createdBefore
        """
    )
    suspend fun deleteLocalEchoesExceptCreatedBefore(
        sessionId: String,
        activeLocalEchoIds: List<String>,
        createdBefore: Long
    )

    @Query(
        """
        DELETE FROM messages
        WHERE id LIKE 'mobile-local-%'
          AND createdAt <= :createdBefore
          AND NOT EXISTS (
            SELECT 1 FROM queued_prompts
            WHERE queued_prompts.sessionId = messages.sessionId
              AND ('mobile-local-' || queued_prompts.id) = messages.id
          )
        """
    )
    suspend fun deleteOrphanedLocalEchoesCreatedBefore(createdBefore: Long)

    @Upsert
    suspend fun upsertAll(messages: List<MessageEntity>)
}
