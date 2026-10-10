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
    indices = [
        Index("projectId"),
        Index("updatedAt"),
        Index("parentSessionId"),
        Index("createdBySessionId"),
    ]
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
    /** Agent role marker, e.g. "meta-agent". */
    val agentRole: String? = null,
    /** The meta-agent session that spawned this one. */
    val createdBySessionId: String? = null,
    /** Stable id of the desktop or headless host that runs this session. */
    val hostDeviceId: String? = null,
    val pendingExecution: PendingExecution? = null,
    /**
     * The last client-metadata blob the server holds for this session, as
     * plaintext JSON. The server replaces the blob whole, so a draft push is
     * written into this rather than rebuilt from the row's columns, which
     * would drop fields this build does not model. Null until one is known.
     */
    val clientMetadataJson: String? = null,
)

