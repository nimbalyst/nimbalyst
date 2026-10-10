package com.nimbalyst.app.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Records every socket the client opens so a test can fire any socket's listener. */
internal class FakeSocketFactory : WebSocketFactory {
    class FakeSocket(val request: Request, val listener: WebSocketListener) : WebSocket {
        val sent: MutableList<String> = java.util.concurrent.CopyOnWriteArrayList()
        var cancelled = false
        var closed = false
        override fun request(): Request = request
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean {
            if (cancelled || closed) return false
            sent += text
            return true
        }
        override fun send(bytes: ByteString): Boolean = !cancelled && !closed
        override fun close(code: Int, reason: String?): Boolean {
            closed = true
            return true
        }
        override fun cancel() {
            cancelled = true
        }

        fun open() = listener.onOpen(this, response(101))
        fun message(text: String) = listener.onMessage(this, text)
        fun closedByServer() = listener.onClosed(this, 1006, "gone")
        fun fail(code: Int? = null) =
            listener.onFailure(this, RuntimeException("boom"), code?.let(::response))

        private fun response(code: Int) = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("")
            .build()
    }

    val sockets: MutableList<FakeSocket> = java.util.concurrent.CopyOnWriteArrayList()
    val last: FakeSocket get() = sockets.last()

    override fun open(request: Request, listener: WebSocketListener): WebSocket =
        FakeSocket(request, listener).also { sockets += it }
}

class WebSocketClientTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val factory = FakeSocketFactory()
    private val client = WebSocketClient(scope, reconnectDelayMs = 0, socketFactory = factory)

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun `callbacks from a replaced socket are ignored`() {
        val states = mutableListOf<Boolean>()
        val messages = mutableListOf<String>()
        client.onConnectionStateChanged = { states += it }
        client.onTextMessage = { text, tag -> messages += "$tag:$text" }

        client.connect("wss://sync.example", "room-a", "jwt", tag = "a")
        val stale = factory.last
        stale.open()
        client.connect("wss://sync.example", "room-b", "jwt", tag = "b")
        val current = factory.last
        current.open()
        states.clear()

        stale.message("""{"type":"late"}""")
        stale.closedByServer()
        stale.fail()

        assertTrue("stale socket delivered a message", messages.isEmpty())
        assertTrue("stale socket changed connection state: $states", states.isEmpty())
        assertTrue(client.isConnected)
        assertEquals("stale close scheduled a reconnect", 2, factory.sockets.size)

        current.message("""{"type":"live"}""")
        assertEquals(listOf("""b:{"type":"live"}"""), messages)
    }

    @Test
    fun `sync sockets send ping frames`() {
        assertEquals(20_000, WebSocketClient.defaultHttpClient.pingIntervalMillis)
    }

    @Test
    fun `presence is announced as soon as the socket opens`() {
        client.deviceAnnouncement = { """{"type":"deviceAnnounce"}""" }
        client.connect("wss://sync.example", "room-a", "jwt")
        assertTrue(factory.last.sent.isEmpty())

        factory.last.open()

        assertEquals(listOf("""{"type":"deviceAnnounce"}"""), factory.last.sent)
    }

    @Test
    fun `a refreshed token is used by the next reconnect without dropping the open socket`() {
        client.connect("wss://sync.example", "room-a", "old-jwt")
        factory.last.open()

        client.updateAuthToken("new-jwt")
        assertEquals(1, factory.sockets.size)
        assertTrue(client.isConnected)

        factory.last.closedByServer()

        assertEquals(2, factory.sockets.size)
        assertEquals("new-jwt", factory.last.request.url.queryParameter("token"))
    }

    @Test
    fun `a retired socket cannot mark the replacement that opened in the meantime disconnected`() {
        val states = mutableListOf<Boolean>()
        client.onConnectionStateChanged = { states += it }
        client.connect("wss://sync.example", "room-a", "jwt")
        val old = factory.last
        old.open()

        // The old socket fails; between its generation check and its effect a
        // caller reconnects and the replacement opens.
        client.afterGenerationCheckForTest = { event ->
            if (event == "failure") {
                client.afterGenerationCheckForTest = null
                client.ensureConnected()
                factory.last.open()
            }
        }
        old.fail()

        assertTrue(client.isConnected)
        assertTrue("sends refused on a healthy socket", client.sendRaw("{}"))
        assertEquals(true, states.last())
        assertEquals("the stale failure scheduled another reconnect", 2, factory.sockets.size)
    }

    /**
     * R1-5: a real second thread, not a reentrant call. A message that passed
     * its generation check finishes delivering before another thread can
     * switch rooms, so the owner never sees room A's message after room B
     * reported connected.
     */
    @Test
    fun `a message mid-dispatch finishes before another thread's replacement socket connects`() {
        val events = java.util.concurrent.CopyOnWriteArrayList<String>()
        client.onConnectionStateChanged = { events += "connected=$it" }
        client.onTextMessage = { text, tag -> events += "$tag:$text" }
        client.connect("wss://sync.example", "room-a", "jwt", tag = "a")
        val old = factory.last
        old.open()
        events.clear()

        val paused = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        client.afterGenerationCheckForTest = { event ->
            if (event == "message") {
                paused.countDown()
                release.await(5, java.util.concurrent.TimeUnit.SECONDS)
            }
        }
        val reader = Thread { old.message("late") }.apply { start() }
        assertTrue(paused.await(5, java.util.concurrent.TimeUnit.SECONDS))
        client.afterGenerationCheckForTest = null

        val switcher = Thread {
            client.connect("wss://sync.example", "room-b", "jwt", tag = "b")
            factory.last.open()
        }.apply { start() }
        // Long enough for an unguarded switch to finish; a guarded one waits on the message.
        switcher.join(300)
        release.countDown()
        reader.join(5_000)
        switcher.join(5_000)

        assertEquals(listOf("a:late", "connected=false", "connected=true"), events)
    }

    @Test
    fun `an open that loses to a disconnect does not report connected`() {
        val states = mutableListOf<Boolean>()
        client.onConnectionStateChanged = { states += it }
        client.connect("wss://sync.example", "room-a", "jwt")
        client.afterGenerationCheckForTest = { event ->
            if (event == "open") {
                client.afterGenerationCheckForTest = null
                client.disconnect()
            }
        }
        factory.last.open()

        assertFalse(client.isConnected)
        assertEquals(false, states.last())
    }
}
