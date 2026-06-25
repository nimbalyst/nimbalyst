package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface TranscriptPageDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(page: TranscriptPageEntity)

    @Query("SELECT * FROM transcript_pages WHERE sessionId = :sessionId AND cursorKey = :cursorKey LIMIT 1")
    suspend fun getPage(sessionId: String, cursorKey: Long): TranscriptPageEntity?

    @Query("SELECT COUNT(*) FROM transcript_pages WHERE sessionId = :sessionId")
    suspend fun countForSession(sessionId: String): Int

    @Query(
        """
        DELETE FROM transcript_pages WHERE sessionId = :sessionId AND cursorKey IN (
            SELECT cursorKey FROM transcript_pages WHERE sessionId = :sessionId
            ORDER BY updatedAt ASC LIMIT :count
        )
        """
    )
    suspend fun deleteOldest(sessionId: String, count: Int)

    @Query("DELETE FROM transcript_pages WHERE sessionId = :sessionId")
    suspend fun deleteForSession(sessionId: String)
}
