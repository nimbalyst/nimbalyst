package com.nimbalyst.app.data

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.runner.RunWith
import org.junit.Test
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Room DAO round-trip tests against an in-memory database driven by Robolectric.
 *
 * Notes on schema constraints exercised here:
 *  - sessions.projectId -> projects.id (FK, CASCADE)
 *  - messages.sessionId -> sessions.id (FK, CASCADE)
 *  - queued_prompts.sessionId -> sessions.id (FK, CASCADE)
 *  - sync_state has no FK (standalone)
 *
 * Parents are always inserted before children so foreign-key enforcement
 * (Room enables it by default) never rejects a write. We use the
 * in-memory builder (not NimbalystDatabase.getInstance) so the seed
 * onCreate callback does NOT run and the DB starts empty.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class NimbalystDaoTest {

    private lateinit var db: NimbalystDatabase
    private lateinit var projectDao: ProjectDao
    private lateinit var sessionDao: SessionDao
    private lateinit var messageDao: MessageDao
    private lateinit var queuedPromptDao: QueuedPromptDao
    private lateinit var syncStateDao: SyncStateDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            NimbalystDatabase::class.java
        ).allowMainThreadQueries().build()

        projectDao = db.projectDao()
        sessionDao = db.sessionDao()
        messageDao = db.messageDao()
        queuedPromptDao = db.queuedPromptDao()
        syncStateDao = db.syncStateDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    // ---------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------

    private fun project(id: String = "/test/android", name: String = "Android Project") =
        ProjectEntity(
            id = id,
            name = name,
            sessionCount = 0,
            lastUpdatedAt = 1_700_000_000_000L,
            sortOrder = 0
        )

    private fun session(
        id: String,
        projectId: String = "/test/android",
        updatedAt: Long = 1_700_000_000_000L,
        isArchived: Boolean = false
    ) = SessionEntity(
        id = id,
        projectId = projectId,
        titleDecrypted = "Title $id",
        provider = "claude-code",
        model = "claude-sonnet-4",
        mode = "agent",
        isArchived = isArchived,
        createdAt = 1_699_000_000_000L,
        updatedAt = updatedAt,
        lastSyncedSeq = 0,
        lastMessageAt = updatedAt
    )

    private fun message(
        id: String,
        sessionId: String,
        sequence: Int,
        createdAt: Long = 1_700_000_000_000L
    ) = MessageEntity(
        id = id,
        sessionId = sessionId,
        sequence = sequence,
        source = "user",
        direction = "input",
        encryptedContent = "enc",
        iv = "iv",
        contentDecrypted = "decoded-$id",
        createdAt = createdAt
    )

    private fun queuedPrompt(
        id: String,
        sessionId: String,
        source: String? = null,
        sentAt: Long? = null,
        createdAt: Long = 1_700_000_000_000L
    ) = QueuedPromptEntity(
        id = id,
        sessionId = sessionId,
        promptTextEncrypted = "enc",
        iv = "iv",
        createdAt = createdAt,
        sentAt = sentAt,
        promptTextDecrypted = "decoded-$id",
        source = source
    )

    // ---------------------------------------------------------------------
    // ProjectDao
    // ---------------------------------------------------------------------

    @Test
    fun `project upsert insert update and delete round-trip`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a", name = "Alpha")))

        var all = projectDao.observeAll().first()
        assertEquals(1, all.size)
        assertEquals("Alpha", all[0].name)

        // Upsert with same primary key updates in place.
        projectDao.upsertAll(listOf(project(id = "/p/a", name = "Alpha Renamed")))
        all = projectDao.observeAll().first()
        assertEquals(1, all.size)
        assertEquals("Alpha Renamed", all[0].name)

        projectDao.deleteById("/p/a")
        assertTrue(projectDao.observeAll().first().isEmpty())
    }

    @Test
    fun `project observeAll respects sortOrder ascending`() = runTest {
        projectDao.upsertAll(
            listOf(
                project(id = "/p/b", name = "B").copy(sortOrder = 2),
                project(id = "/p/a", name = "A").copy(sortOrder = 1),
                project(id = "/p/c", name = "C").copy(sortOrder = 0)
            )
        )
        val ordered = projectDao.observeAll().first().map { it.id }
        assertEquals(listOf("/p/c", "/p/a", "/p/b"), ordered)
    }

    @Test
    fun `refreshProjectStats counts only non-archived sessions and latest updatedAt`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(
            listOf(
                session(id = "s1", projectId = "/p/a", updatedAt = 100L, isArchived = false),
                session(id = "s2", projectId = "/p/a", updatedAt = 300L, isArchived = false),
                session(id = "s3", projectId = "/p/a", updatedAt = 999L, isArchived = true)
            )
        )

        projectDao.refreshProjectStats("/p/a")

        val refreshed = projectDao.observeAll().first().single()
        assertEquals(2, refreshed.sessionCount)
        // MAX(updatedAt) ignores the archive flag (matches the query)
        assertEquals(999L, refreshed.lastUpdatedAt)
    }

    @Test
    fun `refreshAllProjectStats updates every project`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a"), project(id = "/p/b")))
        sessionDao.upsertAll(
            listOf(
                session(id = "a1", projectId = "/p/a", updatedAt = 100L),
                session(id = "b1", projectId = "/p/b", updatedAt = 200L),
                session(id = "b2", projectId = "/p/b", updatedAt = 250L)
            )
        )

        projectDao.refreshAllProjectStats()

        val byId = projectDao.observeAll().first().associateBy { it.id }
        assertEquals(1, byId["/p/a"]!!.sessionCount)
        assertEquals(2, byId["/p/b"]!!.sessionCount)
    }

    // ---------------------------------------------------------------------
    // SessionDao
    // ---------------------------------------------------------------------

    @Test
    fun `session upsert and getById round-trip preserves fields`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        val original = session(id = "s1", projectId = "/p/a").copy(
            phase = "implementing",
            tagsJson = """["android","sync"]""",
            contextTokens = 100,
            contextWindow = 200000,
            draftInput = "draft",
            draftUpdatedAt = 1_700_000_111_000L
        )
        sessionDao.upsertAll(listOf(original))

        val loaded = sessionDao.getById("s1")
        assertEquals(original, loaded)
    }

    @Test
    fun `observeActiveSessions excludes archived and orders by updatedAt desc`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(
            listOf(
                session(id = "old", projectId = "/p/a", updatedAt = 100L),
                session(id = "new", projectId = "/p/a", updatedAt = 900L),
                session(id = "arch", projectId = "/p/a", updatedAt = 999L, isArchived = true)
            )
        )

        val active = sessionDao.observeActiveSessions().first().map { it.id }
        assertEquals(listOf("new", "old"), active)
    }

    @Test
    fun `observeSessionsForProject filters by project`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a"), project(id = "/p/b")))
        sessionDao.upsertAll(
            listOf(
                session(id = "a1", projectId = "/p/a"),
                session(id = "b1", projectId = "/p/b")
            )
        )

        val forA = sessionDao.observeSessionsForProject("/p/a").first().map { it.id }
        assertEquals(listOf("a1"), forA)
    }

    @Test
    fun `updateSyncWatermark only advances forward`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        sessionDao.updateSyncWatermark("s1", 10)
        assertEquals(10, sessionDao.getById("s1")!!.lastSyncedSeq)

        // Lower value must not regress the watermark.
        sessionDao.updateSyncWatermark("s1", 5)
        assertEquals(10, sessionDao.getById("s1")!!.lastSyncedSeq)

        sessionDao.updateSyncWatermark("s1", 20)
        assertEquals(20, sessionDao.getById("s1")!!.lastSyncedSeq)
    }

    @Test
    fun `updateLastReadAt only advances forward`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        sessionDao.updateLastReadAt("s1", 500L)
        assertEquals(500L, sessionDao.getById("s1")!!.lastReadAt)

        sessionDao.updateLastReadAt("s1", 200L)
        assertEquals(500L, sessionDao.getById("s1")!!.lastReadAt)

        sessionDao.updateLastReadAt("s1", 800L)
        assertEquals(800L, sessionDao.getById("s1")!!.lastReadAt)
    }

    @Test
    fun `updateDraftInput persists draft and timestamp`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        sessionDao.updateDraftInput("s1", "hello draft", 1_700_000_222_000L)
        val loaded = sessionDao.getById("s1")!!
        assertEquals("hello draft", loaded.draftInput)
        assertEquals(1_700_000_222_000L, loaded.draftUpdatedAt)

        // Clearing the draft (null) is allowed.
        sessionDao.updateDraftInput("s1", null, 1_700_000_333_000L)
        assertNull(sessionDao.getById("s1")!!.draftInput)
    }

    @Test
    fun `deleteById removes session and getById returns null`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        sessionDao.deleteById("s1")
        assertNull(sessionDao.getById("s1"))
    }

    @Test
    fun `deleting a project cascades to its sessions`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        projectDao.deleteById("/p/a")
        assertNull(sessionDao.getById("s1"))
    }

    // ---------------------------------------------------------------------
    // MessageDao
    // ---------------------------------------------------------------------

    @Test
    fun `message upsert observe count and maxSequence`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))
        messageDao.upsertAll(
            listOf(
                message(id = "m2", sessionId = "s1", sequence = 2),
                message(id = "m1", sessionId = "s1", sequence = 1),
                message(id = "m3", sessionId = "s1", sequence = 3)
            )
        )

        val observed = messageDao.observeMessagesForSession("s1").first()
        // ORDER BY sequence ASC
        assertEquals(listOf("m1", "m2", "m3"), observed.map { it.id })
        assertEquals(3, messageDao.countForSession("s1"))
        assertEquals(3, messageDao.maxSequenceForSession("s1"))
    }

    @Test
    fun `maxSequence returns zero for empty session`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        assertEquals(0, messageDao.maxSequenceForSession("s1"))
        assertEquals(0, messageDao.countForSession("s1"))
    }

    @Test
    fun `message upsert updates existing by primary key`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        messageDao.upsertAll(listOf(message(id = "m1", sessionId = "s1", sequence = 1)))
        messageDao.upsertAll(
            listOf(
                message(id = "m1", sessionId = "s1", sequence = 1)
                    .copy(contentDecrypted = "updated")
            )
        )

        val observed = messageDao.observeMessagesForSession("s1").first()
        assertEquals(1, observed.size)
        assertEquals("updated", observed[0].contentDecrypted)
    }

    @Test
    fun `deleteForSession removes only that session's messages`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(
            listOf(
                session(id = "s1", projectId = "/p/a"),
                session(id = "s2", projectId = "/p/a")
            )
        )
        messageDao.upsertAll(
            listOf(
                message(id = "m1", sessionId = "s1", sequence = 1),
                message(id = "m2", sessionId = "s2", sequence = 1)
            )
        )

        messageDao.deleteForSession("s1")
        assertEquals(0, messageDao.countForSession("s1"))
        assertEquals(1, messageDao.countForSession("s2"))
    }

    @Test
    fun `deleting a session cascades to its messages`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))
        messageDao.upsertAll(listOf(message(id = "m1", sessionId = "s1", sequence = 1)))

        sessionDao.deleteById("s1")
        assertEquals(0, messageDao.countForSession("s1"))
    }

    // ---------------------------------------------------------------------
    // QueuedPromptDao
    // ---------------------------------------------------------------------

    @Test
    fun `queued prompt upsert single and observe ordered by createdAt`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        queuedPromptDao.upsert(queuedPrompt(id = "q2", sessionId = "s1", createdAt = 200L))
        queuedPromptDao.upsert(queuedPrompt(id = "q1", sessionId = "s1", createdAt = 100L))

        val observed = queuedPromptDao.observeQueuedPromptsForSession("s1").first()
        assertEquals(listOf("q1", "q2"), observed.map { it.id })
    }

    @Test
    fun `deleteRemoteForSession keeps purely local prompts but removes sourced or sent ones`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))

        queuedPromptDao.upsertAll(
            listOf(
                // local-only: source null and sentAt null -> kept
                queuedPrompt(id = "local", sessionId = "s1", source = null, sentAt = null),
                // has source -> removed
                queuedPrompt(id = "remote", sessionId = "s1", source = "mobile", sentAt = null),
                // has sentAt -> removed
                queuedPrompt(id = "sent", sessionId = "s1", source = null, sentAt = 500L)
            )
        )

        queuedPromptDao.deleteRemoteForSession("s1")

        val remaining = queuedPromptDao.observeQueuedPromptsForSession("s1").first().map { it.id }
        assertEquals(listOf("local"), remaining)
    }

    @Test
    fun `deleting a session cascades to its queued prompts`() = runTest {
        projectDao.upsertAll(listOf(project(id = "/p/a")))
        sessionDao.upsertAll(listOf(session(id = "s1", projectId = "/p/a")))
        queuedPromptDao.upsert(queuedPrompt(id = "q1", sessionId = "s1"))

        sessionDao.deleteById("s1")
        assertTrue(queuedPromptDao.observeQueuedPromptsForSession("s1").first().isEmpty())
    }

    // ---------------------------------------------------------------------
    // SyncStateDao
    // ---------------------------------------------------------------------

    @Test
    fun `sync state upsert and getByRoomId round-trip`() = runTest {
        val state = SyncStateEntity(
            roomId = "room-1",
            lastCursor = "cursor-1",
            lastSequence = 42,
            lastSyncedAt = 1_700_000_000_000L
        )
        syncStateDao.upsert(state)

        assertEquals(state, syncStateDao.getByRoomId("room-1"))
    }

    @Test
    fun `sync state upsert updates existing room`() = runTest {
        syncStateDao.upsert(SyncStateEntity(roomId = "room-1", lastSequence = 1))
        syncStateDao.upsert(
            SyncStateEntity(roomId = "room-1", lastCursor = "c2", lastSequence = 99, lastSyncedAt = 5L)
        )

        val loaded = syncStateDao.getByRoomId("room-1")!!
        assertEquals(99, loaded.lastSequence)
        assertEquals("c2", loaded.lastCursor)
    }

    @Test
    fun `getByRoomId returns null for unknown room`() = runTest {
        assertNull(syncStateDao.getByRoomId("missing"))
    }
}
