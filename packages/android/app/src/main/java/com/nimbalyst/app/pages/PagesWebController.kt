package com.nimbalyst.app.pages

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import java.net.URI
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/** A native dialog the Pages screen can raise. */
sealed interface PagesSheet {
    data object PersonalPages : PagesSheet
    data class OrgAuthRequired(val orgId: String, val reason: String?) : PagesSheet
    data object DesktopOnly : PagesSheet
}

/** Why a session could not be minted, as the reader is told. */
enum class PagesSessionFailure { NOT_A_MEMBER, UNAVAILABLE, ORG_AUTH_REQUIRED, NETWORK, SIGN_IN_REFRESH, GENERIC }

sealed interface PagesFailure {
    data object Offline : PagesFailure
    /** [detail] is the WebView's own error description, when it gave one. */
    data class Load(val detail: String?) : PagesFailure
    data object InvalidAddress : PagesFailure
    /** The render process died repeatedly before the console came up. */
    data object Stopped : PagesFailure
    data class Server(val status: Int) : PagesFailure
    data class Session(val kind: PagesSessionFailure) : PagesFailure
}

sealed interface PagesPhase {
    data object Idle : PagesPhase
    data object Loading : PagesPhase
    data object Ready : PagesPhase
    data class Failed(val failure: PagesFailure) : PagesPhase
}

data class PagesUiState(
    val phase: PagesPhase = PagesPhase.Idle,
    val title: String = "",
    val canGoBack: Boolean = false,
    val editing: Boolean = false,
    val unsynced: Boolean = false,
    val sheet: PagesSheet? = null,
    val lostEditsNotice: Boolean = false,
    /** Bumped when the WebView is replaced (render process gone), so the host re-attaches it. */
    val webViewVersion: Int = 0,
)

/**
 * Owns the one long-lived Pages WebView for the selected account, its bridge,
 * and its navigation policy. Lives in [ConsolePagesRuntime] so leaving the
 * screen does not throw away the page (or the in-memory edits it holds).
 * Main thread only, like the WebView.
 *
 * The bridge is an androidx.webkit `WebMessageListener` restricted to the
 * console origin, and every post is checked again for main frame and origin.
 * The embed marker is a document-start script restricted to the same origin.
 */
