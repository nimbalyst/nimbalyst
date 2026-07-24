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
}
