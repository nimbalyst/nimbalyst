package com.nimbalyst.app.transcript

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.HapticFeedbackConstants
import android.view.View
import android.webkit.WebView
import android.widget.Toast
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.os.HandlerCompat
import com.nimbalyst.app.R

/** Callbacks the composable refreshes on every recomposition. */
internal data class TranscriptCallbacks(
    val onPromptSubmitted: (String) -> Unit,
    val onInteractiveResponse: (TranscriptBridgeMessage) -> Unit,
    val onOpenFile: ((String) -> Unit)?,
)

/**
 * Owns the transcript WebView for one [TranscriptWebView] composition: bridge
 * readiness, the delta/full-load decisions from [TranscriptSessionSync], the
 * load timeout, and recovery from a dead renderer. The Android counterpart of
 * the iOS `TranscriptWebView.Coordinator`.
 *
 * Main thread only.
 */
internal class TranscriptHost(
    private val context: Context,
    private val controller: TranscriptController?,
) : TranscriptWebViewClient.Host {

    /** Null when the WebView provider is unavailable, or between a renderer death and its replacement. */
    var webView: WebView? by mutableStateOf(TranscriptWebViewPool.take(context))
        private set

    /** Non-null when the transcript failed to load; the composable shows it with Retry. */
    var error: String? by mutableStateOf(null)
        private set

    var callbacks: TranscriptCallbacks = TranscriptCallbacks({}, {}, null)

    private val sync = TranscriptSessionSync()
    private val handler = Handler(Looper.getMainLooper())
    private val crashBudget = TranscriptRenderCrashBudget()

    // The session the visible page is confirmed to show. Pooled views keep
    // their previous sessions, so the view stays hidden until this matches.
    private var displayedSessionId: String? = null
    private var probeGeneration = 0
    private var disposed = false
    private val loadTimeout = Runnable { onLoadTimeout() }

    init {
        webView?.let(::attach) ?: showWebViewUnavailable()
    }

    fun submit(snapshot: TranscriptSnapshot) {
        if (disposed) return
        execute(sync.onSnapshot(snapshot))
        if (snapshot.messages.isEmpty()) {
            // The screen's first frame is an empty placeholder list; give Room
            // a moment before loading an empty transcript over a cached one.
            handler.postDelayed({
                if (!disposed) execute(sync.allowEmptyLoad(snapshot.sessionId))
            }, EMPTY_LOAD_GRACE_MS)
        }
    }

    fun retry() {
        Log.i(TAG, "Retry requested (recent renderer crashes=${crashBudget.recentCrashes})")
        error = null
        crashBudget.reset()
        val current = webView
        if (current == null || TranscriptWebViewPool.getClient(current)?.rendererGone == true) {
            replaceWebView(TranscriptWebViewPool.create(context))
        } else {
            resetBridge()
            TranscriptWebViewPool.reload(current)
            startProbe(current)
            scheduleLoadTimeout()
        }
    }

    fun dismissError() {
        error = null
    }

    fun debugInfo(): String {
        val snapshot = sync.latestSnapshot
        return buildString {
            appendLine("Transcript error: ${error ?: "none"}")
            appendLine("Session: ${snapshot?.sessionId ?: "none"} (${snapshot?.messages?.size ?: 0} messages)")
            appendLine("Bridge ready: ${sync.bridgeReady}, confirmed: ${sync.confirmedSessionId ?: "none"}")
            appendLine("Recent renderer crashes: ${crashBudget.recentCrashes}")
            append("WebView: ${runCatching { WebView.getCurrentWebViewPackage()?.versionName }.getOrNull() ?: "unknown"}")
        }
    }

    fun dispose() {
        disposed = true
        handler.removeCallbacksAndMessages(null)
        webView?.let(::detach)
        controller?.webView = null
        controller?.isReady = false
    }

    // -- WebView lifecycle --------------------------------------------------

    private fun attach(view: WebView) {
        TranscriptWebViewPool.getRelay(view)?.handler = { message -> onBridgeMessage(view, message) }
        TranscriptWebViewPool.getClient(view)?.host = this
        controller?.webView = view
        controller?.isReady = false
        displayedSessionId = null
        view.visibility = View.INVISIBLE
        // A pooled view posted "ready" before anyone was listening, so ask.
        startProbe(view)
        scheduleLoadTimeout()
    }

    private fun detach(view: WebView) {
        TranscriptWebViewPool.getRelay(view)?.handler = null
        TranscriptWebViewPool.getClient(view)?.host = null
    }

    /**
     * Swap in [next]; the old view is released (and destroyed if dead) by the
     * AndroidView's onRelease. A null [next] leaves no view on screen.
     */
    private fun replaceWebView(next: WebView?) {
        webView?.let(::detach)
        resetBridge()
        webView = next
        if (next != null) attach(next) else showWebViewUnavailable()
    }

    private fun showWebViewUnavailable() {
        handler.removeCallbacks(loadTimeout)
        controller?.webView = null
        controller?.isReady = false
        error = context.getString(R.string.webview_unavailable)
    }

    private fun resetBridge() {
        sync.onBridgeLost()
        controller?.isReady = false
        probeGeneration++
        handler.removeCallbacksAndMessages(PROBE_TOKEN)
    }

    override fun onPageFinished(view: WebView) {
        if (view !== webView) return
        if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            // Enables the bundle's _debugRaw/_debugView/_debugCache helpers.
            view.evaluateJavascript("window.__nimbalystDebug = true;", null)
        }
    }

    override fun onRenderProcessGone(view: WebView, didCrash: Boolean) {
        if (disposed || view !== webView) {
            TranscriptWebViewPool.discard(view)
            return
        }
        resetBridge()
        // Drop the dead view now: the AndroidView's onRelease destroys it, and
        // nothing evaluates script on it while the replacement waits.
        detach(view)
        webView = null
        controller?.webView = null
        // A successful loadSession does not reset this budget: the bundle
        // acknowledges before it renders, so render-time crashes would loop.
        if (!crashBudget.recordCrash(SystemClock.elapsedRealtime())) {
            Log.e(TAG, "Transcript renderer gone ${crashBudget.recentCrashes} times recently; not reloading")
            handler.removeCallbacks(loadTimeout)
            error = "The transcript stopped responding (${crashBudget.recentCrashes} renderer ${if (didCrash) "crashes" else "restarts"})."
            return
        }
        Log.w(TAG, "Reloading transcript after renderer loss (${crashBudget.recentCrashes} recent)")
        handler.postDelayed({
            // Retry may already have replaced it.
            if (!disposed && webView == null) {
                replaceWebView(TranscriptWebViewPool.create(context))
            }
        }, RENDER_RELOAD_DELAY_MS)
    }

    // -- JS -> native -------------------------------------------------------

    private fun onBridgeMessage(view: WebView, message: TranscriptBridgeMessage) {
        if (disposed || view !== webView) return
        if (!message.isForSession(displayedSessionId)) {
            Log.w(TAG, "Dropped ${message.type} from a session not on screen")
            return
        }
        when (message.type) {
            "ready" -> onBridgeReady()
            "prompt" -> message.text?.let(callbacks.onPromptSubmitted)
            // Includes requestUserInputSubmit/Cancel; the screen routes every
            // action through the same sync call.
            "interactive_response" -> callbacks.onInteractiveResponse(message)
            "open_url" -> message.url?.let { TranscriptExternalLinks.open(context, it) }
            "open_file" -> message.filePath?.let { path ->
                val onOpenFile = callbacks.onOpenFile
                if (onOpenFile != null) {
                    onOpenFile(path)
                } else {
                    Toast.makeText(context, "Opening files is not available on Android yet.", Toast.LENGTH_SHORT).show()
                }
            }
            "haptic" -> view.performHapticFeedback(hapticConstant(message.hapticStyle))
            "js_error" -> if (!message.isBenignJsError) Log.e(TAG, "JS error: ${message.errorDescription}")
            else -> Log.d(TAG, "Unknown bridge message type: ${message.type}")
        }
    }

    private fun onBridgeReady() {
        probeGeneration++
        scheduleLoadTimeout()
        execute(sync.onBridgeReady())
    }

    private fun startProbe(view: WebView) {
        val generation = ++probeGeneration
        probe(view, generation, attempt = 0)
    }

    private fun isStaleProbe(view: WebView, generation: Int): Boolean =
        disposed || view !== webView || generation != probeGeneration || sync.bridgeReady

    private fun probe(view: WebView, generation: Int, attempt: Int) {
        // Checked before evaluating too: a probe queued before a renderer
        // death must not touch the dead view.
        if (isStaleProbe(view, generation)) return
        view.evaluateJavascript("typeof window.nimbalyst") { result ->
            if (isStaleProbe(view, generation)) return@evaluateJavascript
            if (TranscriptBridge.parseJsResult(result)?.asString == "object") {
                onBridgeReady()
                return@evaluateJavascript
            }
            if (attempt < MAX_PROBE_ATTEMPTS) {
                val delayMs = minOf((100 * Math.pow(1.5, attempt.toDouble())).toLong(), 2_000L)
                HandlerCompat.postDelayed(handler, { probe(view, generation, attempt + 1) }, PROBE_TOKEN, delayMs)
            }
            // Out of attempts: the "ready" post or the load timeout takes over.
        }
    }

    // -- native -> JS -------------------------------------------------------

    private fun execute(commands: List<TranscriptCommand>) {
        for (command in commands) {
            when (command) {
                is TranscriptCommand.Load -> sendLoad(command)
                is TranscriptCommand.Append -> sendMutation(
                    command,
                    "appendMessages(${TranscriptPayloadBuilder.buildMessagesJson(command.messages)}, " +
                        "${TranscriptPayloadBuilder.jsString(command.sessionId)})"
                )
                is TranscriptCommand.UpdateMetadata -> sendMutation(
                    command,
                    "updateMetadata(${TranscriptPayloadBuilder.buildMetadataJson(command.metadata)}, " +
                        "${TranscriptPayloadBuilder.jsString(command.sessionId)})"
                )
            }
        }
    }

    private fun sendLoad(command: TranscriptCommand.Load) {
        val view = webView ?: return
        val snapshot = command.snapshot
        val payload = TranscriptPayloadBuilder.buildSessionPayload(
            sessionId = snapshot.sessionId,
            metadata = snapshot.metadata,
            messages = snapshot.messages,
            replace = command.replace
        )
        Log.i(TAG, "loadSession ${snapshot.sessionId}: ${snapshot.messages.size} messages, replace=${command.replace}")
        controller?.isReady = false
        if (snapshot.sessionId != displayedSessionId) {
            displayedSessionId = null
            view.visibility = View.INVISIBLE
        }
        scheduleLoadTimeout()
        // The bridge echoes the session it activated. Without that, a missing
        // window.nimbalyst would look like success and leave the pooled view
        // showing the previous session.
        val script = "(function(){var n=window.nimbalyst;return n?n.loadSession($payload):null;})()"
        view.evaluateJavascript(script) { result ->
            if (disposed || view !== webView) return@evaluateJavascript
            val outcome = sync.onLoadResult(command, TranscriptBridge.activatedSessionId(result))
            if (outcome.activated) {
                handler.removeCallbacks(loadTimeout)
                error = null
                controller?.isReady = true
                displayedSessionId = snapshot.sessionId
                view.visibility = View.VISIBLE
            }
            outcome.failureReason?.let { reason ->
                Log.e(TAG, "loadSession: $reason")
                handler.removeCallbacks(loadTimeout)
                error = "The transcript could not be loaded."
            }
            execute(outcome.next)
        }
    }

    private fun sendMutation(command: TranscriptCommand, call: String) {
        val view = webView ?: return
        val script = "(function(){var n=window.nimbalyst;return n?n.$call:null;})()"
        view.evaluateJavascript(script) { result ->
            if (disposed || view !== webView) return@evaluateJavascript
            val accepted = TranscriptBridge.mutationAccepted(result)
            if (!accepted) {
                Log.w(TAG, "Bridge rejected ${command::class.simpleName}; falling back to a full load")
            }
            execute(sync.onMutationResult(command.generation, accepted))
        }
    }

    private fun scheduleLoadTimeout() {
        handler.removeCallbacks(loadTimeout)
        handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS)
    }

    private fun onLoadTimeout() {
        if (disposed || sync.isShowingLatest || sync.latestSnapshot == null) return
        Log.e(TAG, "Transcript not ready after ${LOAD_TIMEOUT_MS}ms (bridgeReady=${sync.bridgeReady})")
        error = if (sync.bridgeReady) {
            "The transcript took too long to load."
        } else {
            "The transcript view did not start."
        }
    }

    private fun hapticConstant(style: String): Int = when (style) {
        "light" -> HapticFeedbackConstants.KEYBOARD_TAP
        "heavy" -> HapticFeedbackConstants.LONG_PRESS
        else -> HapticFeedbackConstants.CONTEXT_CLICK
    }

    private companion object {
        const val TAG = "TranscriptWebView"
        const val RENDER_RELOAD_DELAY_MS = 500L
        const val LOAD_TIMEOUT_MS = 10_000L
        const val EMPTY_LOAD_GRACE_MS = 250L
        const val MAX_PROBE_ATTEMPTS = 10
        val PROBE_TOKEN = Any()
    }
}
