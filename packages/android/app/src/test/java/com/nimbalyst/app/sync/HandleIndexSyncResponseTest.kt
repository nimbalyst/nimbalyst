package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.QueuedPromptEntity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Unit tests for the canPrune gate in [IndexMessageHandler.applyIndexSnapshot].
 *
 * Strategy: Approach B — the gate logic is extracted into the internal companion
 * seam [IndexMessageHandler.applyIndexSnapshot]. Tests call it directly with a real
 * [NimbalystRepository] backed by an in-memory Room database. No SyncManager
 * instance is constructed, which sidesteps the [PairingStore] ->
 * [EncryptedSharedPreferences] -> Android KeyStore dependency that is
 * unavailable in Robolectric unit tests.
 *
 * The four scenarios from the PR review spec:
 *   raw=3, decoded=0  -> replace path: stale entries survive, no prune
 *   raw=3, decoded=2  -> replace path: stale entries survive, no prune
 *   raw=3, decoded=3  -> reconcile path: stale entry pruned, decoded entries present
 *   raw=0, decoded=0  -> reconcile with empty list: cache is cleared (server is genuinely empty)
 *
 * The discriminator: seed a "stale" project whose id is NOT in the decoded
 * list. After applyIndexSnapshot, assert its survival (replace path) or
 * pruning (reconcile path).
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class HandleIndexSyncResponseTest {

    private lateinit var db: NimbalystDatabase
    private lateinit var repository: NimbalystRepository

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        db = Room.inMemoryDatabaseBuilder(context, NimbalystDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        repository = NimbalystRepository(db)
    }

    @After
    fun tearDown() {
        db.close()
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    private fun project(id: String, name: String = "Project $id") = ProjectEntity(
        id = id,
        name = name,
        sessionCount = 0,
        lastUpdatedAt = 1_700_000_000_000L,
        sortOrder = 0
    )

    private val syncedAt = 1_700_000_000_000L

    // -------------------------------------------------------------------------
    // Tests
    // -------------------------------------------------------------------------

    /**
     * raw=3, decoded=0: all entries failed to decrypt.
     * Expect replace path: stale project in cache must survive.
     */
    @Test
    fun `raw=3 decoded=0 uses replace path and stale project survives`() = runTest {
        repository.replaceIndexSnapshot(
            projects = listOf(project("stale")),
            sessions = emptyList(),
            syncedAt = syncedAt - 1
        )

        IndexMessageHandler.applyIndexSnapshot(
            repository = repository,
            projects = emptyList(),
            sessions = emptyList(),
            rawProjectCount = 3,
            syncedAt = syncedAt
        )

        val projects = repository.observeProjects().first()
        assertEquals(
            "stale project must survive when all entries fail to decrypt",
            listOf("stale"),
            projects.map { it.id }
        )
    }

    /**
     * raw=3, decoded=2: partial decrypt failure.
     * Expect replace path: stale project must survive, decoded entries upserted.
     */
    @Test
    fun `raw=3 decoded=2 uses replace path and stale project survives`() = runTest {
        repository.replaceIndexSnapshot(
            projects = listOf(project("stale")),
            sessions = emptyList(),
            syncedAt = syncedAt - 1
        )

        val decoded = listOf(project("p1"), project("p2"))
        IndexMessageHandler.applyIndexSnapshot(
            repository = repository,
            projects = decoded,
            sessions = emptyList(),
            rawProjectCount = 3,
            syncedAt = syncedAt
        )

        val ids = repository.observeProjects().first().map { it.id }.toSet()
        assertTrue("stale project must survive after partial decrypt failure", "stale" in ids)
        assertTrue("decoded p1 must be upserted", "p1" in ids)
        assertTrue("decoded p2 must be upserted", "p2" in ids)
    }

    /**
     * raw=3, decoded=3: all entries decrypted successfully.
     * Expect reconcile path: stale project is pruned, exactly the 3 decoded entries remain.
     */
    @Test
    fun `raw=3 decoded=3 uses reconcile path and stale project is pruned`() = runTest {
        repository.replaceIndexSnapshot(
            projects = listOf(project("stale")),
            sessions = emptyList(),
            syncedAt = syncedAt - 1
        )

        val decoded = listOf(project("p1"), project("p2"), project("p3"))
        IndexMessageHandler.applyIndexSnapshot(
            repository = repository,
            projects = decoded,
            sessions = emptyList(),
            rawProjectCount = 3,
            syncedAt = syncedAt
        )

        val ids = repository.observeProjects().first().map { it.id }.toSet()
        assertEquals("exactly 3 entries must remain after reconcile", setOf("p1", "p2", "p3"), ids)
        assertTrue("stale project must be pruned by reconcile", "stale" !in ids)
    }

    /**
     * raw=0, decoded=0: server sent an empty list (user has no projects).
     * Expect reconcile path with deleteAll: cache is cleared.
     */
    @Test
    fun `raw=0 decoded=0 uses reconcile path and clears the cache`() = runTest {
        repository.replaceIndexSnapshot(
            projects = listOf(project("existing")),
            sessions = emptyList(),
            syncedAt = syncedAt - 1
        )

        IndexMessageHandler.applyIndexSnapshot(
            repository = repository,
            projects = emptyList(),
            sessions = emptyList(),
            rawProjectCount = 0,
            syncedAt = syncedAt
        )

        val projects = repository.observeProjects().first()
        assertTrue(
            "cache must be empty when server sends an empty project list",
            projects.isEmpty()
        )
    }

    @Test
    fun `a project entry without config keeps the stored commands, actions and remote hash`() = runTest {
        val configured = project("/p").copy(commandsJson = "[{\"name\":\"review\"}]", actionsJson = "[]", gitRemoteHash = "h1", localWikiFolder = "docs/wiki", localWikiTypesJson = "[]")
        repository.replaceIndexSnapshot(projects = listOf(configured), sessions = emptyList(), syncedAt = 1L)

        // A stats-only project broadcast carries no config.
        repository.replaceIndexSnapshot(projects = listOf(project("/p").copy(sessionCount = 4)), sessions = emptyList(), syncedAt = 2L)

        val stored = repository.observeProjects().first().single()
        assertEquals(configured.commandsJson, stored.commandsJson)
        assertEquals("[]", stored.actionsJson)
        assertEquals("h1", stored.gitRemoteHash)
        assertEquals("docs/wiki", stored.localWikiFolder)
        assertEquals("[]", stored.localWikiTypesJson)

        // A config without a wiki is authoritative: the folder goes away.
        repository.replaceIndexSnapshot(projects = listOf(project("/p").copy(commandsJson = "[]")), sessions = emptyList(), syncedAt = 3L)
        val cleared = repository.observeProjects().first().single()
        assertNull(cleared.localWikiFolder)
        assertNull(cleared.localWikiTypesJson)
    }

    /** R2a-4: a truncated session list proves nothing about the sessions it omits, or their projects. */
    @Test
    fun `a partial snapshot never deletes a project that cached sessions still reference`() = runTest {
        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p"), project("/q")), listOf(session("s1", "/p"), session("s2", "/q")), 2, syncedAt
        )
        repository.persistSessionMessages("s2", listOf(message("m1", "s2", 1)), null, 1, syncedAt)

        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p")), listOf(session("s1", "/p")), 1, syncedAt + 1, sessionsComplete = false
        )

        assertTrue(repository.getSession("s2") != null)
        assertEquals(1, repository.messageCount("s2"))
    }

    /** R2a-8: an unsent draft or an undelivered local prompt exists only on this device. */
    @Test
    fun `a complete snapshot keeps sessions holding local work, and their projects`() = runTest {
        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p"), project("/q")),
            listOf(session("s1", "/p"), session("drafted", "/q"), session("queued", "/q"), session("gone", "/q")), 2, syncedAt
        )
        repository.updateDraftInput("drafted", "unsent", 1L)
        repository.upsertQueuedPrompt(QueuedPromptEntity("q1", "queued", "e", "iv", createdAt = 1L))

        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p")), listOf(session("s1", "/p")), 1, syncedAt + 1, sessionsComplete = true
        )

        assertEquals(null, repository.getSession("gone"))
        assertEquals("unsent", repository.getSession("drafted")?.draftInput)
        assertEquals(listOf("q1"), db.queuedPromptDao().observeQueuedPromptsForSession("queued").first().map { it.id })
    }

    private fun session(id: String, projectId: String) =
        com.nimbalyst.app.data.SessionEntity(id = id, projectId = projectId, createdAt = 1L, updatedAt = 2L)

    private fun message(id: String, sessionId: String, sequence: Int) = com.nimbalyst.app.data.MessageEntity(
        id = id, sessionId = sessionId, sequence = sequence, source = "user", direction = "input", createdAt = 1L
    )

    /**
     * R1-3: a complete snapshot whose project list omits a project that one of
     * its sessions still names must not delete that project. Deleting it
     * cascades through the session's messages while the room watermark
     * survives, so the next resume skips the lost history for good.
     */
    @Test
    fun `a pruning snapshot keeps a project its sessions still reference, with their history`() = runTest {
        IndexMessageHandler.applyIndexSnapshot(repository, listOf(project("/p")), listOf(session("s1", "/p")), 1, syncedAt)
        repository.persistSessionMessages("s1", listOf(message("m1", "s1", 1), message("m2", "s1", 2)), null, 2, syncedAt)

        IndexMessageHandler.applyIndexSnapshot(repository, listOf(project("/q")), listOf(session("s1", "/p")), 1, syncedAt + 1)

        assertEquals(2, repository.messageCount("s1"))
        assertEquals(2, repository.syncState("s1")!!.lastSequence)
        assertEquals(setOf("/p", "/q"), repository.observeProjects().first().map { it.id }.toSet())
    }

    /** F2: a project the index has not sent yet is provisional: stored for its sessions, never listed. */
    @Test
    fun `a placeholder project is not listed until its entry arrives, and is pruned once unreferenced`() = runTest {
        IndexMessageHandler.applyIndexSnapshot(repository, listOf(project("/p")), listOf(session("s1", "/p")), 1, syncedAt)
        repository.upsertSession(session("s2", "/new"))
        assertEquals(listOf("/p"), repository.observeProjects().first().map { it.id })

        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p"), project("/new")), listOf(session("s1", "/p"), session("s2", "/new")), 2, syncedAt + 1
        )
        assertEquals(setOf("/p", "/new"), repository.observeProjects().first().map { it.id }.toSet())

        repository.upsertSession(session("s3", "/gone"))
        repository.deleteSession("s3")
        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p"), project("/new")), listOf(session("s1", "/p"), session("s2", "/new")), 2, syncedAt + 2
        )
        assertEquals(null, db.projectDao().getByIds(listOf("/gone")).firstOrNull())
    }

    /** Deleting a session's history also forgets its resume point, so a later join starts from the beginning. */
    @Test
    fun `a deleted session leaves no watermark behind`() = runTest {
        IndexMessageHandler.applyIndexSnapshot(repository, listOf(project("/p")), listOf(session("s1", "/p")), 1, syncedAt)
        repository.persistSessionMessages("s1", listOf(message("m1", "s1", 1)), null, 1, syncedAt)

        repository.deleteSession("s1")

        assertEquals(null, repository.syncState("s1"))
    }

    @Test
    fun `a complete snapshot prunes sessions the server no longer has, a truncated one does not`() = runTest {
        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p")), listOf(session("s1", "/p"), session("s2", "/p")), 1, syncedAt
        )
        repository.persistSessionMessages("s2", listOf(message("m1", "s2", 1)), null, 1, syncedAt)

        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p")), listOf(session("s1", "/p")), 1, syncedAt + 1, sessionsComplete = false
        )
        assertTrue(repository.getSession("s2") != null)

        IndexMessageHandler.applyIndexSnapshot(
            repository, listOf(project("/p")), listOf(session("s1", "/p")), 1, syncedAt + 2, sessionsComplete = true
        )
        assertEquals(null, repository.getSession("s2"))
        assertEquals(null, repository.syncState("s2"))
        assertTrue(repository.getSession("s1") != null)
    }

    @Test
    fun `only a complete snapshot with many rows and none readable flags an encryption mismatch`() {
        fun response(sessions: Int, total: Int?) = IndexSyncResponse(
            type = "indexSyncResponse",
            sessions = List(sessions) { ServerSessionEntry("s$it", "e", "iv", createdAt = 1, updatedAt = 1) },
            totalSessionCount = total
        )
        val mismatch = SnapshotHealth.of(response(8, 8), readableSessions = 0, readableProjects = 0)
        assertTrue(mismatch.encryptionMismatch)
        assertEquals(8, mismatch.unreadableSessions)
        assertTrue("an unreadable row is not proof the session is gone", !mismatch.isComplete)

        assertTrue("one readable row disproves a key mismatch",
            !SnapshotHealth.of(response(8, 8), readableSessions = 1, readableProjects = 0).encryptionMismatch)
        assertTrue("a truncated response proves nothing",
            !SnapshotHealth.of(response(8, 20), readableSessions = 0, readableProjects = 0).encryptionMismatch)
        assertTrue(SnapshotHealth.of(response(3, 3), readableSessions = 3, readableProjects = 0).isComplete)
        assertTrue(!SnapshotHealth.of(response(3, 9), readableSessions = 3, readableProjects = 0).isComplete)
    }
}
