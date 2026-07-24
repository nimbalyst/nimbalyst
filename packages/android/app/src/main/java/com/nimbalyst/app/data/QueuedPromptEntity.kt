package com.nimbalyst.app.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "queued_prompts",
    foreignKeys = [
        ForeignKey(
            entity = SessionEntity::class,
            parentColumns = ["id"],
            childColumns = ["sessionId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("sessionId")]
)
data class QueuedPromptEntity(
    @PrimaryKey val id: String,
    val sessionId: String,
    val promptTextEncrypted: String,
    val iv: String,
    val createdAt: Long,
    val sentAt: Long? = null,
    val promptTextDecrypted: String? = null,
    val source: String? = null,
)

