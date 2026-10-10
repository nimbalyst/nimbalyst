package com.nimbalyst.app.data

import androidx.room.withTransaction

/**
 * Durable side of versioned (v2) index replication: per-row revisions,
 * tombstones, bootstrap coverage, and the cursor. Port of iOS
 * `IndexReplicationStore` + `IndexReplicationApplier`. Three rules:
 *  - A row's stored revision, a tombstone's included, rejects anything at or
 *    below it, so an older page can neither resurrect nor overwrite.
 *  - A page's rows and the cursor it proves commit in one transaction.
 *  - A bootstrap's coverage is recorded on disk, and the cursor plus
 *    `historyComplete` are written only after reconciliation succeeds.
 */
class IndexReplicationStore(private val database: NimbalystDatabase) {
    private val dao get() = database.indexReplicationDao()

    /**
     * One change on a page, in the order the server listed it. The journal
     * lists an id once per change in revision order, so the same id can appear
     * twice on one page (deleted at 11, recreated at 12); ops apply in order.
     */
    sealed interface Op {
        /** The id the server keys this row by (a project's is its encrypted id). */
        val wireId: String
        val entity: String
        val revision: Long

        data class Session(
            val session: SessionEntity,
            override val revision: Long,
            /** Replaces the desktop-sourced queue; null leaves it as is. */
            val queuedPrompts: List<QueuedPromptEntity>? = null,
            val clearQueuedPrompts: Boolean = false,
        ) : Op {
            override val wireId get() = session.id
            override val entity get() = SESSION
        }

        data class Project(val project: ProjectEntity, override val wireId: String, override val revision: Long) : Op {
            override val entity get() = PROJECT
        }

        data class SessionDelete(val sessionId: String, override val revision: Long) : Op {
            override val wireId get() = sessionId
            override val entity get() = SESSION
        }

        /** [projectId] is the decrypted local id. */
        data class ProjectDelete(val projectId: String, override val wireId: String, override val revision: Long) : Op {
            override val entity get() = PROJECT
        }

        /** Recorded for ordering only: an unreadable entry, or a file entry this app does not store. */
        data class Bookkeeping(val row: IndexRowRevisionEntity) : Op {
            override val wireId get() = row.id
            override val entity get() = row.entity
            override val revision get() = row.revision
        }
    }

    data class PageWrite(
        val operations: List<Op> = emptyList(),
        /** Every entry on the page, for a bootstrap run's coverage. */
        val seen: List<Pair<String, String>> = emptyList(),
        val bootstrapRunId: String? = null,
        /** A delta's proven cursor, committed with the rows. */
        val commitCursor: Long? = null,
        /** A bootstrap terminal: commit rows now, the cursor after reconciliation. */
        val beginFinalization: Long? = null,
    )

    data class PageResult(
        val appliedSessionIds: Set<String>,
        val staleRejected: Int,
        /** The rows as committed, for signals that must describe only what landed. */
        val committedSessions: List<SessionEntity> = emptyList(),
    )

    /** What a finished bootstrap proved, counted over the whole run rather than one page. */
    data class Finalization(val removed: Int, val readableSessions: Int, val unreadableSessions: Int)

