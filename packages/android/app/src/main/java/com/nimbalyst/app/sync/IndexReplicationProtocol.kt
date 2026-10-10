package com.nimbalyst.app.sync

/**
 * Versioned (v2) personal-index replication wire types. Mirrors
 * `IndexReplicationProtocol.swift` and the collab-protocol fixtures.
 * Activity timestamps are never cursors: only revisions are.
 */
data class IndexPageRequest(
    val type: String = "indexPageRequest",
    val protocolVersion: Int = 2,
    val requestId: String,
    /** "bootstrap" | "delta" | "recent" | "lookup" */
    val mode: String,
    val pageToken: String? = null,
    val sinceRevision: Long? = null,
    val projectId: String? = null,
    val sessionIds: List<String>? = null,
    val limit: Int? = null,
)

data class IndexPageResponse(
    val type: String,
    val protocolVersion: Int,
    val requestId: String,
    val mode: String,
    val entries: List<IndexChange> = emptyList(),
    val nextPageToken: String? = null,
    /** The only coverage signal; set by bootstrap and delta, never by recent or lookup. */
    val cursor: Long? = null,
    /** This mode has nothing more to send on this cursor. Not a statement about coverage. */
    val complete: Boolean,
    val resetRequired: Boolean? = null,
)

data class IndexChange(
    /** "session" | "project" | "file" */
    val entity: String,
    /** The server's key: a session id, an encrypted project id, or a doc id. */
    val id: String,
    val revision: Long,
    val deleted: Boolean,
    /** "expired" | "deleted", sessions only. */
    val removalReason: String? = null,
    val session: ServerSessionEntry? = null,
    val project: ServerProjectEntry? = null,
    val file: ServerIndexFileEntry? = null,
)

/** File metadata carried by the personal index; the document body syncs separately. */
data class ServerIndexFileEntry(
    val docId: String,
    val encryptedProjectId: String,
    val projectIdIv: String,
    val encryptedRelativePath: String,
    val relativePathIv: String,
    val encryptedTitle: String,
    val titleIv: String,
    /** Desktop mtime can carry fractional milliseconds. */
    val lastModifiedAt: Double,
    val syncedAt: Long,
)

/** "There is newer data." A hint to ask for a delta, never a cursor. */
data class IndexChangesAvailable(
    val type: String,
    val revision: Long,
)

enum class IndexReplicationMode(val wire: String, val advancesCursor: Boolean) {
    BOOTSTRAP("bootstrap", true),
    DELTA("delta", true),
    RECENT("recent", false),
    LOOKUP("lookup", false);

    companion object {
        fun of(wire: String): IndexReplicationMode? = entries.firstOrNull { it.wire == wire }
    }
}

/** What the account has proven about its local index. Mirrors iOS `IndexCoverage`. */
data class IndexCoverage(
    /** A bootstrap and its replay committed: an empty search result means empty. */
    val historyComplete: Boolean = false,
    /** A bootstrap is in flight. Cached rows stay usable throughout. */
    val isBackfilling: Boolean = false,
    val compatibility: Compatibility = Compatibility.UNKNOWN,
    val lastCommittedRevision: Long? = null,
    /** The last replication attempt failed; cached rows remain on screen. */
    val hasError: Boolean = false,
    /** Sessions written with a different sync key and not shown. */
    val skippedRowCount: Int = 0,
) {
    enum class Compatibility {
        UNKNOWN,
        /** Versioned replication negotiated. */
        V2,
        /** The server predates v2; legacy full-index sync is in use. */
        LEGACY_SERVER,
        /** Neither could be established. Cached rows remain; never rendered as empty. */
        UNSUPPORTED,
    }
}
