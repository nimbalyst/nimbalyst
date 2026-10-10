package com.nimbalyst.app.documents

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.gson.JsonParser
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.sync.WebSocketFactory
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class DocumentSyncManagerTest {
    private val project = "/Users/me/workspace"
    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val sockets = FakeSockets()
    private val openedAccounts = mutableListOf<String>()
    private val account = DocumentSyncAccount("https://sync.example", "jwt", "org-1", "user-1", crypto, "key-1")

    /** Real per-account database files, as in production, so an account switch or restart is observable. */
    private val databases = mutableMapOf<String, DocumentsDatabase>()
    private val db get() = openDb(account.accountKey)
    private val dao get() = db.documentsDao()

    private fun openDb(accountKey: String) = databases.getOrPut(accountKey) {
        Room.databaseBuilder(context, DocumentsDatabase::class.java, DocumentsDatabase.fileName(accountKey))
            .allowMainThreadQueries()
            // Inline, so observed flows emit under the test scheduler instead of on Room's pool.
            .setQueryExecutor { it.run() }
            .setTransactionExecutor { it.run() }
            .build()
    }

    /** Process death: every database closes, and the next manager reopens the files. */
    private fun killProcess() {
        databases.values.forEach { it.close() }
        databases.clear()
    }

    @After
    fun tearDown() {
        killProcess()
        context.databaseList().forEach { context.deleteDatabase(it) }
    }

    private fun TestScope.manager(signedIn: Boolean = true) = DocumentSyncManager(
        scope = backgroundScope,
        dispatcher = StandardTestDispatcher(testScheduler),
        openDatabase = { openedAccounts += it.accountKey; openDb(it.accountKey) },
        socketFactory = sockets,
        reconnectDelayMs = 60_000L,
        clock = { 1_000L },
    ).also { if (signedIn) it.applyAccount(account) }

    @Test
    fun anEditorOpenedOnAColdStartWaitsForTheAccountInsteadOfSettlingOnMissing() = runTest {
        val manager = manager(signedIn = false)
        val seen = mutableListOf<DocumentAvailability>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            manager.observeAvailability(project, "a.md").collect { seen += it }
        }
        // Process restore: the editor is the first screen, before the key is derived.
        manager.acquireProject(project)
        runCurrent()
        assertEquals(DocumentAvailability.Waiting, seen.last())
        assertTrue(sockets.all.isEmpty())

        manager.applyAccount(account)
        runCurrent()
        assertEquals("The editor's own lease opens the room", 1, sockets.all.size)
        sockets.last.open()
        runCurrent()
        assertEquals(DocumentAvailability.Waiting, seen.last())
        sockets.last.message(response(listOf("a")))
        runCurrent()
        assertTrue(seen.last() is DocumentAvailability.Available)
        assertTrue(DocumentAvailability.Missing !in seen)

        manager.applyAccount(null)
        runCurrent()
        assertTrue("A real sign-out is reported", seen.last() is DocumentAvailability.Failed)
    }

    @Test
    fun batchesApplyProgressivelyAndKeepContentEncryptedUntilOpened() = runTest {
        val manager = manager()
        manager.beginTransfer(project)
        manager.handleMessage(response(listOf("a"), batch(0, last = false)), project)
        assertEquals(DocumentSyncState.Syncing(1), manager.state(project))
        val cached = dao.document(project, "a")!!
        assertNull(cached.contentDecrypted)
        assertNotNull(cached.encryptedContent)
        assertEquals("a.md", cached.relativePath)

        manager.handleMessage(response(listOf("b"), batch(1, last = true)), project)
        assertEquals(DocumentSyncState.Ready, manager.state(project))
        assertEquals(listOf("a.md", "b.md"), dao.summaries(project).map { it.relativePath })

        assertEquals("# Content a", manager.documentContent(project, "a.md"))
        val opened = dao.document(project, "a")!!
        assertEquals("Decrypted content is cached", "# Content a", opened.contentDecrypted)
        assertNull("The encrypted blob is dropped once decrypted", opened.encryptedContent)

        manager.beginTransfer(project)
        manager.handleMessage(response(emptyList()), project)
        assertEquals("A legacy server completes in one response", DocumentSyncState.Ready, manager.state(project))
        assertEquals("An empty response never clears the cache", 2, dao.summaries(project).size)
    }

    @Test
    fun invalidBatchesFailWithoutImportingAndAFailedWriteRollsBackTheWholeBatch() = runTest {
        val manager = manager()
        for (meta in listOf(batch(1, last = true), """"transferId":"t"""", """"transferId":null,"batchIndex":null,"isLastBatch":null""")) {
            manager.beginTransfer(project)
            manager.handleMessage(response(listOf("bad"), meta), project)
            assertTrue("accepted $meta", manager.state(project) is DocumentSyncState.Failed)
        }
        manager.beginTransfer(project)
        manager.handleMessage("{invalid", project)
        assertTrue(manager.state(project) is DocumentSyncState.Failed)
        assertTrue(dao.summaries(project).isEmpty())

        manager.beginTransfer(project)
        manager.handleMessage(response(listOf("cached"), batch(0, last = false)), project)
        db.openHelper.writableDatabase.execSQL(
            "CREATE TRIGGER reject_document BEFORE INSERT ON synced_documents WHEN NEW.syncId = 'reject' " +
                "BEGIN SELECT RAISE(ABORT, 'test write failure'); END"
        )
        manager.handleMessage(response(listOf("new", "reject"), batch(1, last = true)), project)
        assertTrue(manager.state(project) is DocumentSyncState.Failed)
        assertEquals("No partial import", listOf("cached"), dao.summaries(project).map { it.syncId })

        db.openHelper.writableDatabase.execSQL("DROP TRIGGER reject_document")
        manager.beginTransfer(project)
        manager.handleMessage(response(listOf("new", "reject"), batch(0, last = true, id = "retry")), project)
        assertEquals(DocumentSyncState.Ready, manager.state(project))
        assertEquals(3, dao.summaries(project).size)
    }

    @Test
    fun aStalledTransferTimesOutAndRetryResumesWithThePartialManifest() = runTest {
        val manager = manager()
        manager.acquireProject(project)
        runCurrent()
        val first = sockets.last
        assertTrue(first.request.url.toString().contains("/sync/org:org-1:user:user-1:project:${sha256Hex(project)}"))
        first.open()
        runCurrent()
        assertEquals("projectSyncRequest", first.sentTypes().single())
        first.message(response(listOf("a"), batch(0, last = false)))
        runCurrent()

        advanceTimeBy(29_000)
        runCurrent()
        assertEquals("Each batch restarts the clock", DocumentSyncState.Syncing(1), manager.state(project))
        advanceTimeBy(2_000)
        runCurrent()
        assertTrue(manager.state(project) is DocumentSyncState.Failed)

        first.message(response(listOf("late"), batch(1, last = true)))
        runCurrent()
        assertEquals("A failed transfer ignores late batches", listOf("a"), dao.summaries(project).map { it.syncId })

        manager.retryProject(project)
        runCurrent()
        val second = sockets.last
        assertTrue(first.cancelledOrClosed)
        second.open()
        runCurrent()
        val manifest = JsonParser.parseString(second.sent.single()).asJsonObject.getAsJsonArray("files")
        assertEquals("a", manifest.single().asJsonObject["syncId"].asString)
        second.message(response(listOf("b"), batch(0, last = true, id = "retry")))
        runCurrent()
        assertEquals(DocumentSyncState.Ready, manager.state(project))
        assertEquals(2, dao.summaries(project).size)
    }

    @Test
    fun offlineSavesCoalesceAndLiveSavesAreConfirmedByAVerificationRound() = runTest {
        val manager = manager()
        seed(manager, "a", "b")

        assertEquals(SaveOutcome.Queued, manager.save(project, "a.md", "# One"))
        assertEquals(SaveOutcome.Queued, manager.save(project, "a.md", "# Two"))
        assertEquals("Each push carries the whole file, so only the latest waits", 1, dao.outboxCount(project))
        assertEquals("# Two", dao.document(project, "a")!!.contentDecrypted)

        manager.acquireProject(project)
        runCurrent()
        val socket = sockets.last
        socket.open()
        runCurrent()
        assertEquals("Nothing is replayed blind; the manifest diff decides", listOf("projectSyncRequest"), socket.sentTypes())
        // The server already holds "# Two" (an earlier send landed): same hash, nothing listed.
        socket.message(response(emptyList()))
        runCurrent()
        assertEquals(listOf("projectSyncRequest"), socket.sentTypes())
        assertEquals(0, dao.outboxCount(project))

        assertEquals(SaveOutcome.Sent, manager.save(project, "b.md", "# Live"))
        assertEquals(1, dao.outboxCount(project))
        advanceTimeBy(1_600)
        runCurrent()
        assertEquals(listOf("projectSyncRequest", "fileContentPush", "projectSyncRequest"), socket.sentTypes())
        assertEquals("A verification round does not flash Syncing", DocumentSyncState.Ready, manager.state(project))
        socket.message(response(emptyList(), batch(0, last = true, id = "verify")))
        runCurrent()
        assertEquals(0, dao.outboxCount(project))

        // A socket that refuses while still marked open keeps the save for the next connect.
        socket.refuse = true
        assertEquals(SaveOutcome.Queued, manager.save(project, "a.md", "# Three"))
        assertEquals(1, dao.outboxCount(project))
    }

    @Test
    fun theManifestDiffSettlesOrResendsEachPendingWrite() {
        fun entry(id: Long, syncId: String, hash: String?, at: Long, kind: OutboxKind = OutboxKind.PUSH) =
            DocumentOutboxEntry(id, project, syncId, kind, "p$id", hash, at, 0)
        val entries = listOf(
            entry(1, "held", "h1", 10),      // server hash matches the manifest
            entry(2, "lost", "h2", 10),      // server's copy is older
            entry(3, "beaten", "h3", 10),    // server's copy is newer
            entry(4, "later", "h4-new", 30), // saved after the manifest was taken
            entry(5, "gone", null, 10, OutboxKind.DELETE),
            entry(6, "kept", null, 10, OutboxKind.DELETE),
        )
        val manifest = mapOf("held" to "h1", "lost" to "h2", "beaten" to "h3", "later" to "h4", "gone" to "x", "kept" to "y", "cached" to "c")
        val findings = TransferFindings().apply {
            needFromClient += listOf("lost", "cached")
            serverNewer["beaten"] = 20
            serverNewer["later"] = 20
            deleted += "gone"
        }
        val plan = planOutboxReconciliation(entries, manifest, findings)
        assertEquals(listOf(1L, 3L, 5L), plan.settled)
        assertEquals(listOf("lost", "later", "kept"), plan.resend.map { it.syncId })
        assertEquals("Asked for with nothing pending: push the cached copy", listOf("cached"), plan.pushFromCache)
    }

    @Test
    fun roomsAreHeldByLeasesAndClosedInTheBackgroundWithoutLosingTheOutbox() = runTest {
        val manager = manager()
        seed(manager, "a")
        val list = manager.acquireProject(project)
        val editor = manager.acquireProject(project)
        runCurrent()
        assertEquals("Two screens share one room", 1, sockets.all.size)
        sockets.last.open()
        runCurrent()

        editor.release()
        editor.release()
        runCurrent()
        assertTrue("Still held by the list", !sockets.last.cancelledOrClosed)

        manager.suspendConnections()
        runCurrent()
        assertTrue(sockets.last.cancelledOrClosed)
        assertEquals(SaveOutcome.Queued, manager.save(project, "a.md", "# Backgrounded"))
        manager.resumeConnections()
        runCurrent()
        assertEquals("The held room reopens in the foreground", 2, sockets.all.size)
        assertEquals(1, dao.outboxCount(project))

        list.release()
        runCurrent()
        assertTrue(sockets.last.cancelledOrClosed)
        manager.resumeConnections()
        runCurrent()
        assertEquals("A released room stays closed", 2, sockets.all.size)
        assertEquals("The outbox outlives the room", 1, dao.outboxCount(project))
    }

    @Test
    fun aClosingEditorsEditIsKeptAndSurfacedUntilItIsOnDisk() = runTest {
        val manager = manager()
        seed(manager, "a")

        // Storage failure while the editor closes.
        db.openHelper.writableDatabase.execSQL(
            "CREATE TRIGGER reject_update BEFORE INSERT ON document_outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END"
        )
        manager.saveInBackground(project, "a.md", "# Last words")
        runCurrent()
        val failure = manager.saveFailures.value.single()
        assertEquals("# Last words", failure.markdown)
        assertEquals("A reopened editor shows the unsaved edit", "# Last words", manager.documentContent(project, "a.md"))

        db.openHelper.writableDatabase.execSQL("DROP TRIGGER reject_update")
        manager.retrySave(failure)
        runCurrent()
        assertTrue(manager.saveFailures.value.isEmpty())
        assertEquals("# Last words", dao.document(project, "a")!!.contentDecrypted)

        // Sign-out between the last keystroke and the save.
        manager.applyAccount(null)
        manager.saveInBackground(project, "a.md", "# Signed out")
        runCurrent()
        assertEquals("# Signed out", manager.saveFailures.value.single().markdown)
        manager.applyAccount(account.copy(userId = "someone-else"))
        runCurrent()
        assertEquals("Never saved into another account", 1, manager.saveFailures.value.size)
        manager.applyAccount(account)
        runCurrent()
        assertTrue(manager.saveFailures.value.isEmpty())
        assertEquals("# Signed out", dao.document(project, "a")!!.contentDecrypted)
    }

    @Test
    fun broadcastsUpdateTheCacheAndNotifyAnOpenEditor() = runTest {
        val manager = manager()
        seed(manager, "a")
        val updates = mutableListOf<RemoteDocumentUpdate>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { manager.remoteUpdates.collect { updates += it } }

        manager.handleMessage(contentBroadcast("a", "# From desktop"), project)
        assertEquals("# From desktop", dao.document(project, "a")!!.contentDecrypted)
        assertEquals(listOf(RemoteDocumentUpdate(project, "a", "# From desktop")), updates)

        manager.handleMessage("""{"type":"fileYjsInitBroadcast","syncId":"a","fromConnectionId":"c"}""", project)
        assertTrue(dao.document(project, "a")!!.hasYjs)
        manager.handleMessage("""{"type":"fileYjsUpdateBroadcast","syncId":"a","encryptedUpdate":"u","iv":"i","sequence":5,"fromConnectionId":"c"}""", project)
        manager.handleMessage("""{"type":"fileYjsUpdateBroadcast","syncId":"a","encryptedUpdate":"u","iv":"i","sequence":3,"fromConnectionId":"c"}""", project)
        assertEquals("Sequence only moves forward", 5L, dao.document(project, "a")!!.yjsSeq)

        manager.handleMessage("""{"type":"fileDeleteBroadcast","syncId":"a","fromConnectionId":"c"}""", project)
        assertNull(dao.document(project, "a"))

        manager.handleMessage("""{"type":"error","code":"x","message":"Room unavailable"}""", project)
        assertEquals(DocumentSyncState.Failed("Room unavailable"), manager.state(project))
    }

    @Test
    fun aTokenRefreshKeepsOpenRoomsAndReconnectsFailedOnes() = runTest {
        val manager = manager()
        manager.acquireProject(project)
        runCurrent()
        sockets.last.open()
        runCurrent()

        manager.applyAccount(account.copy(authToken = "fresh"))
        runCurrent()
        assertEquals("An open room keeps its socket", 1, sockets.all.size)

        sockets.last.fail(401)
        runCurrent()
        assertTrue(manager.state(project) is DocumentSyncState.Failed)
        manager.applyAccount(account.copy(authToken = "fresher"))
        runCurrent()
        assertEquals(2, sockets.all.size)
        assertTrue(sockets.last.request.url.queryParameter("token") == "fresher")

        seed(manager, "a")
        manager.applyAccount(account.copy(userId = "user-2"))
        runCurrent()
        assertEquals("Another account gets its own cache", 2, openedAccounts.distinct().size)
        assertTrue(sockets.last.request.url.toString().contains(":user:user-2:project:"))
        assertNull("…and none of this account's files", manager.document(project, "a.md"))

        // Recreated after process death, the first account still has its files.
        killProcess()
        val restored = manager()
        assertNotNull(restored.document(project, "a.md"))
    }

    @Test
    fun openFileWaitsForAFileThatIsNotSyncedYet() = runTest {
        val manager = manager()
        val opening = async { manager.openDocumentByPath(project, "$project/notes/late.md") }
        runCurrent()
        val socket = sockets.last
        socket.open()
        runCurrent()
        socket.message(response(listOf("late"), batch(0, last = true), pathPrefix = "notes/"))
        advanceTimeBy(400)
        assertEquals(OpenDocumentResult.Ready("notes/late.md"), opening.await())

        assertEquals(OpenDocumentResult.OutsideProject, manager.openDocumentByPath(project, "/elsewhere/a.md"))
        assertEquals(OpenDocumentResult.NotSynced, manager.openDocumentByPath(project, "$project/missing.md", timeoutMs = 1_000))
    }

    @Test
    fun anUnconfirmedPushSurvivesASocketDropAndAProcessRestart() = runTest {
        val first = manager()
        seed(first, "a")
        first.acquireProject(project)
        runCurrent()
        sockets.last.open()
        runCurrent()
        sockets.last.message(response(emptyList()))
        runCurrent()

        // OkHttp accepting the frame only means it is queued on this device.
        assertEquals(SaveOutcome.Sent, first.save(project, "a.md", "# Edit"))
        assertEquals(listOf("# Edit"), sockets.last.pushedContents())
        sockets.last.fail(500)
        runCurrent()
        assertEquals("Kept until the server confirms it", 1, dao.outboxCount(project))

        killProcess()
        val second = manager()
        second.acquireProject(project)
        runCurrent()
        val socket = sockets.last
        socket.open()
        runCurrent()
        assertEquals(mapOf("a" to sha256Hex("# Edit")), manifest(socket.sent.single()))

        // The server never got it: its hash differs and ours is newer.
        socket.message(response(emptyList(), needFromClient = listOf("a")))
        runCurrent()
        assertEquals(listOf("projectSyncRequest", "fileContentPush", "projectSyncRequest"), socket.sentTypes())
        assertEquals(listOf("# Edit"), socket.pushedContents())
        assertEquals("Still unconfirmed until the next manifest diff", 1, dao.outboxCount(project))

        socket.message(response(emptyList(), batch(0, last = true, id = "verify")))
        runCurrent()
        assertEquals("The server's hash now matches", 0, dao.outboxCount(project))
    }

    @Test
    fun aSaveCommitsTheContentAndItsPushTogether() = runTest {
        val manager = manager()
        seed(manager, "a")
        db.openHelper.writableDatabase.execSQL(
            "CREATE TRIGGER reject_outbox BEFORE INSERT ON document_outbox BEGIN SELECT RAISE(ABORT, 'disk full'); END"
        )
        assertTrue(manager.save(project, "a.md", "# Half saved") is SaveOutcome.Failed)
        assertEquals("Content without its push would never sync", "# Content a", manager.documentContent(project, "a.md"))
    }

    @Test
    fun twoServersWithTheSameIdsGetSeparateCachesAndOutboxes() = runTest {
        val manager = manager()
        seed(manager, "a")
        assertEquals(SaveOutcome.Queued, manager.save(project, "a.md", "# For server A"))

        val other = account.copy(serverUrl = "https://other-sync.example")
        assertNotEquals(DocumentsDatabase.fileName(account.accountKey), DocumentsDatabase.fileName(other.accountKey))
        assertEquals("The same server spelled differently", account.accountKey, account.copy(serverUrl = "HTTPS://Sync.example/").accountKey)

        manager.applyAccount(other)
        manager.acquireProject(project)
        runCurrent()
        sockets.last.open()
        runCurrent()
        assertEquals(2, openedAccounts.distinct().size)
        assertEquals("Server B sees none of server A's files", emptyMap<String, String>(), manifest(sockets.last.sent.first()))
        assertEquals("Server B never receives server A's edit", emptyList<String>(), sockets.last.pushedContents())
        assertEquals("Server A's edit waits for server A", 1, openDb(account.accountKey).documentsDao().outboxCount(project))
    }

    private fun manifest(request: String): Map<String, String> =
        JsonParser.parseString(request).asJsonObject.getAsJsonArray("files").associate {
            it.asJsonObject["syncId"].asString to it.asJsonObject["contentHash"].asString
        }

    private fun TestScope.seed(manager: DocumentSyncManager, vararg ids: String) {
        manager.beginTransfer(project)
        manager.handleMessage(response(ids.toList()), project)
        assertEquals(DocumentSyncState.Ready, manager.state(project))
    }

    private fun batch(index: Int, last: Boolean, id: String = "transfer") =
        """"transferId":"$id","batchIndex":$index,"isLastBatch":$last"""

    private fun response(
        ids: List<String>,
        metadata: String? = null,
        pathPrefix: String = "",
        needFromClient: List<String> = emptyList(),
    ): String {
        val files = ids.joinToString(",") { id -> fileJson(id, "$pathPrefix$id.md", "# Content $id") + ""","hasYjs":false}""" }
        val meta = metadata?.let { ",$it" } ?: ""
        val need = needFromClient.joinToString(",") { "\"$it\"" }
        return """{"type":"projectSyncResponse","updatedFiles":[],"newFiles":[$files],"yjsUpdates":[],"needFromClient":[$need],"deletedSyncIds":[]$meta}"""
    }

    private fun contentBroadcast(id: String, content: String) =
        """{"type":"fileContentBroadcast",""" + fileJson(id, "$id.md", content).removePrefix("{") + ""","fromConnectionId":"c"}"""

    /** A file entry without its closing brace, so callers can append fields. */
    private fun fileJson(id: String, path: String, content: String): String {
        val c = crypto.encrypt(content)
        val p = crypto.encrypt(path)
        val t = crypto.encrypt(path.substringAfterLast('/'))
        return """{"syncId":"$id","encryptedContent":"${c.encrypted}","contentIv":"${c.iv}","contentHash":"h",""" +
            """"encryptedPath":"${p.encrypted}","pathIv":"${p.iv}","encryptedTitle":"${t.encrypted}","titleIv":"${t.iv}","lastModifiedAt":1"""
    }

    private fun pushedContent(json: String): String {
        val message = JsonParser.parseString(json).asJsonObject
        return crypto.decrypt(message["encryptedContent"].asString, message["contentIv"].asString)
    }

    private fun FakeSockets.Socket.sentTypes() = sent.map { JsonParser.parseString(it).asJsonObject["type"].asString }
    private fun FakeSockets.Socket.pushedContents() =
        sent.filter { JsonParser.parseString(it).asJsonObject["type"].asString == "fileContentPush" }.map(::pushedContent)

    private companion object {
        val crypto: CryptoManager by lazy { CryptoManager.fromSeed("test-seed", "test-user") }
    }
}

/** Records every socket opened so a test can drive its listener directly. */
internal class FakeSockets : WebSocketFactory {
    class Socket(val request: Request, private val listener: WebSocketListener) : WebSocket {
        val sent = mutableListOf<String>()
        var refuse = false
        var cancelledOrClosed = false

        override fun request() = request
        override fun queueSize() = 0L
        override fun send(text: String): Boolean {
            if (refuse || cancelledOrClosed) return false
            sent += text
            return true
        }
        override fun send(bytes: ByteString) = false
        override fun close(code: Int, reason: String?): Boolean {
            cancelledOrClosed = true
            return true
        }
        override fun cancel() {
            cancelledOrClosed = true
        }

        fun open() = listener.onOpen(this, response(101))
        fun message(text: String) = listener.onMessage(this, text)
        fun fail(code: Int) = listener.onFailure(this, RuntimeException("boom"), response(code))

        private fun response(code: Int) =
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(code).message("").build()
    }

    val all = mutableListOf<Socket>()
    val last: Socket get() = all.last()

    override fun open(request: Request, listener: WebSocketListener): WebSocket = Socket(request, listener).also { all += it }
}
