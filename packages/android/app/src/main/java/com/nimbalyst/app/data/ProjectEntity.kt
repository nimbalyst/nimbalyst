package com.nimbalyst.app.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "projects")
data class ProjectEntity(
    @PrimaryKey val id: String,
    val name: String,
    val sessionCount: Int = 0,
    val lastUpdatedAt: Long? = null,
    val sortOrder: Int = 0,
    val commandsJson: String? = null,
)

