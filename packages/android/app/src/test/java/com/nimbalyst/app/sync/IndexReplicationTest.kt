package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.QueuedPromptEntity
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingCredentials
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Versioned (v2) index replication, driven through the real [SyncManager] against a fake socket. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class IndexReplicationTest {
    private val crypto = CryptoManager.fromSeed("seed", "user-1")
    private val factory = FakeSocketFactory()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var db: NimbalystDatabase
    private lateinit var repository: NimbalystRepository
    private lateinit var manager: SyncManager
    private lateinit var index: FakeSocketFactory.FakeSocket

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(context, NimbalystDatabase::class.java).allowMainThreadQueries().build()
        db.openHelper.writableDatabase
        repository = NimbalystRepository(db)
        val credentials = PairingCredentials(
            serverUrl = "https://sync.example", encryptionSeed = "seed", authJwt = "jwt",
            authUserId = "user-1", orgId = "org-1", sessionToken = "t"
        )
        manager = SyncManager(
            context, repository,
            object : SyncCredentialStore {
                override var credentials: PairingCredentials? = credentials
                override fun save(credentials: PairingCredentials) = Unit
            },
            NotificationManager(context), scope, factory, TokenRefresher { TokenRefresh.Refreshed(it) }
        )
    }

    @After
    fun tearDown() {
        scope.cancel()
        db.close()
    }

    private suspend fun connect() {
        manager.connect()
        index = factory.sockets.last().also { it.open() }
        idle()
    }

    private suspend fun idle() = withTimeout(10_000) { manager.awaitIngestionIdle() }

    private fun requests(): List<JsonObject> = index.sent.map { JsonParser.parseString(it).asJsonObject }
        .filter { it.get("type").asString == "indexPageRequest" }

    private fun lastRequest() = requests().last()

    private fun session(id: String, extra: JsonObject.() -> Unit = {}) = JsonObject().apply {
        addProperty("sessionId", id)
        addProperty("encryptedProjectId", crypto.encryptProjectId("/p"))
        addProperty("projectIdIv", CryptoManager.projectIdIvBase64)
        addProperty("createdAt", 1L)
        addProperty("updatedAt", 2L)
        extra()
    }

    private fun change(id: String, revision: Long, deleted: Boolean = false, extra: JsonObject.() -> Unit = {}) =
        JsonObject().apply {
            addProperty("entity", "session")
            addProperty("id", id)
            addProperty("revision", revision)
            addProperty("deleted", deleted)
            if (!deleted) add("session", session(id, extra))
        }

    /** Answers the request in flight. */
    private suspend fun answer(
        entries: List<JsonObject> = emptyList(),
        complete: Boolean = true,
        cursor: Long? = null,
        token: String? = null,
        reset: Boolean = false,
    ) {
        val request = lastRequest()
        index.message(JsonObject().apply {
            addProperty("type", "indexPageResponse")
            addProperty("protocolVersion", 2)
            addProperty("requestId", request.get("requestId").asString)
            addProperty("mode", request.get("mode").asString)
            add("entries", JsonArray().apply { entries.forEach(::add) })
            addProperty("complete", complete)
            cursor?.let { addProperty("cursor", it) }
            token?.let { addProperty("nextPageToken", it) }
            if (reset) addProperty("resetRequired", true)
        }.toString())
        idle()
    }

    @Test
    fun `a server without v2 answers the seed with unknown_message_type and legacy sync takes over`() = runBlocking<Unit> {
        connect()
        assertEquals("recent", lastRequest().get("mode").asString)
        assertEquals(100, lastRequest().get("limit").asInt)

        index.message("""{"type":"error","code":"unknown_message_type","message":"Unknown message type"}""")
        idle()

        assertTrue(index.sent.any { it.contains("\"indexSyncRequest\"") })
        assertEquals(IndexCoverage.Compatibility.LEGACY_SERVER, manager.indexCoverage.value.compatibility)
    }

    @Test
    fun `seed, bootstrap, finalization, then deltas, and the cursor moves only when a range is proven`() = runBlocking<Unit> {
        // Cached from an earlier install: one the server no longer has, one with a local draft.
        repository.replaceIndexSnapshot(
            listOf(ProjectEntity("/p", "p")),
            listOf(
                SessionEntity(id = "gone", projectId = "/p", createdAt = 1, updatedAt = 1),
                SessionEntity(id = "drafted", projectId = "/p", createdAt = 1, updatedAt = 1, draftInput = "unsent"),
                SessionEntity(id = "queued", projectId = "/p", createdAt = 1, updatedAt = 1),
            ),
            1L
        )
        repository.upsertQueuedPrompt(QueuedPromptEntity("q1", "queued", "e", "iv", createdAt = 1L))
        connect()
        answer(listOf(change("s1", 5)))
        assertEquals(IndexCoverage.Compatibility.V2, manager.indexCoverage.value.compatibility)
        assertEquals("bootstrap", lastRequest().get("mode").asString)

        answer(listOf(change("s1", 5), change("s2", 6)), complete = false, token = "t1")
        assertEquals("a partial bootstrap proves nothing", null, manager.indexCoverage.value.lastCommittedRevision)
        assertEquals("t1", lastRequest().get("pageToken").asString)

        answer(complete = true, cursor = 10)
        val coverage = manager.indexCoverage.value
        assertTrue(coverage.historyComplete)
        assertEquals(10L, coverage.lastCommittedRevision)
        assertNull("absent from proven coverage", repository.getSession("gone"))
        assertNotNull("a local draft is never reconciled away", repository.getSession("drafted"))
        assertNotNull("nor an undelivered local prompt", repository.getSession("queued"))
        assertNotNull(repository.getSession("s2"))

        index.message("""{"type":"indexChangesAvailable","revision":12}""")
        idle()
        assertEquals("delta", lastRequest().get("mode").asString)
        assertEquals(10L, lastRequest().get("sinceRevision").asLong)

        answer(listOf(change("s2", 11, deleted = true)), complete = true, cursor = 12)
        assertNull(repository.getSession("s2"))
        assertEquals(12L, manager.indexCoverage.value.lastCommittedRevision)

        // An older copy (a slow lookup, a replay) cannot resurrect the tombstone.
        manager.requestSessionIndexLookup("s2")
        idle()
        assertEquals(listOf("s2"), lastRequest().getAsJsonArray("sessionIds").map { it.asString })
        answer(listOf(change("s2", 6)))
        assertNull(repository.getSession("s2"))
    }

    @Test
    fun `a lookup fetches the session, then its missing workstream`() = runBlocking<Unit> {
        connect()
        answer()
        answer(complete = true, cursor = 1)

        manager.requestSessionIndexLookup("child")
        idle()
        answer(listOf(change("child", 3) { addProperty("parentSessionId", "ws") }))
        assertNotNull(repository.getSession("child"))
        assertEquals(listOf("ws"), lastRequest().getAsJsonArray("sessionIds").map { it.asString })
        assertEquals("a lookup never moves the cursor", 1L, manager.indexCoverage.value.lastCommittedRevision)
    }

    @Test
    fun `a rejected cursor resets coverage and bootstraps again, keeping cached rows`() = runBlocking<Unit> {
        connect()
        answer()
        answer(listOf(change("s1", 2)), complete = true, cursor = 4)
        index.message("""{"type":"indexChangesAvailable","revision":9}""")
        idle()

        answer(complete = false, reset = true)

        assertFalse(manager.indexCoverage.value.historyComplete)
        assertEquals("bootstrap", lastRequest().get("mode").asString)
        assertNotNull(repository.getSession("s1"))
    }

    private fun titled(title: String): JsonObject.() -> Unit = {
        val encrypted = crypto.encrypt(title)
        addProperty("encryptedTitle", encrypted.encrypted)
        addProperty("titleIv", encrypted.iv)
    }

    /** A title another key wrote: the row proves coverage but cannot be applied. */
    private val unreadable: JsonObject.() -> Unit = {
        addProperty("encryptedTitle", CryptoManager.fromSeed("other", "user-1").encrypt("x").encrypted)
        addProperty("titleIv", CryptoManager.projectIdIvBase64)
    }

    private suspend fun bootstrapped(entries: List<JsonObject> = emptyList(), cursor: Long = 4) {
        connect()
        answer()
        answer(entries, complete = true, cursor = cursor)
    }

    private suspend fun hint(revision: Long) {
        index.message("""{"type":"indexChangesAvailable","revision":$revision}""")
        idle()
    }

    /** R2a-1: the journal returns an id once per change, in revision order. */
    @Test
    fun `a page applies its changes in order, so a delete then a recreate leaves the session`() = runBlocking<Unit> {
        bootstrapped(listOf(change("s1", 2), change("s2", 3)))
        hint(9)
        answer(
            listOf(
                change("s1", 5, deleted = true), change("s1", 6, extra = titled("back")),
                change("s2", 7, extra = unreadable), change("s2", 8, extra = titled("readable")),
            ),
            complete = true, cursor = 9
        )

        assertEquals("back", repository.getSession("s1")?.titleDecrypted)
        assertEquals("readable", repository.getSession("s2")?.titleDecrypted)
        assertEquals("readable at its newest revision", 0, manager.indexCoverage.value.skippedRowCount)
    }

    /** R2a-2: only a committed revision may touch the queue or say the desktop did something. */
    @Test
    fun `a stale revision neither replaces the queue nor signals execution`() = runBlocking<Unit> {
        bootstrapped(listOf(change("s1", 10)))
        repository.upsertQueuedPrompt(QueuedPromptEntity("q1", "s1", "e", "iv", createdAt = 1L, source = "desktop"))
        val transitions = mutableListOf<SessionExecutionTransition>()
        val collector = scope.launch { manager.executionTransitions.collect { transitions += it } }

        manager.requestSessionIndexLookup("s1")
        idle()
        answer(listOf(change("s1", 6) { addProperty("isExecuting", true); addProperty("queuedPromptCount", 0) }))
        collector.cancel()

        assertEquals(listOf("q1"), db.queuedPromptDao().observeQueuedPromptsForSession("s1").first().map { it.id })
        assertTrue("a rejected revision is not desktop activity: $transitions", transitions.isEmpty())
    }

    /** R2a-3: a room rebuilt at a lower head must not look stale forever. */
    @Test
    fun `a reset forgets the old revisions, so a rebuilt room's lower revisions apply`() = runBlocking<Unit> {
        bootstrapped(listOf(change("s1", 20, extra = titled("before"))), cursor = 20)
        hint(25)
        answer(complete = false, reset = true)
        assertEquals("bootstrap", lastRequest().get("mode").asString)

        answer(listOf(change("s1", 3, extra = titled("after"))), complete = true, cursor = 3)

        assertEquals("after", repository.getSession("s1")?.titleDecrypted)
        assertTrue(manager.indexCoverage.value.historyComplete)
        assertEquals(3L, manager.indexCoverage.value.lastCommittedRevision)
    }

    /** R2a-7: without a hint, only coverage selection fetches what changed while offline. */
    @Test
    fun `a lookup queued behind a reconnect's seed does not strand the catch-up`() = runBlocking<Unit> {
        bootstrapped(cursor = 4)
        manager.disconnect()
        connect()
        assertEquals("recent", lastRequest().get("mode").asString)
        manager.requestSessionIndexLookup("elsewhere")
        idle()

        answer()
        assertEquals("lookup", lastRequest().get("mode").asString)
        answer()

        assertEquals("delta", lastRequest().get("mode").asString)
        assertEquals(4L, lastRequest().get("sinceRevision").asLong)
    }

    /** R2a-9: counted over the whole run, since no single page need hold enough rows. */
    @Test
    fun `a completed bootstrap with nothing readable reports an encryption mismatch`() = runBlocking<Unit> {
        connect()
        answer()
        answer((1..3).map { change("a$it", it.toLong(), extra = unreadable) }, complete = false, token = "t")
        answer((4..7).map { change("a$it", it.toLong(), extra = unreadable) }, complete = true, cursor = 7)

        assertTrue(manager.state.value.encryptionMismatch)
        assertEquals(SyncErrorKind.DECRYPT, manager.syncError.value?.kind)
    }

    @Test
    fun `malformed pages are refused without moving anything`() {
        fun validate(json: String) = IndexPageValidator.validate(
            com.google.gson.Gson().fromJson(json, IndexPageResponse::class.java), "r", IndexReplicationMode.BOOTSTRAP,
            crypto, SessionEntryDecoder(com.google.gson.Gson()), emptyMap()
        )
        val base = """"type":"indexPageResponse","protocolVersion":2,"requestId":"r","mode":"bootstrap","entries":[]"""
        assertTrue("complete with a token", validate("{$base,\"complete\":true,\"cursor\":1,\"nextPageToken\":\"t\"}").isFailure)
        assertTrue("terminal without a cursor", validate("{$base,\"complete\":true}").isFailure)
        assertTrue("another request's page", validate("{$base,\"complete\":true,\"cursor\":1}".replace("\"r\"", "\"x\"")).isFailure)
        assertEquals(1L, validate("{$base,\"complete\":true,\"cursor\":1}").getOrThrow().committableCursor)
    }
}
