package com.nimbalyst.app.transcript

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.VisibleForTesting
import java.util.LinkedList
import java.util.WeakHashMap

/**
 * Relay registered as the "AndroidBridge" Javascript interface on every pooled
 * WebView. Because [addJavascriptInterface] must be called before [WebView.loadUrl]
 * to guarantee the binding is visible when JS first executes, the relay is created
 * and registered inside [createBaseWebView] — before any load call.
 *
 * The Composable that owns the WebView wires [handler] after it takes the view from
 * the pool, and clears it in [DisposableEffect.onDispose] so the Composable's closure
 * cannot outlive its scope.
 *
 * [postMessage] is called on the WebView's JS thread; it marshals decoded messages
 * to the main thread before invoking [handler]. The handler is captured when the
 * message is queued and must still be attached when it runs, so a message posted
 * while one screen owned the view never reaches the next screen's callbacks.
 */
class TranscriptBridgeRelay {
    @Volatile
    var handler: ((TranscriptBridgeMessage) -> Unit)? = null

    @JavascriptInterface
    fun postMessage(payload: String) {
        val message = TranscriptBridge.parse(payload) ?: return
        val target = handler ?: return
        Handler(Looper.getMainLooper()).post {
            if (handler === target) target(message)
        }
    }
}

/**
 * The single [WebViewClient] on every pooled WebView. The Composable that owns
 * the view sets [host]; while the view sits idle in the pool [host] is null and
 * a renderer death just drops the view from the pool.
 *
 * Returning true from [onRenderProcessGone] is what keeps Android from killing
 * the whole app when the renderer crashes or is reclaimed for memory. All
 * WebViews in the app share one renderer, so every pooled view gets this
 * callback at once, not only the visible one.
 */
class TranscriptWebViewClient : WebViewClient() {
    interface Host {
        fun onPageFinished(view: WebView)
        fun onRenderProcessGone(view: WebView, didCrash: Boolean)
    }

    @Volatile
    var host: Host? = null

    /** Set once the renderer is gone; the view can never render again and must be destroyed. */
    @Volatile
    var rendererGone: Boolean = false
        private set

    /** Set by [TranscriptWebViewPool.discard]; a dead view can be discarded from two paths. */
    @Volatile
    internal var destroyed: Boolean = false

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url?.toString()
        return when (TranscriptExternalLinks.classify(url)) {
            TranscriptLinkAction.ALLOW_IN_WEBVIEW -> false
            TranscriptLinkAction.BLOCK -> true
            TranscriptLinkAction.OPEN_CUSTOM_TAB, TranscriptLinkAction.OPEN_VIEW_INTENT -> {
                if (url != null) TranscriptExternalLinks.open(view.context, url)
                true
            }
        }
    }

    override fun onPageFinished(view: WebView, url: String?) {
        host?.onPageFinished(view)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        rendererGone = true
        Log.w(TAG, "Transcript renderer gone (didCrash=${detail.didCrash()}, hosted=${host != null})")
        val currentHost = host
        if (currentHost != null) {
            currentHost.onRenderProcessGone(view, detail.didCrash())
        } else {
            TranscriptWebViewPool.discard(view)
        }
        return true
    }

    private companion object {
        const val TAG = "TranscriptWebView"
    }
}

/**
 * Pre-warms WebView instances for instant session switching.
 *
 * Views are handed out most-recently-used first and are NOT cleared on
 * release, so the view that just showed session A comes back with A still in
 * the bundle's 3-session cache (scroll and expansion state intact) when the
 * user goes A -> list -> B -> A. The bundle bounds its own cache; the pool
 * bounds itself to [POOL_SIZE] idle views. Previous-account content is dropped
 * only by [resetForAccountChange].
 */
object TranscriptWebViewPool {
    private const val TAG = "TranscriptWebViewPool"
    private const val POOL_SIZE = 2
    private const val TRANSCRIPT_ASSET_URL = "file:///android_asset/transcript-dist/transcript.html"
    private val pool = LinkedList<WebView>()

    // Maps each WebView to its relay and client. WeakHashMap so destroyed
    // WebViews are collected automatically; all access is guarded by relayLock.
    private val relayMap = WeakHashMap<WebView, TranscriptBridgeRelay>()
    private val clientMap = WeakHashMap<WebView, TranscriptWebViewClient>()
    private val relayLock = Any()

    // Bumped by resetForAccountChange. A view created under an older account
    // epoch holds that account's decrypted transcripts and is never reused.
    private var accountEpoch = 0
    private val epochMap = WeakHashMap<WebView, Int>()

