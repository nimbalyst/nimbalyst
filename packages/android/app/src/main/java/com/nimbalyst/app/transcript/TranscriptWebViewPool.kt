package com.nimbalyst.app.transcript

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
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
 * to the main thread before invoking [handler].
 */
class TranscriptBridgeRelay {
    @Volatile
    var handler: ((TranscriptBridgeMessage) -> Unit)? = null

    @JavascriptInterface
    fun postMessage(payload: String) {
        val message = TranscriptBridge.parse(payload) ?: return
        Handler(Looper.getMainLooper()).post {
            handler?.invoke(message)
        }
    }
}

/**
 * Pre-warms WebView instances for instant session switching.
 * Matches iOS TranscriptWebViewPool behavior.
 */
object TranscriptWebViewPool {
    private const val POOL_SIZE = 2
    private const val TRANSCRIPT_ASSET_URL = "file:///android_asset/transcript-dist/transcript.html"
    private val pool = LinkedList<WebView>()

    // Maps each WebView to its relay. WeakHashMap so destroyed WebViews are
    // collected automatically; all access is guarded by relayLock.
    private val relayMap = WeakHashMap<WebView, TranscriptBridgeRelay>()
    private val relayLock = Any()

    @SuppressLint("SetJavaScriptEnabled")
    fun warmup(context: Context) {
        val appContext = context.applicationContext
        synchronized(pool) {
            while (pool.size < POOL_SIZE) {
                val webView = createBaseWebView(appContext)
                webView.loadUrl(TRANSCRIPT_ASSET_URL)
                pool.add(webView)
            }
        }
    }

    /**
     * Take a pre-warmed WebView from the pool, or create a new one if empty.
     */
    fun take(context: Context): WebView {
        val appContext = context.applicationContext
        synchronized(pool) {
            val webView = pool.poll()
            if (webView != null) {
                // Replenish pool in the background
                return webView
            }
        }
        // Pool empty, create on demand
        return createBaseWebView(appContext).also {
            it.loadUrl(TRANSCRIPT_ASSET_URL)
        }
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
     * Composable closure cannot outlive its scope, then resets JS session state.
     */
    fun recycle(webView: WebView) {
        // Clear the handler so the previous Composable's closure is released.
        // removeJavascriptInterface is intentionally NOT called here — Android docs
        // note it has no effect after a page has loaded, and the relay must remain
        // registered for the next session that takes this WebView from the pool.
        getRelay(webView)?.handler = null
        webView.evaluateJavascript("window.nimbalyst?.clearSession?.();", null)
        synchronized(pool) {
            if (pool.size < POOL_SIZE) {
                pool.add(webView)
            } else {
                webView.destroy()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createBaseWebView(context: Context): WebView {
        val relay = TranscriptBridgeRelay()
        return WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    return request.url?.scheme != "file"
                }
            }
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = false
            settings.loadsImagesAutomatically = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            // Register the relay BEFORE any loadUrl call so window.AndroidBridge
            // is defined when JS first executes.
            addJavascriptInterface(relay, "AndroidBridge")
            synchronized(relayLock) {
                relayMap[this] = relay
            }
        }
    }
}
