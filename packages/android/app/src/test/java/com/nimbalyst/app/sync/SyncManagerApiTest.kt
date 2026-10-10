package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingCredentials
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The public API the UI builds on (creation, controls, devices, settings,
 * errors, execution signals), driven through the real [SyncManager] against
 * fake sockets.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class SyncManagerApiTest {
    private val seed = "test-seed"
    private val userId = "user-1"
    private val crypto = CryptoManager.fromSeed(seed, userId)
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
            serverUrl = "https://sync.example",
            encryptionSeed = seed,
            authJwt = "jwt-1",
            authUserId = userId,
            orgId = "org-1",
            sessionToken = "session-token"
        )
        manager = SyncManager(
            context = context,
            repository = repository,
            credentialStore = object : SyncCredentialStore {
                override var credentials: PairingCredentials? = credentials
                override fun save(credentials: PairingCredentials) = Unit
            },
            notificationManager = NotificationManager(context),
            scope = scope,
            socketFactory = factory,
            tokenRefresher = TokenRefresher { TokenRefresh.Refreshed(it) }
        )
        manager.connect()
        index = factory.sockets.last().also { it.open() }
        // Answer the connect's index request, so a later lookup is not folded into it.
        runBlocking { deliver("indexSyncResponse") { add("sessions", JsonArray()); add("projects", JsonArray()) } }
    }

    @After
    fun tearDown() {
        scope.cancel()
        db.close()
    }

    private fun sent(type: String): List<JsonObject> =
        index.sent.map { JsonParser.parseString(it).asJsonObject }.filter { it.get("type").asString == type }

    private fun device(id: String, type: String = "desktop", online: Boolean = true, focused: Boolean = false, lastActive: Long = 1) =
        JsonObject().apply {
            addProperty("deviceId", id)
            addProperty("name", id)
            addProperty("type", type)
            addProperty("platform", "darwin")
            addProperty("connectedAt", 1)
            addProperty("lastActiveAt", lastActive)
            addProperty("isFocused", focused)
            addProperty("isOnline", online)
        }

    private fun entry(id: String, extra: JsonObject.() -> Unit = {}) = JsonObject().apply {
        addProperty("sessionId", id)
        addProperty("encryptedProjectId", crypto.encryptProjectId("/p"))
        addProperty("projectIdIv", CryptoManager.projectIdIvBase64)
        addProperty("createdAt", 1L)
        addProperty("updatedAt", 2L)
        extra()
    }

    private suspend fun deliver(type: String, build: JsonObject.() -> Unit) {
        index.message(JsonObject().apply { addProperty("type", type); build() }.toString())
        withTimeout(10_000) { manager.awaitIngestionIdle() }
    }

    private suspend fun broadcast(entry: JsonObject) = deliver("indexBroadcast") { add("session", entry) }

    @Test
    fun `a created session is addressed to an online desktop and completes only once its row is readable`() = runBlocking<Unit> {
        deliver("devicesList") {
            add("devices", JsonArray().apply {
                add(device("offline-mac", online = false, focused = true, lastActive = 99))
                add(device("sandbox", type = "headless", lastActive = 50))
                add(device("mac", lastActive = 10))
            })
        }
        assertEquals("mac", ExecutionHosts.defaultHost(manager.connectedDevices.value)!!.deviceId)

        val requestId = manager.createSession(
            SessionCreationOptions(projectId = "/p", agentRole = "meta-agent", initialDraft = "draft text")
        ).getOrThrow()
        val request = sent("createSessionRequest").single()
        assertEquals("mac", request.get("targetDeviceId").asString)
        assertEquals(requestId, request.getAsJsonObject("request").get("requestId").asString)
        assertEquals("meta-agent", request.getAsJsonObject("request").get("agentRole").asString)

        val lookupsBefore = sent("indexSyncRequest").size
        deliver("createSessionResponseBroadcast") {
            add("response", JsonObject().apply {
                addProperty("requestId", requestId)
                addProperty("success", true)
                addProperty("sessionId", "new-1")
            })
        }
        // Acknowledged but not yet in Room: still pending, and the row was asked for.
        assertTrue(requestId in manager.pendingSessionCreations.value)
        assertEquals(lookupsBefore + 1, sent("indexSyncRequest").size)

        broadcast(entry("new-1"))
        val outcome = withTimeout(10_000) { manager.awaitSessionCreation(requestId) }
        assertEquals(SessionCreationOutcome.Created(requestId, "new-1"), outcome)
        withTimeout(10_000) { repository.observeSession("new-1").first { it?.draftInput == "draft text" } }
    }

    @Test
    fun `creation with no online host fails without sending, and a refusal completes as failed`() = runBlocking<Unit> {
        deliver("devicesList") { add("devices", JsonArray().apply { add(device("mac", online = false)) }) }
        assertTrue(manager.createSession(SessionCreationOptions(projectId = "/p")).isFailure)
        assertTrue(sent("createSessionRequest").isEmpty())

        deliver("devicesList") { add("devices", JsonArray().apply { add(device("mac")) }) }
        val requestId = manager.createSession(SessionCreationOptions(projectId = "/p")).getOrThrow()
        deliver("createSessionResponseBroadcast") {
            add("response", JsonObject().apply {
                addProperty("requestId", requestId)
                addProperty("success", false)
                addProperty("error", "Project not open")
            })
        }
        assertEquals(SessionCreationOutcome.Failed(requestId, "Project not open"), manager.awaitSessionCreation(requestId))
    }

    @Test
    fun `controls go to the session host, and archive and reparent are written locally and published`() = runBlocking<Unit> {
        broadcast(entry("s1") { addProperty("hostDeviceId", "desk-1"); addProperty("createdBySessionId", "desktop-manager") })

        manager.cancelSession("s1").getOrThrow()
        val cancel = sent("sessionControl").single().getAsJsonObject("message")
        assertEquals("cancel", cancel.get("messageType").asString)
        assertEquals("desk-1", cancel.get("targetDeviceId").asString)
        assertEquals(WebSocketClient.getDeviceId(context), cancel.get("sentByDeviceId").asString)

        manager.setSessionArchived("s1", true).getOrThrow()
        assertTrue(repository.getSession("s1")!!.isArchived)
        val archive = sent("sessionControl").last().getAsJsonObject("message")
        assertEquals("archive", archive.get("messageType").asString)
        assertTrue(archive.getAsJsonObject("payload").get("isArchived").asBoolean)

        manager.updateSessionParent("s1", "ws-1").getOrThrow()
        assertEquals("ws-1", repository.getSession("s1")!!.parentSessionId)
        val move = sent("indexUpdate").last().getAsJsonObject("session")
        assertEquals("ws-1", move.get("parentSessionId").asString)
        assertNull("a move must not overwrite the message count", move.get("messageCount"))
        assertFalse(move.has("createdBySessionId"))
        manager.updateSessionParent("s1", null).getOrThrow()
        assertNull(repository.getSession("s1")!!.parentSessionId)
        assertEquals("desktop-manager", repository.getSession("s1")!!.createdBySessionId)
        val clear = sent("indexUpdate").last().getAsJsonObject("session")
        assertTrue(clear.get("parentSessionId").isJsonNull)
        assertFalse(clear.has("createdBySessionId"))

        val worktreeId = manager.createWorktree("/p").getOrThrow()
        assertEquals(worktreeId, sent("createWorktreeRequest").single().getAsJsonObject("request").get("requestId").asString)
        deliver("createWorktreeResponseBroadcast") {
            add("response", JsonObject().apply {
                addProperty("requestId", worktreeId)
                addProperty("success", false)
                addProperty("error", "Not a git repository")
            })
        }
        assertEquals(SyncError(SyncErrorKind.TRANSPORT, "Not a git repository", manager.syncError.value!!.id), manager.syncError.value)
    }

    @Test
    fun `settings carry the meta-agent gate, and execution changes are signalled after commit`() = runBlocking<Unit> {
        assertFalse(manager.metaAgentEnabled.value)
        val settings = crypto.encrypt("""{"metaAgentEnabled":true,"defaultModel":"claude-code:opus","version":3}""")
        deliver("settingsSyncBroadcast") {
            add("settings", JsonObject().apply {
                addProperty("encryptedSettings", settings.encrypted)
                addProperty("settingsIv", settings.iv)
                addProperty("deviceId", "mac")
                addProperty("timestamp", 1L)
                addProperty("version", 3)
            })
        }
        assertTrue(manager.metaAgentEnabled.value)
        assertEquals("claude-code:opus", manager.desktopDefaultModel.value)

        broadcast(entry("s1"))
        val seen = MutableStateFlow<List<SessionExecutionTransition>>(emptyList())
        val collector = scope.launch { manager.executionTransitions.collect { seen.value = seen.value + it } }
        broadcast(entry("s1") {
            add("pendingExecution", JsonObject().apply {
                addProperty("messageId", "m1"); addProperty("sentAt", 5L); addProperty("sentBy", "mobile")
            })
        })
        broadcast(entry("s1") { addProperty("isExecuting", true) })
        broadcast(entry("s1") { addProperty("isExecuting", true) })
        collector.cancel()

        assertEquals(listOf("m1", null), seen.value.map { it.pendingExecution?.messageId })
        assertEquals(listOf(false, true), seen.value.map { it.isExecuting })
    }

    @Test
    fun `same-kind errors inside the window coalesce into one banner, a new kind replaces it`() {
        var now = 0L
        val errors = SyncErrors(clock = { now })
        errors.report(SyncErrorKind.TRANSPORT, "Draft not sent")
        val first = errors.current.value!!
        now = 1_000
        errors.report(SyncErrorKind.TRANSPORT, "Read marker not sent")
        assertEquals(first.id, errors.current.value!!.id)
        assertEquals(SyncErrorKind.TRANSPORT.coalescedMessage, errors.current.value!!.message)
        errors.report(SyncErrorKind.DECRYPT, "Unreadable")
        assertEquals(SyncErrorKind.DECRYPT, errors.current.value!!.kind)
        errors.clear(SyncErrorKind.PRESENCE)
        assertEquals(SyncErrorKind.DECRYPT, errors.current.value!!.kind)
    }

    @Test
    fun `settings replayed from before the last applied ones are ignored, across restarts`() = runBlocking<Unit> {
        suspend fun settings(metaAgent: Boolean, timestamp: Long, version: Long, deviceId: String = "mac", extra: String = "") {
            val encrypted = crypto.encrypt("""{"metaAgentEnabled":$metaAgent,$extra"version":$version}""")
            deliver("settingsSyncBroadcast") {
                add("settings", JsonObject().apply {
                    addProperty("encryptedSettings", encrypted.encrypted)
                    addProperty("settingsIv", encrypted.iv)
                    addProperty("deviceId", deviceId)
                    addProperty("timestamp", timestamp)
                    addProperty("version", version)
                })
            }
        }
        settings(metaAgent = true, timestamp = 100, version = 3)
        // A higher counter from an older launch cannot rewind settings.
        settings(metaAgent = false, timestamp = 50, version = 9)
        assertTrue(manager.metaAgentEnabled.value)
        // Same millisecond: the counter breaks the tie.
        settings(metaAgent = false, timestamp = 100, version = 3)
        assertTrue(manager.metaAgentEnabled.value)

        // Desktop seeds the counter from Date.now(); it must not overflow and drop the models.
        val models = """"availableModels":[{"id":"claude-code:opus","name":"Opus","provider":"claude-code"}],"defaultModel":"claude-code:opus","""
        settings(metaAgent = true, timestamp = 200, version = 1_789_232_410_000, extra = models)
        assertEquals(listOf("claude-code:opus"), manager.availableModels.value.map { it.id })
        // A publish that omits the models keeps the stored list.
        settings(metaAgent = true, timestamp = 300, version = 1_789_232_410_001)
        assertEquals("claude-code:opus", manager.desktopDefaultModel.value)

        val restarted = SettingsSyncApplier(context)
        assertEquals("models survive a restart", listOf("claude-code:opus"), restarted.availableModels.value.map { it.id })
        assertEquals("claude-code:opus", restarted.defaultModel.value)
        assertFalse(restarted.isFresh("mac", timestamp = 100, version = 3))
        assertTrue(restarted.isFresh("mac", timestamp = 301, version = 1))
        assertTrue("watermarks are per desktop", restarted.isFresh("other-mac", timestamp = 1, version = 1))
    }

    /** Drops the index socket and brings up a fresh one, as a 401 plus token refresh would. */
    private suspend fun reconnectIndex(): FakeSocketFactory.FakeSocket {
        index.fail(401)
        manager.connectIfConfigured()
        index = factory.sockets.last().also { it.open() }
        withTimeout(10_000) { manager.awaitIngestionIdle() }
        return index
    }

    private fun JsonObject.clientMetadata(json: String) {
        val encrypted = crypto.encrypt(json)
        addProperty("encryptedClientMetadata", encrypted.encrypted)
        addProperty("clientMetadataIv", encrypted.iv)
    }

    private fun draftBlobs(): List<JsonObject> = sent("indexClientMetadataPatch").map { it.getAsJsonObject("patch") }
        .filter { it.has("encryptedClientMetadata") }
        .map { JsonParser.parseString(crypto.decrypt(it.get("encryptedClientMetadata").asString, it.get("clientMetadataIv").asString)).asJsonObject }

    private suspend fun waitFor(condition: () -> Boolean) = withTimeout(10_000) { while (!condition()) delay(10) }

    private fun sentPrompts() = sent("indexUpdate").filter { it.getAsJsonObject("session").has("encryptedQueuedPrompts") }

    @Test
    fun `a prompt counts as sent only once the room confirms it, and a drop before that hands it back`() = runBlocking<Unit> {
        broadcast(entry("s1"))

        // OkHttp accepted the frame, then the socket died before the pong.
        val dropped = async(Dispatchers.Default) { manager.sendPrompt("s1", "lost") }
        waitFor { sentPrompts().isNotEmpty() }
        index.fail()
        assertTrue(withTimeout(10_000) { dropped.await() }.isFailure)
        assertTrue(repository.observeQueuedPromptsForSession("s1").first().isEmpty())

        manager.connectIfConfigured()
        index = factory.sockets.last().also { it.open() }
        withTimeout(10_000) { manager.awaitIngestionIdle() }
        val confirmed = async(Dispatchers.Default) { manager.sendPrompt("s1", "kept") }
        waitFor { sentPrompts().isNotEmpty() }
        withTimeout(10_000) {
            while (!confirmed.isCompleted) { deliver("pong") {}; delay(10) }
        }
        assertTrue(confirmed.await().isSuccess)
        assertEquals(listOf("kept"), repository.observeQueuedPromptsForSession("s1").first().map { it.promptTextDecrypted })
    }

    @Test
    fun `an image that cannot be prepared fails the prompt, and cancelling a send is not reported as a failure`() = runBlocking<Unit> {
        broadcast(entry("s1"))
        var frames = 0
        val never = kotlinx.coroutines.CompletableDeferred<Boolean>()
        val sender = PromptSender(
            repository, SessionIndexUpdates(com.google.gson.Gson()), { crypto }, { true },
            sendIndex = { frames++; never.await() },
            compress = { null }
        )
        val photo = com.nimbalyst.app.attachments.PendingAttachment(
            android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888)
        )
        assertTrue(sender.send("s1", "look", listOf(photo)).isFailure)
        assertEquals("nothing is sent without the image", 0, frames)

        var result: Result<String>? = null
        val job = launch(Dispatchers.Default) { result = sender.send("s1", "hi", emptyList()) }
        waitFor { frames == 1 }
        job.cancel()
        job.join()
        assertNull("a cancelled send must not come back as a failure to restore", result)
    }

    /** NIM-7281 follow-up: the server replaces the metadata blob whole, so a draft built on a guess erases the desktop's fields. */
    @Test
    fun `a draft is written into the desktop's last blob, which survives a restart, and waits while none is known`() = runBlocking<Unit> {
        broadcast(entry("s1") { clientMetadata("""{"hasBeenNamed":true,"phase":"planning","futureField":7}""") })
        // A cold start: nothing held in memory survives.
        manager.disconnect()
        manager.connect()
        index = factory.sockets.last().also { it.open() }
        withTimeout(10_000) { manager.awaitIngestionIdle() }

        manager.updateDraftInput("s1", "hi")
        val published = draftBlobs().single()
        assertTrue(published.get("hasBeenNamed").asBoolean)
        assertEquals(7, published.get("futureField").asInt)
        assertEquals("hi", published.get("draftInput").asString)

        // Nothing known about s2's blob: the draft is kept locally, not published over a guess.
        broadcast(entry("s2"))
        manager.updateDraftInput("s2", "wait")
        assertEquals(1, draftBlobs().size)
        assertEquals("wait", repository.getSession("s2")!!.draftInput)

        broadcast(entry("s2") { clientMetadata("""{"hasBeenNamed":true}""") })
        waitFor { draftBlobs().size == 2 }
        assertEquals("wait", draftBlobs().last().get("draftInput").asString)
        assertTrue(draftBlobs().last().get("hasBeenNamed").asBoolean)
    }

    @Test
    fun `edits made while offline are saved locally and republished once, from the row, after reconnect`() = runBlocking<Unit> {
        broadcast(entry("s1") { addProperty("hostDeviceId", "desk-1"); clientMetadata("""{"phase":"planning"}""") })
        index.fail(401)

        manager.updateDraftInput("s1", "first")
        manager.updateDraftInput("s1", "second")
        assertEquals("second", repository.getSession("s1")!!.draftInput)
        assertTrue(manager.setSessionArchived("s1", true).isFailure)
        assertTrue(manager.updateSessionParent("s1", "ws-1").isFailure)
        assertTrue(manager.updateSessionParent("s1", null).isFailure)
        assertNull(repository.getSession("s1")!!.parentSessionId)
        manager.markSessionRead("s1", 700L)
        // An interactive answer is never replayed: by reconnect the desktop has moved on.
        assertTrue(manager.sendSessionControlMessage("s1", "prompt_response").isFailure)
        assertEquals(SyncErrorKind.TRANSPORT, manager.syncError.value?.kind)

        manager.connectIfConfigured()
        index = factory.sockets.last().also { it.open() }
        withTimeout(10_000) { manager.awaitIngestionIdle() }

        val patches = sent("indexClientMetadataPatch").map { it.getAsJsonObject("patch") }
        val drafts = patches.filter { it.has("encryptedClientMetadata") }
        assertEquals("a burst of offline drafts publishes once", 1, drafts.size)
        val blob = crypto.decrypt(drafts.single().get("encryptedClientMetadata").asString, drafts.single().get("clientMetadataIv").asString)
        assertTrue(blob.contains("\"second\""))
        assertEquals(700L, patches.single { it.has("lastReadAt") }.get("lastReadAt").asLong)
        val controls = sent("sessionControl").map { it.getAsJsonObject("message") }
        assertEquals(listOf("archive"), controls.map { it.get("messageType").asString })
        assertTrue(controls.single().getAsJsonObject("payload").get("isArchived").asBoolean)
        val clear = sent("indexUpdate").single().getAsJsonObject("session")
        assertTrue(clear.get("parentSessionId").isJsonNull)
        assertFalse(clear.has("createdBySessionId"))

        // Once the room has answered every ping, delivery is proven and nothing is
        // left parked: the next reconnect publishes none of it again.
        var answered = 0
        while (answered < sent("ping").size) {
            deliver("pong") {}
            answered++
        }
        reconnectIndex()
        assertTrue(sent("indexClientMetadataPatch").isEmpty() && sent("sessionControl").isEmpty())
    }
}
