package com.nimbalyst.app.sync

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.ProjectEntity
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingCredentials
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
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

/**
 * Drives the real [SyncManager] against fake sockets. Each socket's listener is
 * fired by hand, so connection drops, 401s and stale callbacks are
 * deterministic.
 */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class SyncManagerLifecycleTest {
    private class FakeCredentials(override var credentials: PairingCredentials?) : SyncCredentialStore {
        override fun save(credentials: PairingCredentials) {
            this.credentials = credentials
        }
    }

    private val seed = "test-seed"
    private val userId = "user-1"
    private val crypto = CryptoManager.fromSeed(seed, userId)
    private val factory = FakeSocketFactory()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val store = FakeCredentials(
        PairingCredentials(
            serverUrl = "https://sync.example",
            encryptionSeed = seed,
            authJwt = "jwt-1",
            authUserId = userId,
            orgId = "org-1",
            sessionToken = "session-token"
        )
    )
    private var refreshCount = 0

    private lateinit var db: NimbalystDatabase
    private lateinit var repository: NimbalystRepository
    private lateinit var manager: SyncManager

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        db = Room.inMemoryDatabaseBuilder(context, NimbalystDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        // Open now: a lazy open on Room's IO thread racing tearDown's close()
        // deadlocks on the open helper's lock.
        db.openHelper.writableDatabase
        repository = NimbalystRepository(db)
        manager = SyncManager(
            context = context,
            repository = repository,
            credentialStore = store,
            notificationManager = NotificationManager(context),
            scope = scope,
            socketFactory = factory,
            tokenRefresher = TokenRefresher { credentials ->
                refreshCount++
                TokenRefresh.Refreshed(credentials.copy(authJwt = "jwt-${refreshCount + 1}"))
            }
        )
    }

    @After
    fun tearDown() {
        scope.cancel()
        db.close()
    }

    private fun indexSockets() = factory.sockets.filter { it.request.url.toString().contains(":index") }
    private fun sessionSockets(id: String) =
        factory.sockets.filter { it.request.url.toString().contains(":session:$id") }
    private fun FakeSocketFactory.FakeSocket.token() = request.url.queryParameter("token")
    private fun FakeSocketFactory.FakeSocket.live() = !cancelled && !closed
    private fun FakeSocketFactory.FakeSocket.sentOfType(type: String): List<JsonObject> =
        sent.map { JsonParser.parseString(it).asJsonObject }.filter { it.get("type").asString == type }

    private fun connectIndex(): FakeSocketFactory.FakeSocket {
        manager.connect()
        return indexSockets().last().also { it.open() }
    }

    private fun openSession(id: String): FakeSocketFactory.FakeSocket {
        manager.joinSessionRoom(id)
        return sessionSockets(id).last().also { it.open() }
    }

    @Test
    fun `token refresh keeps the open session receiving`() = runBlocking {
        val index = connectIndex()
        val session = openSession("s1")

        manager.refreshJwt()
        // The UI calls connectIfConfigured whenever stored credentials change.
        manager.connectIfConfigured()

        assertEquals("s1", manager.state.value.activeSessionId)
        assertTrue("session socket was torn down", session.live())
        assertTrue("index socket was torn down", index.live())
        assertEquals(1, indexSockets().size)
        assertEquals(1, sessionSockets("s1").size)
        assertTrue(manager.state.value.sessionConnected)
    }

    @Test
    fun `a session room rejected with 401 rejoins with the refreshed token`() = runBlocking {
        connectIndex()
        val session = openSession("s1")

        session.fail(401)

        val rejoined = sessionSockets("s1").last()
        assertTrue("session room was not rejoined", rejoined !== session)
        assertEquals("jwt-2", rejoined.token())
        assertEquals("s1", manager.state.value.activeSessionId)
    }

    @Test
    fun `leaving a session the user already navigated away from keeps the new room`() {
        connectIndex()
        openSession("a")
        val b = openSession("b")

        // A's screen is disposed after B's has joined.
        manager.leaveSessionRoom(expectedSessionId = "a")

        assertEquals("b", manager.state.value.activeSessionId)
        assertTrue(b.live())
        assertTrue(manager.state.value.sessionConnected)
    }

    @Test
    fun `the index room announces this device before anything else`() {
        val index = connectIndex()

        val first = JsonParser.parseString(index.sent.first()).asJsonObject
        assertEquals("deviceAnnounce", first.get("type").asString)
        val device = first.getAsJsonObject("device")
        assertEquals("android", device.get("platform").asString)
        assertEquals("active", device.get("status").asString)
        assertEquals(WebSocketClient.getDeviceId(ApplicationProvider.getApplicationContext()), device.get("deviceId").asString)
        // The session room must not announce; presence is per index connection.
        assertTrue(openSession("s1").sentOfType("deviceAnnounce").isEmpty())

        // Backgrounding is announced at once: the server withholds push from a
        // device that said "active" in the last two minutes.
        manager.setAppInForeground(false)
        val away = index.sentOfType("deviceAnnounce").last().getAsJsonObject("device")
        assertEquals("away", away.get("status").asString)
        assertFalse(away.get("isFocused").asBoolean)
    }

    @Test
    fun `read state is published, and republished after a reconnect when the send failed`() = runBlocking {
        repository.replaceIndexSnapshot(
            projects = listOf(ProjectEntity(id = "/p", name = "p")),
            sessions = listOf(SessionEntity(id = "s1", projectId = "/p", createdAt = 1L, updatedAt = 2L, isExecuting = true)),
            syncedAt = 1L
        )
        manager.connect()
        // Not open yet: the send fails and the marker waits.
        manager.markSessionRead("s1", 500L)
        assertEquals(500L, repository.getSession("s1")!!.lastReadAt)

        val index = indexSockets().last().also { it.open() }
        manager.awaitIngestionIdle()

        val receipt = index.sentOfType("indexClientMetadataPatch").single().getAsJsonObject("patch")
        assertEquals("s1", receipt.get("sessionId").asString)
        assertEquals(500L, receipt.get("lastReadAt").asLong)
        assertNull("a read receipt must not overwrite the message count", receipt.get("messageCount"))
        assertNull("a read receipt must not touch execution state", receipt.get("isExecuting"))
    }

    @Test
    fun `index messages apply in arrival order and a session for an unknown project does not crash`() = runBlocking {
        val index = connectIndex()
        fun sessionEntry(id: String, projectId: String, updatedAt: Long) = JsonObject().apply {
            addProperty("sessionId", id)
            addProperty("encryptedProjectId", crypto.encryptProjectId(projectId))
            addProperty("projectIdIv", CryptoManager.projectIdIvBase64)
            addProperty("provider", "claude-code")
            addProperty("createdAt", 1L)
            addProperty("updatedAt", updatedAt)
        }
        val snapshot = JsonObject().apply {
            addProperty("type", "indexSyncResponse")
            add("projects", com.google.gson.JsonArray().apply {
                add(JsonObject().apply {
                    addProperty("encryptedProjectId", crypto.encryptProjectId("/work/app"))
                    addProperty("projectIdIv", CryptoManager.projectIdIvBase64)
                })
            })
            add("sessions", com.google.gson.JsonArray().apply { add(sessionEntry("s1", "/work/app", 100L)) })
        }
        fun broadcast(entry: JsonObject) = JsonObject().apply {
            addProperty("type", "indexBroadcast")
            add("session", entry)
        }.toString()

        index.message(snapshot.toString())
        index.message(broadcast(sessionEntry("s1", "/work/app", 200L)))
        index.message(broadcast(sessionEntry("s2", "/work/new-project", 300L)))
        withTimeout(10_000) { manager.awaitIngestionIdle() }

        assertEquals(200L, repository.getSession("s1")!!.updatedAt)
        assertNotNull(repository.getSession("s2"))
        assertNull(manager.state.value.lastError)
    }

    @Test
    fun `a message from the room of a session the user left is not filed under the new one`() = runBlocking {
        connectIndex()
        repository.replaceIndexSnapshot(
            projects = listOf(ProjectEntity(id = "/p", name = "p")),
            sessions = listOf(
                SessionEntity(id = "a", projectId = "/p", createdAt = 1L, updatedAt = 1L),
                SessionEntity(id = "b", projectId = "/p", createdAt = 1L, updatedAt = 1L)
            ),
            syncedAt = 1L
        )
        val a = openSession("a")
        manager.awaitIngestionIdle()
        val content = crypto.encrypt("""{"content":"late"}""")

        // The message arrives while A is current but is applied after the user
        // switched to B: the socket guard cannot help, only arrival-time capture can.
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        manager.holdSessionIngestionForTest(gate)
        a.message(
            JsonObject().apply {
                addProperty("type", "messageBroadcast")
                add("message", JsonObject().apply {
                    addProperty("id", "m1")
                    addProperty("sequence", 1)
                    addProperty("createdAt", 1L)
                    addProperty("source", "claude-code")
                    addProperty("direction", "output")
                    addProperty("encryptedContent", content.encrypted)
                    addProperty("iv", content.iv)
                })
            }.toString()
        )
        openSession("b")
        gate.complete(Unit)
        withTimeout(10_000) { manager.awaitIngestionIdle() }

        assertEquals(1, repository.messageCount("a"))
        assertEquals(0, repository.messageCount("b"))
        assertFalse(a.live())
    }

    @Test
    fun `the refresh timer stops in the background, and a return to the foreground refreshes at once`() {
        connectIndex()
        assertTrue(manager.isJwtRefreshScheduled)

        manager.setAppInForeground(false)
        assertFalse(manager.isJwtRefreshScheduled)
        // A reconnect while backgrounded does not restart it.
        indexSockets().last().fail(401)
        assertFalse(manager.isJwtRefreshScheduled)

        val before = refreshCount
        manager.setAppInForeground(true)
        assertEquals(before + 1, refreshCount)
        assertTrue(manager.isJwtRefreshScheduled)
    }

    @Test
    fun `refreshes that fail for lack of a network never sign the user out`() = runBlocking {
        var now = 0L
        // Nothing listens on the discard port: every refresh is a connection failure.
        val offlineStore = FakeCredentials(store.credentials!!.copy(serverUrl = "http://127.0.0.1:9"))
        val offline = SyncManager(
            context = ApplicationProvider.getApplicationContext(),
            repository = repository,
            credentialStore = offlineStore,
            notificationManager = NotificationManager(ApplicationProvider.getApplicationContext()),
            scope = scope,
            socketFactory = factory,
            tokenRefresher = HttpTokenRefresher(com.google.gson.Gson()),
            authClock = { now }
        )

        repeat(AuthHealthTracker.SIGN_OUT_THRESHOLD + 1) { now += 5 * 60_000; offline.refreshJwt() }

        assertEquals(AuthHealth.Ok, offline.authHealth.value)
        assertEquals("jwt-1", offlineStore.credentials!!.authJwt)
    }

    @Test
    fun `a refresh answer for a session replaced during the request writes nothing`() = runBlocking {
        val accountA = store.credentials!!
        val accountB = store.credentials!!.copy(authJwt = "jwt-b", authUserId = "user-b", sessionToken = "session-b")
        var answer: TokenRefresh = TokenRefresh.Rejected
        var now = 0L
        val racing = SyncManager(
            context = ApplicationProvider.getApplicationContext(),
            repository = repository,
            credentialStore = store,
            notificationManager = NotificationManager(ApplicationProvider.getApplicationContext()),
            scope = scope,
            socketFactory = factory,
            // The user re-pairs to B while A's refresh is on the network.
            tokenRefresher = TokenRefresher { stale ->
                store.credentials = accountB
                if (answer is TokenRefresh.Refreshed) TokenRefresh.Refreshed(stale.copy(authJwt = "jwt-a-new")) else answer
            },
            authClock = { now }
        )

        answer = TokenRefresh.Refreshed(store.credentials!!)
        racing.refreshJwt()
        assertEquals("A's answer never overwrites B", accountB, store.credentials)

        answer = TokenRefresh.Rejected
        repeat(AuthHealthTracker.SIGN_OUT_THRESHOLD + 1) {
            store.credentials = accountA
            now += 5 * 60_000
            racing.refreshJwt()
        }
        assertEquals("A's rejection never signs B out", accountB, store.credentials)
        assertEquals(AuthHealth.Ok, racing.authHealth.value)
    }

    @Test
    fun `five failed refreshes sign the user out, keeping the pairing`() = runBlocking {
        var now = 0L
        val failing = SyncManager(
            context = ApplicationProvider.getApplicationContext(),
            repository = repository,
            credentialStore = store,
            notificationManager = NotificationManager(ApplicationProvider.getApplicationContext()),
            scope = scope,
            socketFactory = factory,
            tokenRefresher = TokenRefresher { TokenRefresh.Rejected },
            authClock = { now }
        )
        failing.connect()
        indexSockets().last().open()

        repeat(3) { now += 5 * 60_000; failing.refreshJwt() }
        assertEquals(AuthHealth.Degraded(3), failing.authHealth.value)
        repeat(2) { now += 5 * 60_000; failing.refreshJwt() }

        assertTrue(failing.authHealth.value is AuthHealth.SignedOut)
        val credentials = store.credentials!!
        assertNull("signed out", credentials.authJwt)
        assertFalse(credentials.hasAuthToken)
        assertEquals("the pairing survives sign-out", "test-seed", credentials.encryptionSeed)
        assertFalse(failing.state.value.indexConnected)

        // Signing back in starts healthy.
        store.save(credentials.copy(authJwt = "jwt-new"))
        failing.connect()
        assertEquals(AuthHealth.Ok, failing.authHealth.value)
    }
}
