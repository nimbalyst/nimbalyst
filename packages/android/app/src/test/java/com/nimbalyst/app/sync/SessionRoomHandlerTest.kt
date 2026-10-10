package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.SessionEntity
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Session-room history paging and the resume watermark. */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class SessionRoomHandlerTest {
    private val gson = Gson()
    private val crypto = CryptoManager.fromSeed("seed", "user-1")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val sent = CopyOnWriteArrayList<String>()
    private val lookups = CopyOnWriteArrayList<String>()

    private lateinit var db: NimbalystDatabase
    private lateinit var repository: NimbalystRepository
    private lateinit var handler: SessionRoomHandler

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), NimbalystDatabase::class.java)
            .allowMainThreadQueries().build()
        db.openHelper.writableDatabase
        repository = NimbalystRepository(db)
        handler = SessionRoomHandler(
            repository = repository,
            decoder = SessionEntryDecoder(gson),
            gson = gson,
            crypto = { crypto },
            state = MutableStateFlow(SyncConnectionState()),
            signals = ExecutionSignals(),
            scope = scope,
            requestCatchUp = { sessionId -> runBlocking { handler.requestSync(sessionId) } },
            lookup = { lookups += it },
            send = { _, json -> sent += json; true }
        )
    }

    @After
    fun tearDown() {
        scope.cancel()
        db.close()
    }

    private fun message(sequence: Int) = JsonObject().apply {
        val content = crypto.encrypt("""{"n":$sequence}""")
        addProperty("id", "m$sequence")
        addProperty("sequence", sequence)
        addProperty("createdAt", sequence.toLong())
        addProperty("source", "claude-code")
        addProperty("direction", "output")
        addProperty("encryptedContent", content.encrypted)
        addProperty("iv", content.iv)
    }

    private fun page(range: IntRange, hasMore: Boolean) = JsonObject().apply {
        addProperty("type", "syncResponse")
        add("messages", JsonArray().apply { range.forEach { add(message(it)) } })
        addProperty("hasMore", hasMore)
        if (hasMore) addProperty("cursor", range.last.toString())
    }.toString()

    private fun live(sequence: Int) = JsonObject().apply {
        addProperty("type", "messageBroadcast")
        add("message", message(sequence))
    }.toString()

    private fun lastRequestedSeq(): Int? = JsonParser.parseString(sent.last()).asJsonObject
        .get("sinceSeq")?.takeUnless { it.isJsonNull }?.asInt

    private suspend fun seedSession() = repository.replaceIndexSnapshot(
        projects = listOf(ProjectEntity(id = "/p", name = "p")),
        sessions = listOf(SessionEntity(id = "s1", projectId = "/p", createdAt = 1, updatedAt = 1)),
        syncedAt = 1
    )

    @Test
    fun `a live message between history pages does not skip the rest of history`() = runBlocking {
        seedSession()
        handler.handle(page(1..3, hasMore = true), "s1")
        assertEquals(3, lastRequestedSeq())

        handler.handle(live(10), "s1")
        handler.handle(page(4..6, hasMore = true), "s1")
        assertEquals("the next page must follow the history cursor, not the live message", 6, lastRequestedSeq())

        handler.handle(page(7..9, hasMore = false), "s1")
        // A reconnect resumes from contiguous history, never from past a gap.
        handler.requestSync("s1")
        assertEquals(9, lastRequestedSeq())
        assertEquals(10, repository.messageCount("s1"))
    }

    @Test
    fun `history that arrives before the session row is requested again once the row commits`() = runBlocking {
        handler.handle(page(1..3, hasMore = false), "s1")
        assertEquals(0, repository.messageCount("s1"))
        assertEquals(listOf("s1"), lookups)
        val requestsBefore = sent.size

        seedSession()
        withTimeout(5_000) { while (sent.size == requestsBefore) delay(10) }
        assertEquals("catch-up starts from the beginning", null, lastRequestedSeq())

        // A live message after the row lands must not move the resume point past the dropped history.
        handler.handle(live(7), "s1")
        handler.requestSync("s1")
        assertTrue((lastRequestedSeq() ?: 0) < 1)
    }

    @Test
    fun `a replayed older metadata broadcast is ignored and never moves the sort timestamp`() = runBlocking {
        seedSession()
        fun metadata(updatedAt: Long, executing: Boolean) = JsonObject().apply {
            addProperty("type", "metadataBroadcast")
            add("metadata", JsonObject().apply {
                addProperty("updatedAt", updatedAt)
                addProperty("isExecuting", executing)
            })
        }.toString()

        handler.handle(metadata(updatedAt = 50, executing = true), "s1")
        handler.handle(metadata(updatedAt = 40, executing = false), "s1")

        val row = repository.getSession("s1")!!
        assertTrue("the stale executing:false was applied", row.isExecuting)
        assertEquals("metadata must not reorder the list", 1L, row.updatedAt)
    }
}
