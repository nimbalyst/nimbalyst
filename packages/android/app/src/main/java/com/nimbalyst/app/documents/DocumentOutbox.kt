package com.nimbalyst.app.documents

import com.nimbalyst.app.crypto.CryptoManager

/** A `fileContentPush` for [document] carrying already-encrypted content. */
internal fun pushPayload(
    crypto: CryptoManager,
    document: SyncedDocument,
    encryptedContent: String,
    contentIv: String,
    hash: String,
    modifiedAt: Long,
): String {
    val path = crypto.encrypt(document.relativePath)
    val title = crypto.encrypt(document.title)
    return DocumentSyncWire.encode(
        FileContentPushMessage(
            syncId = document.syncId,
            encryptedContent = encryptedContent,
            contentIv = contentIv,
            contentHash = hash,
            encryptedPath = path.encrypted,
            pathIv = path.iv,
            encryptedTitle = title.encrypted,
            titleIv = title.iv,
            lastModifiedAt = modifiedAt,
        )
    )
}

/**
 * What one `projectSyncResponse` transfer said about the client's files,
 * accumulated across its batches (any batch may carry any field).
 */
internal class TransferFindings {
    val needFromClient = mutableSetOf<String>()
    val deleted = mutableSetOf<String>()
    /** Files where the server's copy is newer than the manifest's, with the server's mtime. */
    val serverNewer = mutableMapOf<String, Long>()

    fun add(response: ProjectSyncResponse) {
        needFromClient += response.needFromClient
        deleted += response.deletedSyncIds
        response.updatedFiles.forEach { serverNewer[it.syncId] = it.lastModifiedAt }
    }
}

internal data class OutboxPlan(
    /** Entries the server holds, or that a newer server write or a delete made moot. */
    val settled: List<Long>,
    val resend: List<DocumentOutboxEntry>,
    /** Files the server asked for that have no pending entry: push the cached copy. */
    val pushFromCache: List<String>,
)

/**
 * Decides each pending entry's fate from the answer to [manifest] (syncId to
 * the content hash it reported). `ProjectSyncRoom` never acks a push or a
 * delete; the only evidence is its manifest diff:
 *
 *  - hashes equal: the file is not listed, so a push whose hash the manifest
 *    carried is confirmed;
 *  - hashes differ, client newer: `needFromClient`, so the push is resent;
 *  - hashes differ, server newer: `updatedFiles`, which supersedes any push
 *    no newer than the server's copy;
 *  - deleted on the server: `deletedSyncIds`, which confirms a delete and
 *    makes a push moot.
 *
 * A push saved after the manifest was taken is resent, and a later round
 * confirms it.
 */
internal fun planOutboxReconciliation(
    entries: List<DocumentOutboxEntry>,
    manifest: Map<String, String>,
    findings: TransferFindings,
): OutboxPlan {
    val settled = mutableListOf<Long>()
    val resend = mutableListOf<DocumentOutboxEntry>()
    for (entry in entries) {
        val id = entry.syncId
        val isSettled = when (entry.kind) {
            OutboxKind.DELETE -> id in findings.deleted
            OutboxKind.PUSH -> when {
                id in findings.deleted -> true
                findings.serverNewer[id]?.let { it >= entry.lastModifiedAt } == true -> true
                id in findings.needFromClient -> false
                // The local file is gone (a delete from another device), so there is nothing to push.
                id !in manifest -> true
                else -> manifest[id] == entry.contentHash
            }
        }
        if (isSettled) settled += entry.id else resend += entry
    }
    val pending = entries.mapTo(mutableSetOf()) { it.syncId }
    val pushFromCache = findings.needFromClient.filter { it !in pending && it in manifest }
    return OutboxPlan(settled, resend, pushFromCache)
}
