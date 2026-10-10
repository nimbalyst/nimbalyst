package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface SessionDao {
    @Query("SELECT * FROM sessions WHERE isArchived = 0 ORDER BY updatedAt DESC")
    fun observeActiveSessions(): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE projectId = :projectId AND isArchived = 0 ORDER BY updatedAt DESC")
    fun observeSessionsForProject(projectId: String): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE id = :sessionId LIMIT 1")
    fun observeSession(sessionId: String): Flow<SessionEntity?>

    @Query("SELECT * FROM sessions WHERE id = :sessionId LIMIT 1")
    suspend fun getById(sessionId: String): SessionEntity?

    @Query("DELETE FROM sessions WHERE id = :sessionId")
    suspend fun deleteById(sessionId: String)

    @Query("SELECT * FROM sessions WHERE id IN (:sessionIds)")
    suspend fun getByIds(sessionIds: List<String>): List<SessionEntity>

    /** Sessions holding nothing only this device has: no unsent draft, no undelivered local prompt. */
    @Query(
        """
        SELECT s.id FROM sessions s
        WHERE (s.draftInput IS NULL OR s.draftInput = '')
        AND NOT EXISTS (SELECT 1 FROM queued_prompts q WHERE q.sessionId = s.id AND q.source IS NULL AND q.sentAt IS NULL)
        """
    )
    suspend fun idsWithoutLocalWork(): List<String>

    @Query("DELETE FROM sessions WHERE id IN (:sessionIds)")
    suspend fun deleteByIds(sessionIds: List<String>)

    @Query(
        """
        UPDATE sessions
        SET lastSyncedSeq = CASE
                WHEN lastSyncedSeq > :lastSyncedSeq THEN lastSyncedSeq
                ELSE :lastSyncedSeq
            END
        WHERE id = :sessionId
        """
    )
    suspend fun updateSyncWatermark(
        sessionId: String,
        lastSyncedSeq: Int
    )

    @Query(
        """
        UPDATE sessions
        SET lastReadAt = CASE
                WHEN lastReadAt IS NULL OR lastReadAt < :lastReadAt THEN :lastReadAt
                ELSE lastReadAt
            END
        WHERE id = :sessionId
        """
    )
    suspend fun updateLastReadAt(
        sessionId: String,
        lastReadAt: Long
    )

    @Query("UPDATE sessions SET draftInput = :draftInput, draftUpdatedAt = :draftUpdatedAt WHERE id = :sessionId")
    suspend fun updateDraftInput(sessionId: String, draftInput: String?, draftUpdatedAt: Long)

    @Query("UPDATE sessions SET clientMetadataJson = :clientMetadataJson WHERE id = :sessionId")
    suspend fun updateClientMetadata(sessionId: String, clientMetadataJson: String)

    @Query("UPDATE sessions SET isArchived = :isArchived WHERE id = :sessionId")
    suspend fun updateArchived(sessionId: String, isArchived: Boolean)

    @Query("UPDATE sessions SET parentSessionId = :parentSessionId WHERE id = :sessionId")
    suspend fun updateParent(sessionId: String, parentSessionId: String?)

    @Upsert
    suspend fun upsertAll(sessions: List<SessionEntity>)
}
