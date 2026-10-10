package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

@Dao
interface SyncStateDao {
    @Query("SELECT * FROM sync_state WHERE roomId = :roomId LIMIT 1")
    suspend fun getByRoomId(roomId: String): SyncStateEntity?

    @Upsert
    suspend fun upsert(state: SyncStateEntity)

    /**
     * Forgets the resume point of every session room whose session is gone.
     * Its messages went with it, so a later join must start from the
     * beginning rather than skip the history that was deleted.
     */
    @Query("DELETE FROM sync_state WHERE roomId NOT LIKE 'index%' AND roomId NOT IN (SELECT id FROM sessions)")
    suspend fun deleteOrphanedSessionRooms()
}
