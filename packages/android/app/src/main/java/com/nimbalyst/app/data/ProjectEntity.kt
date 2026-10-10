package com.nimbalyst.app.data

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "projects")
data class ProjectEntity(
    @PrimaryKey val id: String,
    val name: String,
    val sessionCount: Int = 0,
    val lastUpdatedAt: Long? = null,
    val sortOrder: Int = 0,
    /** Slash commands from the project's encrypted config, as a JSON array. */
    val commandsJson: String? = null,
    /** Desktop action prompts from the project's encrypted config, as a JSON array. */
    val actionsJson: String? = null,
    /** SHA-256 of the git remote URL; routes project document sync. */
    val gitRemoteHash: String? = null,
    /**
     * The Local wiki folder relative to the project root, from the encrypted
     * config; null when the project has no Local wiki.
     */
    val localWikiFolder: String? = null,
    /** JSON array of the wiki's type definitions ([com.nimbalyst.app.sync.SyncedWikiType]); null without any. */
    val localWikiTypesJson: String? = null,
    /**
     * A stand-in for a project the index has not sent yet, created so a
     * session naming it can be stored. Never listed; replaced by the real
     * entry, or pruned once no session references it.
     */
    @ColumnInfo(defaultValue = "0")
    val isProvisional: Boolean = false,
)

