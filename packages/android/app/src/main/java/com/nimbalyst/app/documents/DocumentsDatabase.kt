package com.nimbalyst.app.documents

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import android.util.Log
import kotlinx.coroutines.flow.Flow
import java.security.MessageDigest

/**
 * A synced project file, cached for offline reading and editing. Mirrors iOS
 * `SyncedDocument`. Keyed by project + syncId (syncIds are only unique within a
 * project room) and unique by project + relative path.
 *
 * Bulk sync stores [encryptedContent]/[contentIv] and leaves
 * [contentDecrypted] null; content is decrypted when a document is opened.
 */
@Entity(
    tableName = "synced_documents",
    primaryKeys = ["projectId", "syncId"],
    indices = [Index(value = ["projectId", "relativePath"], unique = true)],
)
data class SyncedDocument(
    val projectId: String,
    val syncId: String,
    val relativePath: String,
    val title: String,
    val contentHash: String? = null,
    /** Last writer's mtime (epoch ms); the server orders writes by it. */
    val lastModifiedAt: Long? = null,
    val syncedAt: Long? = null,
    val contentDecrypted: String? = null,
    val encryptedContent: String? = null,
    val contentIv: String? = null,
    val hasYjs: Boolean = false,
    val yjsSeq: Long = 0,
    val createdAt: Long,
    val updatedAt: Long,
)

/**
 * The columns a file list and a sync manifest need. Never select content for a
 * whole project: one large document would overflow a 2 MB CursorWindow.
 */
data class DocumentSummary(
    val projectId: String,
    val syncId: String,
    val relativePath: String,
    val title: String,
    val contentHash: String?,
    val lastModifiedAt: Long?,
    val hasYjs: Boolean,
    val yjsSeq: Long,
) {
    val displayName: String get() = relativePath.substringAfterLast('/')
}

/**
 * A client write the server has not confirmed yet. The server sends no ack for
 * a push or a delete, so an entry stays until a later `projectSyncResponse`
 * shows the server holds it (see [planOutboxReconciliation]); handing it to
 * the socket proves nothing. One entry per document: a newer push replaces an
 * older one, since each carries the whole file.
 */
@Entity(tableName = "document_outbox", indices = [Index(value = ["projectId", "syncId"])])
data class DocumentOutboxEntry(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val projectId: String,
    val syncId: String,
    val kind: OutboxKind,
    val payload: String,
    /** For a push, the hash the server must report before the entry is confirmed. */
    val contentHash: String?,
    /** The write's mtime, compared with the server's to tell whose write is newer. */
    val lastModifiedAt: Long,
    val createdAt: Long,
)

enum class OutboxKind { PUSH, DELETE }

data class PendingPush(val syncId: String, val lastModifiedAt: Long)

private const val SUMMARY_COLUMNS =
    "projectId, syncId, relativePath, title, contentHash, lastModifiedAt, hasYjs, yjsSeq"

@Dao
interface DocumentsDao {
    @Query("SELECT $SUMMARY_COLUMNS FROM synced_documents WHERE projectId = :projectId ORDER BY relativePath")
    fun observeSummaries(projectId: String): Flow<List<DocumentSummary>>

    @Query("SELECT $SUMMARY_COLUMNS FROM synced_documents WHERE projectId = :projectId ORDER BY relativePath")
    fun summaries(projectId: String): List<DocumentSummary>

    @Query("SELECT * FROM synced_documents WHERE projectId = :projectId AND syncId = :syncId")
    fun document(projectId: String, syncId: String): SyncedDocument?

    @Query("SELECT * FROM synced_documents WHERE projectId = :projectId AND relativePath = :relativePath")
    fun documentByPath(projectId: String, relativePath: String): SyncedDocument?

    @Query("SELECT * FROM synced_documents WHERE projectId = :projectId AND relativePath = :relativePath")
    fun observeDocumentByPath(projectId: String, relativePath: String): Flow<SyncedDocument?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsert(document: SyncedDocument)

    @Query("DELETE FROM synced_documents WHERE projectId = :projectId AND syncId IN (:syncIds)")
    fun delete(projectId: String, syncIds: List<String>)

    @Query("UPDATE synced_documents SET hasYjs = 1, updatedAt = :now WHERE projectId = :projectId AND syncId = :syncId")
    fun markYjs(projectId: String, syncId: String, now: Long)

    @Query(
        "UPDATE synced_documents SET yjsSeq = :sequence, updatedAt = :now " +
            "WHERE projectId = :projectId AND syncId = :syncId AND yjsSeq < :sequence"
    )
    fun advanceYjsSeq(projectId: String, syncId: String, sequence: Long, now: Long)

    @Insert
    fun insertOutbox(entry: DocumentOutboxEntry): Long

    @Query("DELETE FROM document_outbox WHERE projectId = :projectId AND syncId = :syncId")
    fun clearOutbox(projectId: String, syncId: String)

    /** Queues [entry], replacing whatever was pending for the same document. */
    @Transaction
    fun enqueue(entry: DocumentOutboxEntry): Long {
        clearOutbox(entry.projectId, entry.syncId)
        return insertOutbox(entry)
    }

    @Query("SELECT * FROM document_outbox WHERE projectId = :projectId ORDER BY id")
    fun outbox(projectId: String): List<DocumentOutboxEntry>

    @Query("SELECT syncId, lastModifiedAt FROM document_outbox WHERE projectId = :projectId AND kind = 'PUSH'")
    fun pendingPushes(projectId: String): List<PendingPush>

    @Query("SELECT COUNT(*) FROM document_outbox WHERE projectId = :projectId")
    fun outboxCount(projectId: String): Int

    @Query("SELECT COUNT(*) FROM document_outbox WHERE projectId = :projectId")
    fun observeOutboxCount(projectId: String): Flow<Int>

    @Query("DELETE FROM document_outbox WHERE id IN (:ids)")
    fun dequeue(ids: List<Long>)
}

/**
 * The document cache, separate from `NimbalystDatabase` so file sync can evolve
 * without touching the session schema. One file per account and server (see
 * [DocumentSyncAccount.accountKey]): switching accounts must neither show the
 * other account's files nor send its unsent edits into the wrong room, and
 * dropping the old outbox would lose edits.
 *
 * Files named under the earlier key, which left out the server, are never
 * opened, migrated, or deleted: which server their outbox belongs to is
 * unknown. [open] logs when one is still on disk. That is also why the
 * outbox's added columns need no migration: no file with the old schema is
 * ever opened under the new names.
 */
@Database(
    entities = [SyncedDocument::class, DocumentOutboxEntry::class],
    version = 1,
    exportSchema = false,
)
abstract class DocumentsDatabase : RoomDatabase() {
    abstract fun documentsDao(): DocumentsDao

    companion object {
        fun fileName(accountKey: String): String = "documents-${sha256Hex(accountKey).take(16)}.db"

        fun open(context: Context, account: DocumentSyncAccount): DocumentsDatabase {
            val legacy = context.getDatabasePath(fileName(account.legacyAccountKey))
            if (legacy.exists()) {
                Log.w("DocumentSync", "[DocSync] Leaving ${legacy.name} on disk: it predates per-server caches")
            }
            return Room.databaseBuilder(context.applicationContext, DocumentsDatabase::class.java, fileName(account.accountKey))
                .build()
        }
    }
}

internal fun sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
