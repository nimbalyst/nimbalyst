package com.nimbalyst.app.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "messages",
    foreignKeys = [
        ForeignKey(
            entity = SessionEntity::class,
            parentColumns = ["id"],
            childColumns = ["sessionId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index(value = ["sessionId", "sequence"], unique = true)]
)
data class MessageEntity(
    @PrimaryKey val id: String,
    val sessionId: String,
    val sequence: Int,
    val source: String,
    val direction: String,
    val encryptedContent: String = "",
    val iv: String = "",
    val contentDecrypted: String? = null,
    val metadataJson: String? = null,
    val createdAt: Long,
)

