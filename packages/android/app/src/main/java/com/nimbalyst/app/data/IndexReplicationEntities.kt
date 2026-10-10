package com.nimbalyst.app.data

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Query
import androidx.room.Upsert

/**
 * The server revision last applied for one index row, keyed by the id the
 * server uses (a project's is its encrypted id). A tombstone keeps its revision
 * so an older page cannot resurrect the row. Port of iOS `index_row_revision`.
 */
@Entity(tableName = "index_row_revision", primaryKeys = ["entity", "id"])
data class IndexRowRevisionEntity(
    val entity: String,
    val id: String,
    val revision: Long,
    @ColumnInfo(defaultValue = "0") val deleted: Boolean = false,
    /** This device's key could not read the row; it proves coverage but was not applied. */
    @ColumnInfo(defaultValue = "0") val unreadable: Boolean = false,
)

/** The last contiguous revision committed, and whether a bootstrap has proven complete coverage. */
@Entity(tableName = "index_replication_cursor", primaryKeys = ["scope"])
data class IndexReplicationCursorEntity(
    val scope: String,
    val cursor: Long = 0,
    val historyComplete: Boolean = false,
)

/** Rows a bootstrap run has enumerated, so reconciliation is provable from disk rather than memory. */
@Entity(tableName = "index_bootstrap_seen", primaryKeys = ["runId", "entity", "id"])
data class IndexBootstrapSeenEntity(
    val runId: String,
    val entity: String,
    val id: String,
)

/**
 * A bootstrap whose rows are committed but whose reconciliation has not
 * finished. The cursor is committed only when reconciliation succeeds, so a
 * crash in between leaves this marker rather than a claim of coverage.
 */
@Entity(tableName = "index_bootstrap_finalization", primaryKeys = ["runId"])
data class IndexBootstrapFinalizationEntity(
    val runId: String,
    val cursor: Long,
    val startedAt: Long,
)

@Dao
interface IndexReplicationDao {
    @Query("SELECT * FROM index_row_revision WHERE entity = :entity AND id IN (:ids)")
    suspend fun revisions(entity: String, ids: List<String>): List<IndexRowRevisionEntity>

    @Upsert
    suspend fun upsertRevisions(rows: List<IndexRowRevisionEntity>)

    @Query("SELECT COUNT(*) FROM index_row_revision WHERE unreadable = 1 AND entity = 'session' AND deleted = 0")
    suspend fun unreadableSessionCount(): Int

    @Query("SELECT * FROM index_replication_cursor WHERE scope = :scope")
    suspend fun cursor(scope: String): IndexReplicationCursorEntity?

    @Upsert
    suspend fun upsertCursor(cursor: IndexReplicationCursorEntity)

    @Upsert
    suspend fun recordSeen(rows: List<IndexBootstrapSeenEntity>)

    @Query("DELETE FROM index_bootstrap_seen WHERE runId = :runId")
    suspend fun clearSeen(runId: String)

    @Upsert
    suspend fun beginFinalization(marker: IndexBootstrapFinalizationEntity)

    @Query("SELECT * FROM index_bootstrap_finalization ORDER BY startedAt LIMIT 1")
    suspend fun pendingFinalization(): IndexBootstrapFinalizationEntity?

    @Query("DELETE FROM index_bootstrap_finalization WHERE runId = :runId")
    suspend fun clearFinalization(runId: String)

    @Query("DELETE FROM index_bootstrap_seen")
    suspend fun clearAllSeen()

    @Query("DELETE FROM index_bootstrap_finalization")
    suspend fun clearAllFinalizations()

    /**
     * Work only this device has: an unsent draft, or a prompt queued here
     * (no source) and not yet delivered. Deleting the row cascades both away.
     * Mirrors iOS `IndexReplicationStore.hasUndeliveredLocalWork`.
     */
    @Query(
        """
        SELECT EXISTS(SELECT 1 FROM sessions WHERE id = :sessionId AND draftInput IS NOT NULL AND draftInput <> '')
            OR EXISTS(SELECT 1 FROM queued_prompts WHERE sessionId = :sessionId AND source IS NULL AND sentAt IS NULL)
        """
    )
    suspend fun hasLocalWork(sessionId: String): Boolean

    /**
     * Sessions a finished bootstrap never listed. Rows holding work only this
     * device has are never returned: reconciliation deletes what the server
     * can account for, not what only this device knows.
     */
    @Query(
        """
        SELECT s.id FROM sessions s
        WHERE NOT EXISTS (
            SELECT 1 FROM index_bootstrap_seen b
            WHERE b.runId = :runId AND b.entity = 'session' AND b.id = s.id
        )
        AND (s.draftInput IS NULL OR s.draftInput = '')
        AND NOT EXISTS (SELECT 1 FROM queued_prompts q WHERE q.sessionId = s.id AND q.source IS NULL AND q.sentAt IS NULL)
        LIMIT :limit
        """
    )
    suspend fun sessionIdsAbsentFromRun(runId: String, limit: Int): List<String>

    /** Sessions the server deleted that were kept for local work, now that the work is gone. */
    @Query(
        """
        SELECT s.id FROM sessions s
        JOIN index_row_revision r ON r.entity = 'session' AND r.id = s.id AND r.deleted = 1
        WHERE (s.draftInput IS NULL OR s.draftInput = '')
        AND NOT EXISTS (SELECT 1 FROM queued_prompts q WHERE q.sessionId = s.id AND q.source IS NULL AND q.sentAt IS NULL)
        LIMIT :limit
        """
    )
    suspend fun purgeableTombstonedSessionIds(limit: Int): List<String>

    /** Live (not tombstoned) sessions a bootstrap run enumerated. */
    @Query(
        """
        SELECT COUNT(*) FROM index_bootstrap_seen b
        JOIN index_row_revision r ON r.entity = b.entity AND r.id = b.id
        WHERE b.runId = :runId AND b.entity = 'session' AND r.deleted = 0
        """
    )
    suspend fun liveSessionsInRun(runId: String): Int

    @Query(
        """
        SELECT COUNT(*) FROM index_bootstrap_seen b
        JOIN index_row_revision r ON r.entity = b.entity AND r.id = b.id
        WHERE b.runId = :runId AND b.entity = 'session' AND r.deleted = 0 AND r.unreadable = 1
        """
    )
    suspend fun unreadableSessionsInRun(runId: String): Int

    @Query("UPDATE index_row_revision SET unreadable = 0 WHERE unreadable = 1 AND NOT EXISTS (SELECT 1 FROM index_bootstrap_seen b WHERE b.runId = :runId AND b.entity = index_row_revision.entity AND b.id = index_row_revision.id)")
    suspend fun clearUnreadableAbsentFromRun(runId: String)

    @Query("DELETE FROM index_row_revision")
    suspend fun clearRevisions()
}
