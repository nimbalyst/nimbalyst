package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ProjectDao {
    @Query("SELECT * FROM projects ORDER BY sortOrder ASC, lastUpdatedAt DESC, name ASC")
    fun observeAll(): Flow<List<ProjectEntity>>

    @Query("DELETE FROM projects WHERE id = :projectId")
    suspend fun deleteById(projectId: String)

    @Query("DELETE FROM projects WHERE id NOT IN (:projectIds)")
    suspend fun deleteNotIn(projectIds: List<String>)

    @Query("DELETE FROM projects")
    suspend fun deleteAll()

    @Query(
        """
        UPDATE projects
        SET sessionCount = (
            SELECT COUNT(*)
            FROM sessions
            WHERE sessions.projectId = projects.id
              AND sessions.isArchived = 0
        ),
        lastUpdatedAt = (
            SELECT MAX(updatedAt)
            FROM sessions
            WHERE sessions.projectId = projects.id
        )
        """
    )
    suspend fun refreshAllProjectStats()

    @Query(
        """
        UPDATE projects
        SET sessionCount = (
            SELECT COUNT(*)
            FROM sessions
            WHERE sessions.projectId = :projectId
              AND sessions.isArchived = 0
        ),
        lastUpdatedAt = (
            SELECT MAX(updatedAt)
            FROM sessions
            WHERE sessions.projectId = :projectId
        )
        WHERE id = :projectId
        """
    )
    suspend fun refreshProjectStats(projectId: String)

    @Upsert
    suspend fun upsertAll(projects: List<ProjectEntity>)
}