    /**
     * Destroy every pooled WebView and retire any in use, so no decrypted
     * transcript from the previous account survives in a bundle's session
     * cache. Call on unpair, account deletion, or sign-out. In-use views are
     * destroyed when their screen releases them.
     */
    fun resetForAccountChange(context: Context, rewarm: Boolean = true) {
        val retired = synchronized(pool) {
            accountEpoch++
            pool.toList().also { pool.clear() }
        }
        retired.forEach(::discard)
        if (rewarm) warmup(context)
    }

    /**
     * Constructs the platform WebView. Throws when the WebView provider is
     * missing, disabled, or mid-update; replaceable so tests can simulate that.
     */
    @VisibleForTesting
    internal var newWebView: (Context) -> WebView = { WebView(it) }

    /** Fills the pool. Never throws: a missing WebView provider leaves it short and [take] reports null. */
    fun warmup(context: Context) {
        val appContext = context.applicationContext
        synchronized(pool) {
            while (pool.size < POOL_SIZE) {
                val webView = create(appContext) ?: return
                pool.add(webView)
            }
        }
    }

    /**
     * Take a pre-warmed WebView from the pool, or create a new one if empty.
     * Views whose renderer already died are destroyed rather than handed out.
     * Null when the WebView provider is unavailable.
     */
    fun take(context: Context): WebView? {
        synchronized(pool) {
            while (true) {
                val webView = pool.pollFirst() ?: break
                if (getClient(webView)?.rendererGone == true) {
                    webView.destroy()
                    continue
                }
                return webView
            }
        }
        return create(context)
    }

    /**
     * A fresh WebView loading the transcript, bypassing the pool. Used to
     * recover after a renderer death, when pooled views may be dead too.
     * Null when the WebView provider is unavailable.
     */
    fun create(context: Context): WebView? {
        return try {
            createBaseWebView(context.applicationContext).also {
                it.loadUrl(TRANSCRIPT_ASSET_URL)
            }
        } catch (error: Exception) {
            // MissingWebViewPackageException and friends are RuntimeExceptions.
            Log.e(TAG, "Could not create a transcript WebView", error)
            null
        }
    }

    /** Reload the transcript page in place (Retry after a load/ready timeout). */
    fun reload(webView: WebView) {
        webView.loadUrl(TRANSCRIPT_ASSET_URL)
    }

    fun getClient(webView: WebView): TranscriptWebViewClient? {
        return synchronized(relayLock) {
            clientMap[webView]
        }
    }

    /** Drop [webView] for good: out of the pool, off its parent, destroyed. */
    fun discard(webView: WebView) {
        synchronized(pool) {
            pool.remove(webView)
        }
        val client = getClient(webView)
        if (client?.destroyed == true) return
        client?.destroyed = true
        getRelay(webView)?.handler = null
        client?.host = null
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    /**
     * Retrieve the [TranscriptBridgeRelay] registered on [webView].
     * Returns null only if [webView] was not created by this pool.
     */
    fun getRelay(webView: WebView): TranscriptBridgeRelay? {
        return synchronized(relayLock) {
            relayMap[webView]
        }
    }

    /**
     * Return a WebView to the pool for reuse. Clears the relay handler so the
     * Composable closure cannot outlive its scope. The bundle's session cache
     * is kept; the next host hides the view until its own session is confirmed.
     */
    fun recycle(webView: WebView) {
        // Clear the handler so the previous Composable's closure is released.
        // removeJavascriptInterface is intentionally NOT called here — Android docs
        // note it has no effect after a page has loaded, and the relay must remain
        // registered for the next session that takes this WebView from the pool.
        getRelay(webView)?.handler = null
        val client = getClient(webView)
        client?.host = null
        if (client?.rendererGone == true || synchronized(pool) { epochMap[webView] != accountEpoch }) {
            discard(webView)
            return
        }
        val evicted = synchronized(pool) {
            pool.remove(webView)
            pool.addFirst(webView)
            if (pool.size > POOL_SIZE) pool.removeLast() else null
        }
        evicted?.let(::discard)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createBaseWebView(context: Context): WebView {
        val relay = TranscriptBridgeRelay()
        val client = TranscriptWebViewClient()
        return newWebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            webChromeClient = WebChromeClient()
            webViewClient = client
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // file:///android_asset/ loads regardless of this setting; turning
            // it off keeps a transcript link or image from reaching app files
            // or shared storage with AndroidBridge attached.
            settings.allowFileAccess = false
            settings.allowFileAccessFromFileURLs = false
            settings.allowUniversalAccessFromFileURLs = false
            settings.allowContentAccess = false
            settings.loadsImagesAutomatically = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            // Register the relay BEFORE any loadUrl call so window.AndroidBridge
            // is defined when JS first executes.
            addJavascriptInterface(relay, "AndroidBridge")
            synchronized(relayLock) {
                relayMap[this] = relay
                clientMap[this] = client
            }
            synchronized(pool) {
                epochMap[this] = accountEpoch
            }
        }
    }
}
