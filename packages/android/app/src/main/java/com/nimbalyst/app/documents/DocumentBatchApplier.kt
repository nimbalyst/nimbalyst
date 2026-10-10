package com.nimbalyst.app.documents

import android.util.Log
import com.nimbalyst.app.crypto.CryptoManager

private const val TAG = "DocumentSync"

/**
 * Applies one batch atomically, deletions and Yjs bookkeeping included. Paths
 * and titles are decrypted (the file list needs them); content stays encrypted
 * until the document is opened, whatever the batch size, so a large initial
 * sync cannot exhaust memory. Throws when any entry cannot be decrypted or the
 * write fails; nothing from a failed batch is kept.
 *
 * A file with an unconfirmed local push newer than the server's copy keeps
 * the local content: that push is about to replace the server's.
 */
internal fun applyDocumentSyncBatch(
    response: ProjectSyncResponse,
    projectId: String,
    crypto: CryptoManager,
    database: DocumentsDatabase,
    now: Long,
) {
    val dao = database.documentsDao()
    val pending = dao.pendingPushes(projectId).associate { it.syncId to it.lastModifiedAt }
    val incoming = response.files.filterNot { entry -> pending[entry.syncId]?.let { it > entry.lastModifiedAt } == true }
    val documents = incoming.map { entry ->
        SyncedDocument(
            projectId = projectId,
            syncId = entry.syncId,
            relativePath = crypto.decrypt(entry.encryptedPath, entry.pathIv),
            title = crypto.decrypt(entry.encryptedTitle, entry.titleIv),
            contentHash = entry.contentHash,
            lastModifiedAt = entry.lastModifiedAt,
            syncedAt = now,
            contentDecrypted = null,
            encryptedContent = entry.encryptedContent,
            contentIv = entry.contentIv,
            hasYjs = entry.hasYjs,
            yjsSeq = 0,
            createdAt = now,
            updatedAt = now,
        )
    }
    database.runInTransaction {
        documents.forEach(dao::upsert)
        if (response.deletedSyncIds.isNotEmpty()) dao.delete(projectId, response.deletedSyncIds)
        response.yjsUpdates.forEach { dao.advanceYjsSeq(projectId, it.syncId, it.sequence, now) }
    }
}

/**
 * A file from a `fileContentBroadcast`: content is decrypted immediately, since
 * it is one file and an open editor may want it. Returns the stored document,
 * or null when the entry cannot be decrypted or an unconfirmed local push is
 * newer (the manifest diff then asks for that push again).
 */
internal fun applyContentBroadcast(
    entry: ProjectSyncFileEntry,
    projectId: String,
    crypto: CryptoManager,
    database: DocumentsDatabase,
    now: Long,
): SyncedDocument? {
    val pending = database.documentsDao().pendingPushes(projectId).firstOrNull { it.syncId == entry.syncId }
    if (pending != null && pending.lastModifiedAt > entry.lastModifiedAt) return null
    val path = crypto.decryptOrNull(entry.encryptedPath, entry.pathIv) ?: return null
    val title = crypto.decryptOrNull(entry.encryptedTitle, entry.titleIv) ?: path.substringAfterLast('/')
    val content = crypto.decryptOrNull(entry.encryptedContent, entry.contentIv) ?: return null
    val dao = database.documentsDao()
    val existing = dao.document(projectId, entry.syncId)
    val document = SyncedDocument(
        projectId = projectId,
        syncId = entry.syncId,
        relativePath = path,
        title = title,
        contentHash = entry.contentHash,
        lastModifiedAt = entry.lastModifiedAt,
        syncedAt = now,
        contentDecrypted = content,
        hasYjs = false,
        yjsSeq = existing?.yjsSeq ?: 0,
        createdAt = existing?.createdAt ?: now,
        updatedAt = now,
    )
    dao.upsert(document)
    return document
}

/**
 * The document's markdown, decrypting and caching it on first open. Returns
 * null when the stored blob cannot be decrypted.
 */
internal fun decryptDocumentContent(
    document: SyncedDocument,
    crypto: CryptoManager,
    database: DocumentsDatabase,
    now: Long,
): String? {
    document.contentDecrypted?.let { return it }
    val encrypted = document.encryptedContent ?: return null
    val iv = document.contentIv ?: return null
    val content = crypto.decryptOrNull(encrypted, iv) ?: run {
        Log.e(TAG, "Failed to decrypt content on demand for ${document.syncId}")
        return null
    }
    runCatching {
        database.documentsDao().upsert(
            document.copy(contentDecrypted = content, encryptedContent = null, contentIv = null, updatedAt = now)
        )
    }.onFailure { Log.e(TAG, "Failed to cache decrypted content for ${document.syncId}", it) }
    return content
}
