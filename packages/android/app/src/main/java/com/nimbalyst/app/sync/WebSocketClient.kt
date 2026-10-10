package com.nimbalyst.app.sync

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Opens a socket. Tests substitute a fake so listener callbacks can be driven directly. */
fun interface WebSocketFactory {
    fun open(request: Request, listener: WebSocketListener): WebSocket
}

class WebSocketClient(
    private val scope: CoroutineScope,
    private val reconnectDelayMs: Long = 3_000L,
    private val socketFactory: WebSocketFactory = defaultSocketFactory,
) {
    companion object {
        private const val TAG = "WebSocketClient"
        private const val PREFS_NAME = "nimbalyst_device"
        private const val KEY_DEVICE_ID = "device_id"

        @Volatile
        private var cachedDeviceId: String? = null

        /**
         * Shared by every sync socket. OkHttp's ping frames detect a socket the
         * network silently dropped; without them a dead connection looks healthy
         * until the next send. 20s matches iOS and stays under common NAT idle
         * timeouts.
         */
        internal val defaultHttpClient: OkHttpClient = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()

        internal val defaultSocketFactory = WebSocketFactory { request, listener ->
            defaultHttpClient.newWebSocket(request, listener)
        }

        /**
         * App version string used to label sync WebSocket connections for the
         * server's connect/disconnect telemetry. Set once at app startup (see
         * NimbalystApplication). Null until set, in which case "unknown" is sent.
         */
        @Volatile
        var appVersion: String? = null

        /**
         * Clamp a sync telemetry label to 32 chars (matching the server) and
         * URL-encode it for use in the WebSocket upgrade query string.
         */
        fun encodedClientLabel(value: String): String {
            val clamped = if (value.length > 32) value.substring(0, 32) else value
            return URLEncoder.encode(clamped, StandardCharsets.UTF_8)
        }

        fun getDeviceId(context: Context): String {
            cachedDeviceId?.let { return it }
            val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val id = prefs.getString(KEY_DEVICE_ID, null) ?: UUID.randomUUID().toString().also {
                prefs.edit().putString(KEY_DEVICE_ID, it).apply()
            }
            cachedDeviceId = id
            return id
        }
    }

    private val lock = Any()

    /**
     * Serializes every connection-state transition and message dispatch with
     * the generation check that guards it. Without it a callback could pass
     * its check, lose the CPU to a replacement socket opening, and then mark
     * the healthy replacement disconnected. Always taken before [lock].
     */
    private val dispatchLock = Any()

    /** Test seam: runs after a callback passed its generation check, before its effect. */
    @androidx.annotation.VisibleForTesting
    internal var afterGenerationCheckForTest: ((event: String) -> Unit)? = null
    private var currentWebSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var announceJob: Job? = null
    private var isIntentionallyClosed = false
    private var connectionParams: ConnectionParams? = null

    /**
     * Bumped every time a socket is opened or retired. A listener callback
     * carries the generation it was opened under and is dropped once that
     * generation is gone, so a cancelled socket can neither mark the client
     * disconnected nor deliver a message into the next room.
     */
    private var generation = 0L

    @Volatile
    var isConnected: Boolean = false
        private set

    /** Tag passed to [connect] for the socket currently open, or null. */
    val connectedTag: String?
        get() = synchronized(lock) { connectionParams?.tag.takeIf { currentWebSocket != null } }

    /**
     * Messages arrive with the tag of the connection that received them. A
     * session room tags its socket with the session id, so a message is
     * attributed to the room it came from rather than whatever is active by
     * the time it is processed.
     */
    var onTextMessage: ((text: String, tag: String?) -> Unit)? = null
    var onConnectionStateChanged: ((Boolean) -> Unit)? = null
    var onFailure: ((String) -> Unit)? = null
    var onHttpError: ((Int) -> Unit)? = null

    /**
     * Builds the presence heartbeat. When set, it is sent as soon as a socket
     * opens and every [ANNOUNCE_INTERVAL_MS] while it stays open.
     */
    var deviceAnnouncement: (() -> String?)? = null

    fun connect(serverUrl: String, roomId: String, authToken: String, tag: String? = null) {
        synchronized(lock) {
            connectionParams = ConnectionParams(serverUrl, roomId, authToken, tag)
            isIntentionallyClosed = false
        }
        connectInternal()
    }

    /**
     * Swaps the token used for the next (re)connect without touching the open
     * socket. The server authenticates at upgrade only, so a live socket stays
     * valid after its JWT expires.
     */
    fun updateAuthToken(authToken: String) {
        synchronized(lock) {
            connectionParams = connectionParams?.copy(authToken = authToken)
        }
    }

    /** Sends a presence heartbeat now, e.g. when the app moves to or from the background. */
    fun announceNow() {
        val build = deviceAnnouncement ?: return
        if (isConnected) build()?.let(::sendRaw)
    }

    /** Reconnects when a room is configured but no socket is open or opening. */
    fun ensureConnected() {
        val idle = synchronized(lock) {
            connectionParams != null && !isIntentionallyClosed && currentWebSocket == null
        }
        if (idle) connectInternal()
    }

    fun disconnect(): Unit = synchronized(dispatchLock) {
        val socket = synchronized(lock) {
            isIntentionallyClosed = true
            generation++
            reconnectJob?.cancel()
            reconnectJob = null
            announceJob?.cancel()
            announceJob = null
            currentWebSocket.also { currentWebSocket = null }
        }
        socket?.close(1000, "client disconnect")
        transition(expectedGeneration = null, connected = false)
    }

    fun sendRaw(json: String): Boolean {
        val socket = synchronized(lock) { currentWebSocket.takeIf { isConnected } }
        return socket?.send(json) ?: false
    }

    private fun connectInternal(): Unit = synchronized(dispatchLock) {
        val (params, openedGeneration, previous) = synchronized(lock) {
            val params = connectionParams ?: return
            reconnectJob?.cancel()
            reconnectJob = null
            announceJob?.cancel()
            announceJob = null
            generation++
            Triple(params, generation, currentWebSocket.also { currentWebSocket = null })
        }
        previous?.cancel()
        transition(expectedGeneration = openedGeneration, connected = false)

        val url = buildWebSocketUrl(params)
        Log.d(TAG, "Connecting to: ${url.substringBefore("?token=")}")

        val request = Request.Builder()
            .url(url)
            .build()

        val socket = socketFactory.open(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response): Unit = synchronized(dispatchLock) {
                if (!isCurrent(webSocket, openedGeneration)) return
                afterGenerationCheckForTest?.invoke("open")
                Log.d(TAG, "WebSocket onOpen: ${response.code}")
                // Announce before the owner's connected callback sends its first
                // request, so the server knows the device when it answers.
                startAnnouncing(webSocket, openedGeneration)
                transition(expectedGeneration = openedGeneration, connected = true)
                Unit
            }

            override fun onMessage(webSocket: WebSocket, text: String): Unit = synchronized(dispatchLock) {
                if (!isCurrent(webSocket, openedGeneration)) return
                afterGenerationCheckForTest?.invoke("message")
                onTextMessage?.invoke(text, params.tag)
                Unit
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
                synchronized(dispatchLock) {
                    if (!isCurrent(webSocket, openedGeneration)) return
                    Log.d(TAG, "WebSocket onClosing: code=$code reason=$reason")
                    transition(expectedGeneration = openedGeneration, connected = false)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String): Unit = synchronized(dispatchLock) {
                val retired = retire(webSocket, openedGeneration) ?: return
                afterGenerationCheckForTest?.invoke("closed")
                Log.d(TAG, "WebSocket onClosed: code=$code reason=$reason")
                if (transition(expectedGeneration = retired, connected = false)) scheduleReconnect()
                Unit
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?): Unit = synchronized(dispatchLock) {
                val retired = retire(webSocket, openedGeneration) ?: return
                afterGenerationCheckForTest?.invoke("failure")
                Log.e(TAG, "WebSocket onFailure: ${t.message}, response=${response?.code}", t)
                // A replacement opened since this socket retired owns the state now.
                if (!transition(expectedGeneration = retired, connected = false)) return
                val httpCode = response?.code
                if (httpCode != null) {
                    onHttpError?.invoke(httpCode)
                }
                onFailure?.invoke(t.message ?: "WebSocket failure")
                // Don't auto-reconnect on auth errors - the owner refreshes the
                // JWT and calls ensureConnected().
                if (httpCode != 401) scheduleReconnect()
            }
        })
        val stillCurrent = synchronized(lock) {
            if (generation == openedGeneration && !isIntentionallyClosed) {
                currentWebSocket = socket
                true
            } else {
                false
            }
        }
        if (!stillCurrent) socket.cancel()
    }

    private fun isCurrent(webSocket: WebSocket, openedGeneration: Long): Boolean =
        synchronized(lock) {
            generation == openedGeneration && (currentWebSocket == null || currentWebSocket === webSocket)
        }

    /** Clears [webSocket] as the current socket, returning the new generation. Null when it was already stale. */
    private fun retire(webSocket: WebSocket, openedGeneration: Long): Long? =
        synchronized(lock) {
            if (!isCurrent(webSocket, openedGeneration)) return@synchronized null
            generation++
            currentWebSocket = null
            announceJob?.cancel()
            announceJob = null
            generation
        }

    private fun startAnnouncing(webSocket: WebSocket, openedGeneration: Long) {
        val build = deviceAnnouncement ?: return
        // A lost heartbeat needs no replay: the next one carries current
        // presence, and a dead socket is caught by pings.
        build()?.let(webSocket::send)
        val job = scope.launch {
            while (isActive) {
                delay(ANNOUNCE_INTERVAL_MS)
                if (!isCurrent(webSocket, openedGeneration)) return@launch
                build()?.let(webSocket::send)
            }
        }
        synchronized(lock) {
            if (generation == openedGeneration) {
                announceJob?.cancel()
                announceJob = job
            } else {
                job.cancel()
            }
        }
    }

    private fun scheduleReconnect() {
        synchronized(lock) {
            if (isIntentionallyClosed || reconnectJob?.isActive == true) return
            reconnectJob = scope.launch {
                delay(reconnectDelayMs)
                ensureConnected()
            }
        }
    }

    private fun buildWebSocketUrl(params: ConnectionParams): String {
        val wsBase = params.serverUrl
            .replace("https://", "wss://")
            .replace("http://", "ws://")
            .trimEnd('/')
        val encodedToken = URLEncoder.encode(params.authToken, StandardCharsets.UTF_8)
        // Non-sensitive client labels for server connect/disconnect telemetry.
        val platformLabel = encodedClientLabel("mobile")
        val versionLabel = encodedClientLabel(appVersion ?: "unknown")
        return "$wsBase/sync/${params.roomId}?token=$encodedToken&platform=$platformLabel&version=$versionLabel"
    }

    /**
     * Applies a connection state only while [expectedGeneration] is still the
     * current one (null applies unconditionally, for a deliberate disconnect).
     * Runs under [dispatchLock], so the owner sees transitions in the order
     * they took effect. Returns whether it applied.
     */
    private fun transition(expectedGeneration: Long?, connected: Boolean): Boolean = synchronized(dispatchLock) {
        val applied = synchronized(lock) {
            if (expectedGeneration != null && generation != expectedGeneration) return@synchronized false
            isConnected = connected
            true
        }
        if (applied) onConnectionStateChanged?.invoke(connected)
        applied
    }
}

private data class ConnectionParams(
    val serverUrl: String,
    val roomId: String,
    val authToken: String,
    val tag: String?,
)

private const val ANNOUNCE_INTERVAL_MS = 30_000L
