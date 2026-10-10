package com.nimbalyst.app.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface ProjectDao {
    /** Projects the index has sent. Provisional stand-ins are never listed. */
    @Query("SELECT * FROM projects WHERE isProvisional = 0 ORDER BY sortOrder ASC, lastUpdatedAt DESC, name ASC")
    fun observeAll(): Flow<List<ProjectEntity>>

    @Query("DELETE FROM projects WHERE isProvisional = 1 AND id NOT IN (SELECT projectId FROM sessions)")
    suspend fun deleteUnreferencedProvisional()

    @Query("DELETE FROM projects WHERE id = :projectId")
    suspend fun deleteById(projectId: String)

    /** Projects outside [projectIds] that no cached session names; deleting a named one would cascade its history. */
    @Query("DELETE FROM projects WHERE id NOT IN (:projectIds) AND id NOT IN (SELECT projectId FROM sessions)")
    suspend fun deleteUnreferencedNotIn(projectIds: List<String>)

    @Query("DELETE FROM projects WHERE id NOT IN (SELECT projectId FROM sessions)")
    suspend fun deleteAllUnreferenced()

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

    @Query("SELECT * FROM projects WHERE id IN (:projectIds)")
    suspend fun getByIds(projectIds: List<String>): List<ProjectEntity>

    @Upsert
    suspend fun upsertAll(projects: List<ProjectEntity>)

    /** Inserts rows whose id is absent; an existing project is left untouched. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIfMissing(projects: List<ProjectEntity>)
}
