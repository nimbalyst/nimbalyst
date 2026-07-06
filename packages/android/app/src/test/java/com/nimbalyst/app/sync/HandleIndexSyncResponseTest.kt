package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Unit tests for the canPrune gate in [SyncManager.applyIndexSnapshot].
 *
 * Strategy: Approach B — the gate logic is extracted into the internal companion
 * seam [SyncManager.applyIndexSnapshot]. Tests call it directly with a real
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

        SyncManager.applyIndexSnapshot(
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
        SyncManager.applyIndexSnapshot(
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
        SyncManager.applyIndexSnapshot(
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

        SyncManager.applyIndexSnapshot(
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
}
