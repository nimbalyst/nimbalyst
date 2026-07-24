package com.nimbalyst.app.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "sessions",
    foreignKeys = [
        ForeignKey(
            entity = ProjectEntity::class,
            parentColumns = ["id"],
            childColumns = ["projectId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("projectId"), Index("updatedAt"), Index("parentSessionId")]
)
data class SessionEntity(
    @PrimaryKey val id: String,
    val projectId: String,
    val titleEncrypted: String? = null,
    val titleIv: String? = null,
    val titleDecrypted: String? = null,
    val provider: String? = null,
    val model: String? = null,
    val mode: String? = null,
    val sessionType: String? = null,
    val parentSessionId: String? = null,
    val phase: String? = null,
    val tagsJson: String? = null,
    val worktreeId: String? = null,
    val isArchived: Boolean = false,
    val isPinned: Boolean = false,
    val branchedFromSessionId: String? = null,
    val branchPointMessageId: Int? = null,
    val branchedAt: Long? = null,
    val isExecuting: Boolean = false,
    val hasQueuedPrompts: Boolean = false,
    val contextTokens: Int? = null,
    val contextWindow: Int? = null,
    val createdAt: Long,
    val updatedAt: Long,
    val lastSyncedSeq: Int = 0,
    val lastReadAt: Long? = null,
    val lastMessageAt: Long? = null,
    val draftInput: String? = null,
    val draftUpdatedAt: Long? = null,
)

