package com.nimbalyst.app.sync

import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.IndexReplicationStore
import com.nimbalyst.app.data.IndexReplicationStore.Companion.FILE
import com.nimbalyst.app.data.IndexReplicationStore.Companion.PROJECT
import com.nimbalyst.app.data.IndexReplicationStore.Companion.SESSION
import com.nimbalyst.app.data.IndexReplicationStore.Op
import com.nimbalyst.app.data.IndexRowRevisionEntity
import com.nimbalyst.app.data.SessionEntity

/** A page that passed validation and decryption, ready to apply. */
internal data class ValidatedIndexPage(
    val mode: IndexReplicationMode,
    val write: IndexReplicationStore.PageWrite,
    val nextPageToken: String?,
    val cursor: Long?,
    val complete: Boolean,
    val resetRequired: Boolean,
) {
    /**
     * The revision this page proves, and only the one the server stated. The
     * highest entry revision is no substitute: a bootstrap page can carry a
     * row newer than the range its terminal proves. A partial delta may commit
     * its supplied cursor (the server sends one only for a contiguous prefix);
     * a partial bootstrap proves nothing.
     */
    val committableCursor: Long?
        get() = when {
            !mode.advancesCursor -> null
            complete -> cursor
            mode == IndexReplicationMode.DELTA -> cursor
            else -> null
        }
}

/**
 * Validates and decrypts versioned index pages. Pure apart from the decoder's
 * metadata cache. Every refusal leaves the cursor where it was: a malformed
 * page is not evidence of anything, least of all deletion. Port of iOS
 * `IndexReplicationPageValidator`.
 */
internal object IndexPageValidator {
    const val PROTOCOL_VERSION = 2

    class PageError(message: String) : Exception(message)

    fun validate(
        response: IndexPageResponse,
        expectedRequestId: String,
        expectedMode: IndexReplicationMode,
        crypto: CryptoManager,
        decoder: SessionEntryDecoder,
        existing: Map<String, SessionEntity>,
    ): Result<ValidatedIndexPage> = runCatching {
        fun fail(message: String): Nothing = throw PageError(message)
        if (response.protocolVersion != PROTOCOL_VERSION) fail("unsupported protocol ${response.protocolVersion}")
        if (response.requestId != expectedRequestId) fail("page answers ${response.requestId}, not $expectedRequestId")
        val mode = IndexReplicationMode.of(response.mode) ?: fail("unknown mode ${response.mode}")
        if (mode != expectedMode) fail("mode ${response.mode}, expected ${expectedMode.wire}")

        // A reset has no entries and no token, deliberately breaking the rule below.
        if (response.resetRequired == true) {
            return@runCatching ValidatedIndexPage(
                mode, IndexReplicationStore.PageWrite(), null, null, complete = false, resetRequired = true
            )
        }
        if (response.complete == (response.nextPageToken != null)) {
            fail("complete=${response.complete} with${if (response.nextPageToken == null) "out" else ""} a page token")
        }

        // In wire order: the same id can change twice on one page.
        val operations = ArrayList<Op>()
        val seen = ArrayList<Pair<String, String>>()

        for (change in response.entries) {
            val reason = change.removalReason
            if (reason != null && (!change.deleted || change.entity != SESSION || reason !in setOf("expired", "deleted"))) {
                fail("invalid removal reason $reason")
            }
            if (change.entity !in setOf(SESSION, PROJECT, FILE)) fail("unknown entity ${change.entity}")
            if (change.revision < 0) fail("negative revision for ${change.id}")
            val payloads = listOfNotNull(change.session, change.project, change.file).size
            // Even an unreadable row proves coverage and carries ordering, never deletion.
            seen += change.entity to change.id
            fun unreadable() { operations += Op.Bookkeeping(IndexRowRevisionEntity(change.entity, change.id, change.revision, unreadable = true)) }

            if (change.deleted) {
                if (payloads != 0) fail("tombstone ${change.entity}/${change.id} carries a payload")
                when (change.entity) {
                    SESSION -> operations += Op.SessionDelete(change.id, change.revision)
                    // A project tombstone carries only the encrypted id; recover the local path.
                    PROJECT -> crypto.decryptOrNull(change.id, CryptoManager.projectIdIvBase64)
                        ?.let { operations += Op.ProjectDelete(it, change.id, change.revision) } ?: unreadable()
                    FILE -> operations += Op.Bookkeeping(IndexRowRevisionEntity(FILE, change.id, change.revision, deleted = true))
                }
                continue
            }
            if (payloads != 1) fail("${change.entity}/${change.id} has $payloads payloads")
            when (change.entity) {
                SESSION -> {
                    val entry = change.session?.takeIf { it.sessionId == change.id }
                        ?: fail("session payload missing for ${change.id}")
                    val decoded = if (decoder.isFullyReadable(entry, crypto)) {
                        decoder.decodeSession(entry, crypto, existing[entry.sessionId], serverRow = true)
                    } else {
                        null
                    }
                    if (decoded == null) unreadable() else {
                        operations += Op.Session(decoded.session, change.revision, decoded.queuedPrompts, decoded.clearQueuedPrompts)
                    }
                }
                PROJECT -> {
                    // The server keys projects by their encrypted id.
                    val entry = change.project?.takeIf { it.encryptedProjectId == change.id }
                        ?: fail("project payload missing for ${change.id}")
                    val decoded = decoder.decodeProject(entry, crypto)
                    if (decoded == null) unreadable() else operations += Op.Project(decoded, change.id, change.revision)
                }
                FILE -> {
                    change.file?.takeIf { it.docId == change.id } ?: fail("file payload missing for ${change.id}")
                    // File bodies sync through the documents lane; the index only orders them here.
                    operations += Op.Bookkeeping(IndexRowRevisionEntity(FILE, change.id, change.revision))
                }
            }
        }
        response.cursor?.let { if (it < 0) fail("negative cursor $it") }
        if (mode.advancesCursor && response.complete && response.cursor == null) fail("terminal page without a cursor")

        val page = ValidatedIndexPage(
            mode = mode,
            write = IndexReplicationStore.PageWrite(operations = operations, seen = seen),
            nextPageToken = response.nextPageToken,
            cursor = response.cursor,
            complete = response.complete,
            resetRequired = false
        )
        page
    }
}
