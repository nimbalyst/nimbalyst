package com.nimbalyst.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey val roomId: String,
    val lastCursor: String? = null,
    val lastSequence: Int = 0,
    val lastSyncedAt: Long? = null,
)