    suspend fun apply(write: PageWrite, now: Long = System.currentTimeMillis()): PageResult =
        database.withTransaction {
            var stale = 0
            val applied = LinkedHashSet<String>()
            val revisions = HashMap<String, IndexRowRevisionEntity>()
            write.operations.groupBy({ it.entity }, { it.wireId }).forEach { (entity, ids) ->
                ids.distinct().chunked(500).forEach { chunk ->
                    dao.revisions(entity, chunk).forEach { revisions[key(entity, it.id)] = it }
                }
            }
            // Each accepted op moves the row's revision at once, so a later op
            // on the same page is judged against it, not against the page start.
            val recorded = LinkedHashMap<String, IndexRowRevisionEntity>()
            fun record(row: IndexRowRevisionEntity) {
                revisions[key(row.entity, row.id)] = row
                recorded[key(row.entity, row.id)] = row
            }

            for (op in write.operations) {
                val stored = revisions[key(op.entity, op.wireId)]
                if (stored != null && op.revision <= stored.revision) {
                    stale++
                    continue
                }
                when (op) {
                    is Op.Project -> {
                        val existing = database.projectDao().getByIds(listOf(op.project.id)).singleOrNull()
                        database.projectDao().upsertAll(listOf(op.project.copy(
                            commandsJson = op.project.commandsJson ?: existing?.commandsJson,
                            actionsJson = op.project.actionsJson ?: existing?.actionsJson,
                            gitRemoteHash = op.project.gitRemoteHash ?: existing?.gitRemoteHash,
                            // A present config (commandsJson set) says whether there is a wiki; no config keeps it.
                            localWikiFolder = if (op.project.commandsJson != null) op.project.localWikiFolder else existing?.localWikiFolder,
                            localWikiTypesJson = if (op.project.commandsJson != null) op.project.localWikiTypesJson else existing?.localWikiTypesJson,
                        )))
                        record(IndexRowRevisionEntity(PROJECT, op.wireId, op.revision))
                    }
                    is Op.Session -> {
                        val id = op.session.id
                        database.projectDao().insertIfMissing(listOf(NimbalystRepository.placeholderProject(op.session.projectId)))
                        database.sessionDao().upsertAll(listOf(op.session))
                        // In this transaction, after the row exists: a rejected
                        // revision never touches the queue, and the queue never
                        // lands apart from the revision that carried it.
                        if (op.queuedPrompts != null || op.clearQueuedPrompts) {
                            database.queuedPromptDao().deleteRemoteForSession(id)
                            op.queuedPrompts?.takeIf { it.isNotEmpty() }?.let { database.queuedPromptDao().upsertAll(it) }
                        }
                        applied += id
                        record(IndexRowRevisionEntity(SESSION, id, op.revision))
                    }
                    is Op.SessionDelete -> {
                        // Work only this device has keeps the row, and its
                        // tombstone, until that work is gone.
                        if (!dao.hasLocalWork(op.sessionId)) database.sessionDao().deleteById(op.sessionId)
                        applied -= op.sessionId
                        record(IndexRowRevisionEntity(SESSION, op.wireId, op.revision, deleted = true))
                    }
                    is Op.ProjectDelete -> {
                        // Deleting a project cascades through every cached session and
                        // message under it. Hide it instead; the provisional prune
                        // removes it once no session references it.
                        database.projectDao().getByIds(listOf(op.projectId)).singleOrNull()?.let {
                            database.projectDao().upsertAll(listOf(it.copy(isProvisional = true)))
                        }
                        record(IndexRowRevisionEntity(PROJECT, op.wireId, op.revision, deleted = true))
                    }
                    // A later unreadable revision keeps the cached row; only
                    // ordering and the advisory count change.
                    is Op.Bookkeeping -> record(op.row)
                }
            }
            if (recorded.isNotEmpty()) dao.upsertRevisions(recorded.values.toList())

            write.bootstrapRunId?.let { runId ->
                if (write.seen.isNotEmpty()) dao.recordSeen(write.seen.map { IndexBootstrapSeenEntity(runId, it.first, it.second) })
                write.beginFinalization?.let { dao.beginFinalization(IndexBootstrapFinalizationEntity(runId, it, now)) }
            }
            write.commitCursor?.let { cursor ->
                val current = dao.cursor(SCOPE)
                dao.upsertCursor(IndexReplicationCursorEntity(SCOPE, cursor, current?.historyComplete ?: false))
            }

            database.projectDao().deleteUnreferencedProvisional()
            database.syncStateDao().deleteOrphanedSessionRooms()
            database.projectDao().refreshAllProjectStats()
            val committed = applied.chunked(500).flatMap { database.sessionDao().getByIds(it) }
            PageResult(applied, stale, committed)
        }

