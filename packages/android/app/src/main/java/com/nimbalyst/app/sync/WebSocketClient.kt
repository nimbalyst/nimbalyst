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
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class WebSocketClient(
    private val scope: CoroutineScope,
    private val reconnectDelayMs: Long = 3_000L,
) {
    companion object {
        private const val TAG = "WebSocketClient"
        private const val PREFS_NAME = "nimbalyst_device"
        private const val KEY_DEVICE_ID = "device_id"

        @Volatile
        private var cachedDeviceId: String? = null

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

    private val okHttpClient = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var currentWebSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var isIntentionallyClosed = false
    private var connectionParams: ConnectionParams? = null
    @Volatile
    private var connectionGeneration: Long = 0

    @Volatile
    var isConnected: Boolean = false
        private set

    var onTextMessage: ((String) -> Unit)? = null
    var onConnectionStateChanged: ((Boolean) -> Unit)? = null
    var onFailure: ((String) -> Unit)? = null
    var onHttpError: ((Int) -> Unit)? = null

    fun connect(serverUrl: String, roomId: String, authToken: String) {
        connectionParams = ConnectionParams(serverUrl, roomId, authToken)
        isIntentionallyClosed = false
        connectInternal()
    }

    fun disconnect() {
        isIntentionallyClosed = true
        bumpConnectionGeneration()
        reconnectJob?.cancel()
        reconnectJob = null
        currentWebSocket?.close(1000, "client disconnect")
        currentWebSocket = null
        updateConnection(false)
    }

    fun sendRaw(json: String): Boolean = currentWebSocket?.send(json) ?: false

    private fun connectInternal() {
        val params = connectionParams ?: return
        val generation = bumpConnectionGeneration()
        reconnectJob?.cancel()
        currentWebSocket?.cancel()
        currentWebSocket = null
        updateConnection(false)

        val url = buildWebSocketUrl(params)
        Log.d(TAG, "Connecting to: ${url.take(120)}...")

        val request = Request.Builder()
            .url(url)
            .build()

        currentWebSocket = okHttpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!isCurrentConnection(webSocket, generation)) return
                Log.d(TAG, "WebSocket onOpen: ${response.code}")
                reconnectJob?.cancel()
                updateConnection(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isCurrentConnection(webSocket, generation)) return
                onTextMessage?.invoke(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (!isCurrentConnection(webSocket, generation)) return
                Log.d(TAG, "WebSocket onClosing: code=$code reason=$reason")
                webSocket.close(code, reason)
                updateConnection(false)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!isCurrentConnection(webSocket, generation)) return
                Log.d(TAG, "WebSocket onClosed: code=$code reason=$reason")
                updateConnection(false)
                if (!isIntentionallyClosed) {
                    scheduleReconnect()
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!isCurrentConnection(webSocket, generation)) return
                Log.e(TAG, "WebSocket onFailure: ${t.message}, response=${response?.code}", t)
                updateConnection(false)
                val httpCode = response?.code
                if (httpCode != null) {
                    onHttpError?.invoke(httpCode)
                }
                onFailure?.invoke(t.message ?: "WebSocket failure")
                if (!isIntentionallyClosed) {
                    // Don't auto-reconnect on auth errors - let the caller handle JWT refresh
                    if (httpCode == 401) return
                    scheduleReconnect()
                }
            }
        })
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) {
            return
        }
        reconnectJob = scope.launch {
            delay(reconnectDelayMs)
            if (!isIntentionallyClosed) {
                connectInternal()
            }
        }
    }

    @Synchronized
    private fun bumpConnectionGeneration(): Long {
        connectionGeneration += 1
        return connectionGeneration
    }

    private fun isCurrentConnection(webSocket: WebSocket, generation: Long): Boolean {
        return generation == connectionGeneration && currentWebSocket == webSocket
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

    private fun updateConnection(connected: Boolean) {
        isConnected = connected
        onConnectionStateChanged?.invoke(connected)
    }
}

private data class ConnectionParams(
    val serverUrl: String,
    val roomId: String,
    val authToken: String
)
