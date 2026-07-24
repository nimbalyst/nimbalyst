package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE sessionId = :sessionId ORDER BY sequence ASC")
    fun observeMessagesForSession(sessionId: String): Flow<List<MessageEntity>>

    @Query("SELECT COUNT(*) FROM messages WHERE sessionId = :sessionId")
    suspend fun countForSession(sessionId: String): Int

    @Query("SELECT COALESCE(MAX(sequence), 0) FROM messages WHERE sessionId = :sessionId")
    suspend fun maxSequenceForSession(sessionId: String): Int

    @Query("DELETE FROM messages WHERE sessionId = :sessionId")
    suspend fun deleteForSession(sessionId: String)

    @Upsert
    suspend fun upsertAll(messages: List<MessageEntity>)
}