class PagesWebController(
    private val context: Context,
    val environment: ConsoleEnvironment,
    /** The account selection this WebView and its data store belong to. */
    val account: ConsoleAccountContext,
    private val broker: ConsoleSessionBroker,
    /** The account's own androidx.webkit profile; never the default profile. */
    private val profileName: String,
    private val appVersion: String,
    val flush: PagesFlushCoordinator,
    private val isOnline: () -> Boolean,
    private val hooks: Hooks,
) : PagesDocument {
    class Hooks(
        val openExternally: (String) -> Unit,
        val appRoute: (NimbalystAppLink) -> Unit,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mainHandler = Handler(Looper.getMainLooper())
    private val _state = MutableStateFlow(PagesUiState())
    val state: StateFlow<PagesUiState> = _state.asStateFlow()
    val navigator = PagesNavigator(this)

    var webView: WebView = createWebView()
        private set

    override var currentRoute: ConsoleRoute? = null
        private set
    /** The page the console last reported. */
    var currentPath: String? = null
        private set
    /** The last console URL loaded or reached, for Retry and render-process recovery. */
    private var lastConsoleUrl: String? = null
    var bridgeReady = false
        private set
    override var isTornDown = false
        private set

    /**
     * The nonce the current main-frame console document announced at document
     * start. A session is delivered only into the document that asked for it.
     */
    private var documentNonce: String? = null
    private var terminationsWithoutReady = 0
    private var reauthAttemptsWithoutReady = 0
    private val flushWaiters = mutableMapOf<String, CompletableDeferred<ConsoleFlushResult?>>()

    override val unsynced: Boolean get() = _state.value.unsynced

    init {
        flush.bridge = this
    }

    // region Navigation

    /** Show [route] from a Team tab row, link or push. Replacing the page on screen goes through the leave guard. */
    suspend fun requestOpen(route: ConsoleRoute) {
        val phase = _state.value.phase
        if (route == currentRoute && (phase == PagesPhase.Ready || phase == PagesPhase.Loading)) return
        if (currentRoute == null || phase == PagesPhase.Idle) return open(route)
        navigator.requestLeave(PagesLeaveIntent.ReplaceRoute(route))
    }

    /** Native Back. Walks web history first. Returns true when the caller should leave the screen. */
    suspend fun requestBack(): Boolean =
        navigator.requestLeave(if (webView.canGoBack()) PagesLeaveIntent.WebBack else PagesLeaveIntent.LeaveScreen)

    override fun performApproved(intent: PagesLeaveIntent): Boolean {
        _state.update { it.copy(unsynced = false) }
        flush.editStateChanged(_state.value.editing, unsynced = false)
        return when (intent) {
            PagesLeaveIntent.WebBack -> { webView.goBack(); false }
            PagesLeaveIntent.LeaveScreen -> true
            is PagesLeaveIntent.ReplaceRoute -> { open(intent.route); false }
            is PagesLeaveIntent.LoadUrl -> { load(intent.url); false }
        }
    }

    /** Show [route]. Re-opening the page already shown keeps where the reader is. */
    fun open(route: ConsoleRoute) {
        val phase = _state.value.phase
        if (route == currentRoute && (phase == PagesPhase.Ready || phase == PagesPhase.Loading)) return
        currentRoute = route
        currentPath = null
        _state.update { it.copy(title = "") }
        val url = environment.url(route.path)
        if (url == null) {
            _state.update { it.copy(phase = PagesPhase.Failed(PagesFailure.InvalidAddress)) }
            return
        }
        load(url)
    }

    /**
     * Retry after a failure, keeping the last URL the console reached. A failure
     * (a session refresh that did not come back, say) can leave the document alive
     * with unsynced edits, so the reload goes through the leave guard.
     */
    suspend fun retry() {
        val url = retryUrl() ?: return
        navigator.requestLeave(PagesLeaveIntent.LoadUrl(url))
    }

    private fun retryUrl(): String? =
        lastConsoleUrl?.takeIf(environment::isConsoleOrigin) ?: currentRoute?.let { environment.url(it.path) }

    fun dismissSheet() = _state.update { it.copy(sheet = null) }

    fun dismissLostEditsNotice() = _state.update { it.copy(lostEditsNotice = false) }

    /** The app left the foreground: flush unsent edits. */
    suspend fun appDidStop(): PagesFlushOutcome = flush.appDidStop()

    /** Stop everything before the account's data store is removed or replaced. */
    fun tearDown() {
        if (isTornDown) return
        isTornDown = true
        scope.cancel()
        flushWaiters.values.forEach { it.complete(null) }
        flushWaiters.clear()
        flush.bridge = null
        bridgeReady = false
        destroy(webView)
        _state.update { it.copy(phase = PagesPhase.Idle) }
    }

    private fun load(url: String) {
        // Every native load passes the same policy as a navigation the page starts,
        // judged on the canonical path, so a rewritten link cannot reach `/app` or login.
        if (!ConsoleNavigationPolicy.allowsNativeLoad(url, environment)) {
            Log.w(TAG, "Refused a native load the navigation policy does not allow")
            _state.update { it.copy(phase = PagesPhase.Failed(PagesFailure.InvalidAddress)) }
            return
        }
        if (!isOnline()) {
            _state.update { it.copy(phase = PagesPhase.Failed(PagesFailure.Offline)) }
            return
        }
        bridgeReady = false
        documentNonce = null
        lastConsoleUrl = url
        val lostEdits = flush.consumeLostEditsNotice()
        _state.update { it.copy(phase = PagesPhase.Loading, lostEditsNotice = it.lostEditsNotice || lostEdits) }
        webView.loadUrl(url)
    }

    // endregion

    // region Bridge

    private fun receive(body: String?, sourceOrigin: String?, isMainFrame: Boolean) {
        if (isTornDown) return
        val message = ConsoleBridgeMessage.accept(body, sourceOrigin, isMainFrame, environment)
        if (message == null) {
            Log.w(TAG, "Dropped a console bridge message (subframe, other origin, or malformed)")
            return
        }
        handle(message)
    }

    private fun handle(message: ConsoleBridgeMessage) {
        when (message) {
            is ConsoleBridgeMessage.Ready -> {
                bridgeReady = true
                terminationsWithoutReady = 0
                reauthAttemptsWithoutReady = 0
                _state.update { if (it.phase == PagesPhase.Loading) it.copy(phase = PagesPhase.Ready) else it }
            }
            is ConsoleBridgeMessage.Route -> {
                currentPath = message.path
                environment.url(message.path)?.let { lastConsoleUrl = it }
                _state.update { it.copy(title = displayTitle(message.title), canGoBack = webView.canGoBack()) }
            }
            is ConsoleBridgeMessage.EditState -> {
                _state.update { it.copy(editing = message.editing, unsynced = message.unsynced) }
                flush.editStateChanged(message.editing, message.unsynced)
            }
            is ConsoleBridgeMessage.DocumentStart -> documentNonce = message.nonce
            is ConsoleBridgeMessage.RequestSession -> {
                // Bridge messages arrive in order, so the nonce now is the asking document's.
                val nonce = documentNonce
                scope.launch { answerSession(message.requestId, message.orgId, nonce) }
            }
            is ConsoleBridgeMessage.SessionExpired -> {
                val nonce = documentNonce
                scope.launch { answerSession(message.requestId, message.orgId, nonce) }
            }
            is ConsoleBridgeMessage.OrgAuthRequired ->
                _state.update { it.copy(sheet = PagesSheet.OrgAuthRequired(message.orgId, message.reason)) }
            is ConsoleBridgeMessage.OpenExternal -> {
                val scheme = runCatching { URI(message.url).scheme?.lowercase() }.getOrNull()
                if (scheme in setOf("http", "https", "mailto")) hooks.openExternally(message.url)
            }
            is ConsoleBridgeMessage.OpenPersonal -> _state.update { it.copy(sheet = PagesSheet.PersonalPages) }
            is ConsoleBridgeMessage.FlushResult -> {
                Log.i(TAG, "Console flushResult: ${message.result.status.raw}")
                flushWaiters.remove(message.requestId)?.complete(message.result)
            }
        }
    }

    /** The org of the page on screen, for a `sessionExpired` that names none. */
    private val currentOrgId: String?
        get() = currentPath?.let { ConsoleRoute.parse(it)?.orgId } ?: currentRoute?.orgId

    private suspend fun answerSession(requestId: String, orgId: String?, nonce: String?) {
        val delivery = broker.answer(requestId, orgId, currentOrgId, account) ?: return
        if (isTornDown) return
        val outcome = delivery.outcome
        if (outcome is ConsoleMintOutcome.Refused) {
            if (outcome.error == ConsoleSessionDeliveryError.ORG_AUTH_REQUIRED) {
                _state.update { it.copy(sheet = PagesSheet.OrgAuthRequired(outcome.orgId ?: orgId.orEmpty(), outcome.reason)) }
            } else {
                _state.update { it.copy(phase = PagesPhase.Failed(PagesFailure.Session(sessionFailure(outcome.error, outcome.reason)))) }
            }
        }
        deliver(delivery, nonce)
    }

    private suspend fun deliver(delivery: ConsoleSessionDelivery, nonce: String?) {
        // Tokens only ever go to this selection's WebView...
        if (isTornDown || delivery.account != account || !broker.isCurrent(account)) {
            Log.w(TAG, "Not delivering a console session minted for another account selection")
            return
        }
        // ...and only to the console origin's main frame...
        if (!environment.isConsoleOrigin(webView.url)) {
            Log.w(TAG, "Not delivering a console session: the page left the console origin")
            return
        }
        // ...and only into the document that asked (checked again in-page).
        if (nonce == null) {
            Log.w(TAG, "Not delivering a console session: the asking document never announced itself")
            return
        }
        when (ConsoleScripts.decodeResult(evaluate(ConsoleScripts.deliverSession(delivery.payload, environment, nonce)))) {
            true -> Unit
            "wrong-document" -> Log.w(TAG, "Not delivering a console session: the document changed before delivery")
            else -> Log.w(TAG, "Console ignored a session delivery (stale request or no bridge)")
        }
    }

    override suspend fun flushPending(timeoutMs: Int): ConsoleFlushResult? {
        if (isTornDown || !bridgeReady || !environment.isConsoleOrigin(webView.url)) return null
        val requestId = UUID.randomUUID().toString()
        val waiter = CompletableDeferred<ConsoleFlushResult?>()
        flushWaiters[requestId] = waiter
        try {
            when (ConsoleScripts.decodeResult(evaluate(ConsoleScripts.flushPending(timeoutMs, requestId, environment)))) {
                "started" -> Unit
                null -> return null
                else -> return ConsoleFlushResult(ConsoleFlushResult.Status.FAILED, "wrong-document")
            }
            // evaluateJavascript cannot await a promise; the answer comes back as `flushResult`.
            return withTimeoutOrNull(timeoutMs + 2_000L) { waiter.await() }
                ?: ConsoleFlushResult(ConsoleFlushResult.Status.FAILED, "no-flush-result")
        } finally {
            flushWaiters.remove(requestId)
        }
    }

    /**
     * The reader confirmed "Leave without saving": drop the console's unacknowledged
     * edits (including pages already navigated away from) so `editState.unsynced` and
     * `flushPending` stop counting them. Returns the number discarded, or null with no bridge.
     */
    override suspend fun discardUnsynced(): Int? {
        if (isTornDown || !bridgeReady || !environment.isConsoleOrigin(webView.url)) return null
        val count = (ConsoleScripts.decodeResult(evaluate(ConsoleScripts.discardUnsynced(environment))) as? Double)?.toInt()
        Log.i(TAG, "Discarded unsynced console edits: ${count ?: "no bridge"}")
        return count
    }

    private suspend fun evaluate(script: String): String? = withTimeoutOrNull(EVALUATE_TIMEOUT_MS) {
        suspendCancellableCoroutine { continuation ->
            webView.evaluateJavascript(script) { result -> if (continuation.isActive) continuation.resume(result) }
        }
    }

    // endregion

    // region Policy

    private fun perform(action: ConsoleNavigationAction) {
        if (isTornDown) return
        when (action) {
            ConsoleNavigationAction.Allow, ConsoleNavigationAction.Cancel -> Unit
            is ConsoleNavigationAction.Load -> scope.launch { navigator.requestLeave(PagesLeaveIntent.LoadUrl(action.url)) }
            ConsoleNavigationAction.PersonalPages -> _state.update { it.copy(sheet = PagesSheet.PersonalPages) }
            ConsoleNavigationAction.DesktopOnly -> _state.update { it.copy(sheet = PagesSheet.DesktopOnly) }
            ConsoleNavigationAction.Reauthenticate -> reauthenticate()
            is ConsoleNavigationAction.AppRoute -> hooks.appRoute(action.link)
            is ConsoleNavigationAction.OpenExternally -> hooks.openExternally(action.url)
        }
    }

    /**
     * The console tried to show its login page. The embed signs in through
     * `/authenticate/native`, which asks native for a minted session.
     */
    private fun reauthenticate() {
        reauthAttemptsWithoutReady += 1
        val orgId = currentOrgId
        if (reauthAttemptsWithoutReady > 2 || orgId == null) {
            _state.update { it.copy(phase = PagesPhase.Failed(PagesFailure.Session(PagesSessionFailure.GENERIC))) }
            return
        }
        val returnTo = currentPath ?: currentRoute?.path ?: "/"
        val url = environment.url("/authenticate/native?orgId=${encodeQuery(orgId)}&returnTo=${encodeQuery(returnTo)}") ?: return
        scope.launch { navigator.requestLeave(PagesLeaveIntent.LoadUrl(url)) }
    }

    /** A fragment-only change of the current document. */
    private fun isSameDocument(url: String): Boolean {
        val current = webView.url?.let { runCatching { URI(it) }.getOrNull() } ?: return false
        val next = runCatching { URI(url) }.getOrNull() ?: return false
        if (next.rawFragment == null) return false
        return current.withoutFragment() == next.withoutFragment()
    }

    private fun URI.withoutFragment(): String = toString().substringBefore('#')

    // endregion

    // region WebView

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun createWebView(): WebView {
        val view = WebView(context)
        // Before anything else touches the WebView, or it binds to the default profile.
        WebViewCompat.setProfile(view, profileName)
        view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.setBackgroundColor(android.graphics.Color.rgb(0x1A, 0x1A, 0x1A))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            // `_blank` links then navigate this WebView and pass through the policy.
            setSupportMultipleWindows(false)
        }
        val origins = setOf(environment.originString)
        WebViewCompat.addDocumentStartJavaScript(view, ConsoleScripts.embedMarker(environment, appVersion), origins)
        WebViewCompat.addWebMessageListener(view, CONSOLE_BRIDGE_NAME, origins) { _, message, sourceOrigin, isMainFrame, _ ->
            receive(message.data, sourceOrigin.toString(), isMainFrame)
        }
        view.webChromeClient = WebChromeClient()
        view.webViewClient = Client()
        return view
    }

    private fun destroy(view: WebView) {
        runCatching { WebViewCompat.removeWebMessageListener(view, CONSOLE_BRIDGE_NAME) }
        view.stopLoading()
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (isTornDown || view !== webView) return true
            val url = request.url?.toString() ?: return true
            val action = ConsoleNavigationPolicy.decide(url, request.isForMainFrame, opensNewWindow = false, environment = environment)
            // A full-document navigation the page started while edits are unsynced would
            // drop the console's retained edit handles: hold it for the leave guard instead.
            if (action == ConsoleNavigationAction.Allow && _state.value.unsynced && request.isForMainFrame && !isSameDocument(url)) {
                scope.launch { navigator.requestLeave(PagesLeaveIntent.LoadUrl(url)) }
                return true
            }
            if (action == ConsoleNavigationAction.Allow) return false
            // After the decision, so a replacement load never races the cancelled one.
            if (action != ConsoleNavigationAction.Cancel) mainHandler.post { perform(action) }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (view === webView && environment.isConsoleOrigin(url)) lastConsoleUrl = url
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            if (view !== webView) return
            if (environment.isConsoleOrigin(url)) lastConsoleUrl = url
            _state.update { it.copy(canGoBack = view.canGoBack()) }
        }

        override fun onPageFinished(view: WebView, url: String?) {
            // An older console that never posts `ready` must not leave a spinner over the page.
            if (view === webView) _state.update { if (it.phase == PagesPhase.Loading) it.copy(phase = PagesPhase.Ready) else it }
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (view !== webView || !request.isForMainFrame || errorResponse.statusCode < 500) return
            _state.update { it.copy(phase = PagesPhase.Failed(PagesFailure.Server(errorResponse.statusCode))) }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (view !== webView || !request.isForMainFrame) return
            Log.e(TAG, "Console load failed: ${error.errorCode}")
            val failure = if (!isOnline() || error.errorCode == ERROR_HOST_LOOKUP) PagesFailure.Offline else PagesFailure.Load(error.description?.toString())
            _state.update { it.copy(phase = PagesPhase.Failed(failure)) }
        }

        /**
         * Android may kill the render process at any time. The WebView is unusable
         * afterwards, so replace it and reload, and say so if unsynced edits went with it.
         */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view !== webView || isTornDown) return true
            terminationsWithoutReady += 1
            bridgeReady = false
            documentNonce = null
            flush.contentProcessTerminated()
            Log.w(TAG, "Console render process gone ($terminationsWithoutReady, crashed=${detail.didCrash()})")
            mainHandler.post {
                if (isTornDown) return@post
                destroy(view)
                webView = createWebView()
                _state.update { it.copy(editing = false, unsynced = false, webViewVersion = it.webViewVersion + 1) }
                if (terminationsWithoutReady <= 2) {
                    // The old document is gone with its process, so there is nothing to guard.
                    retryUrl()?.let(::load)
                } else {
                    _state.update { it.copy(phase = PagesPhase.Failed(PagesFailure.Stopped)) }
                }
            }
            return true
        }
    }

    // endregion

    companion object {
        private const val TAG = "ConsolePages"
        private const val EVALUATE_TIMEOUT_MS = 5_000L

        fun displayTitle(raw: String): String {
            val trimmed = raw.trim()
            for (suffix in listOf(" · Nimbalyst", " - Nimbalyst", " | Nimbalyst")) {
                if (trimmed.endsWith(suffix)) return trimmed.removeSuffix(suffix)
            }
            return trimmed
        }

        fun sessionFailure(code: ConsoleSessionDeliveryError, reason: String?): PagesSessionFailure = when (code) {
            ConsoleSessionDeliveryError.NOT_A_MEMBER -> PagesSessionFailure.NOT_A_MEMBER
            ConsoleSessionDeliveryError.UNAVAILABLE -> PagesSessionFailure.UNAVAILABLE
            ConsoleSessionDeliveryError.ORG_AUTH_REQUIRED -> PagesSessionFailure.ORG_AUTH_REQUIRED
            ConsoleSessionDeliveryError.FAILED -> when (reason) {
                "network", "timeout" -> PagesSessionFailure.NETWORK
                "personal_session_unavailable", "unauthorized", "signed_out" -> PagesSessionFailure.SIGN_IN_REFRESH
                else -> PagesSessionFailure.GENERIC
            }
        }

        private fun encodeQuery(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8.name())
    }
}