    suspend fun cursorState(): IndexReplicationCursorEntity = dao.cursor(SCOPE) ?: IndexReplicationCursorEntity(SCOPE)

    suspend fun pendingFinalization(): IndexBootstrapFinalizationEntity? = dao.pendingFinalization()

    suspend fun skippedRowCount(): Int = dao.unreadableSessionCount()

    /**
     * Finishes a bootstrap: removes cached sessions the proven-complete
     * enumeration never listed, in bounded transactions, then commits the
     * cursor and `historyComplete` together with clearing the marker. If the
     * process dies partway the marker survives and the next connection resumes
     * here, never having claimed coverage it did not finish proving. Returns
     * how many sessions were removed and how readable the run was.
     */
    suspend fun finalizeBootstrap(runId: String): Finalization {
        var removed = 0
        var readable = 0
        var unreadable = 0
        while (true) {
            val absent = database.withTransaction {
                val ids = dao.sessionIdsAbsentFromRun(runId, RECONCILE_BATCH)
                if (ids.isNotEmpty()) database.sessionDao().deleteByIds(ids)
                ids
            }
            if (absent.isEmpty()) break
            removed += absent.size
        }
        database.withTransaction {
            val pending = dao.pendingFinalization()?.takeIf { it.runId == runId } ?: return@withTransaction
            dao.purgeableTombstonedSessionIds(RECONCILE_BATCH).takeIf { it.isNotEmpty() }
                ?.let { database.sessionDao().deleteByIds(it) }
            dao.upsertCursor(IndexReplicationCursorEntity(SCOPE, pending.cursor, historyComplete = true))
            // Expired rows the server no longer lists stop counting as unreadable.
            dao.clearUnreadableAbsentFromRun(runId)
            unreadable = dao.unreadableSessionsInRun(runId)
            readable = dao.liveSessionsInRun(runId) - unreadable
            dao.clearSeen(runId)
            dao.clearFinalization(runId)
            database.projectDao().deleteUnreferencedProvisional()
            database.syncStateDao().deleteOrphanedSessionRooms()
            database.projectDao().refreshAllProjectStats()
        }
        return Finalization(removed, readable, unreadable)
    }

    /**
     * The server refused our cursor: start a new replication epoch. Port of
     * iOS `resetReplicationEpoch`. A reset can mean the room was rebuilt with a
     * lower head, so every old revision and tombstone goes too; kept, they
     * would reject the whole fresh bootstrap as stale while its terminal still
     * claimed complete history. A half-finished enumeration and a finalization
     * owed from before the reset prove nothing about the new epoch. Cached
     * rows and local work stay; the new bootstrap's reconciliation, never the
     * reset, decides what is absent.
     */
    suspend fun resetReplicationEpoch() {
        database.withTransaction {
            dao.upsertCursor(IndexReplicationCursorEntity(SCOPE, 0, historyComplete = false))
            dao.clearRevisions()
            dao.clearAllSeen()
            dao.clearAllFinalizations()
        }
    }

    /** Parents and meta-agent owners of [sessionIds] that are not cached, for a lookup's ancestor hop. */
    suspend fun missingAncestors(sessionIds: List<String>): List<String> {
        val sessions = database.sessionDao().getByIds(sessionIds)
        val wanted = sessions.flatMap { listOfNotNull(it.parentSessionId, it.createdBySessionId) }.distinct()
        if (wanted.isEmpty()) return emptyList()
        val present = database.sessionDao().getByIds(wanted).mapTo(HashSet()) { it.id }
        return wanted.filterNot { it in present }
    }

    companion object {
        const val SCOPE = "index"
        const val SESSION = "session"
        const val PROJECT = "project"
        const val FILE = "file"
        private const val RECONCILE_BATCH = 200

        private fun key(entity: String, id: String) = "$entity\u001f$id"
    }
}
