package com.nimbalyst.app.sync

/**
 * What a full index response proves. Mirrors the iOS rules in
 * `IndexIngestion`: a truncated response is not a complete index and its
 * absent rows are evidence of nothing, and only a complete response with
 * several rows and none readable says the pairing key is wrong.
 */
internal data class SnapshotHealth(
    val unreadableSessions: Int,
    /** Every session and project is present and readable: absent rows may be pruned. */
    val isComplete: Boolean,
    val encryptionMismatch: Boolean,
) {
    companion object {
        private const val MISMATCH_MIN_UNREADABLE = 5

        fun of(response: IndexSyncResponse, readableSessions: Int, readableProjects: Int): SnapshotHealth {
            val unreadable = response.sessions.size - readableSessions
            val truncated = response.totalSessionCount?.let { it != response.sessions.size } == true
            return SnapshotHealth(
                unreadableSessions = unreadable,
                isComplete = !truncated && unreadable == 0 && readableProjects == response.projects.size,
                encryptionMismatch = !truncated && isEncryptionMismatch(readableSessions, unreadable)
            )
        }

        /** Over a complete enumeration: several rows, and none this key can read. */
        fun isEncryptionMismatch(readable: Int, unreadable: Int): Boolean =
            unreadable > MISMATCH_MIN_UNREADABLE && readable == 0
    }
}
