package com.nimbalyst.app.documents

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.google.gson.Gson
import com.nimbalyst.app.R
import com.nimbalyst.app.transcript.TranscriptExternalLinks
import java.net.URI

/** Messages the editor bundle posts through `window.AndroidEditorBridge.postMessage(json)`. */
sealed interface EditorBridgeMessage {
    data object EditorReady : EditorBridgeMessage
    /** A save the bundle started; answer it with [EditorCommands.saveResult] for [revision]. */
    data class ContentChanged(val content: String, val revision: Long) : EditorBridgeMessage
    data class Dirty(val isDirty: Boolean) : EditorBridgeMessage
    data class Error(val message: String) : EditorBridgeMessage
    /** A link tapped in the document; native decides where it goes ([DocumentEditorLinks.classifyHref]). */
    data class LinkClicked(val href: String, val title: String?) : EditorBridgeMessage

    companion object {
        private const val BENIGN_RESIZE_OBSERVER = "ResizeObserver loop completed with undelivered notifications."

        fun parse(payload: String): EditorBridgeMessage? {
            val json = runCatching { parseObject(payload) }.getOrNull() ?: return null
            return when (json.optString("type")) {
                "editorReady" -> EditorReady
                "contentChanged" -> {
                    val revision = json.get("revision")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asLong
                    val content = json.optString("content")
                    if (content != null && revision != null) ContentChanged(content, revision) else null
                }
                "dirty" -> runCatching { Dirty(json.requireBoolean("isDirty")) }.getOrNull()
                "error" -> {
                    val message = json.optString("message") ?: "Unknown editor error"
                    if (BENIGN_RESIZE_OBSERVER in message) null else Error(message)
                }
                "linkClicked" -> json.optString("href")?.takeIf { it.isNotEmpty() }?.let { LinkClicked(it, json.optString("title")) }
                else -> null
            }
        }
    }
}

enum class EditorLinkAction { ALLOW_IN_WEBVIEW, OPEN_EXTERNALLY, BLOCK }

/** Navigation policy: the WebView may only show the bundled editor; web and mail links leave the app. */
object DocumentEditorLinks {
    const val EDITOR_ASSET_DIR = "/android_asset/editor-dist/"
    const val EDITOR_URL = "file:///android_asset/editor-dist/editor.html"

    fun classify(url: String?): EditorLinkAction {
        val scheme = url?.substringBefore(':', missingDelimiterValue = "")?.lowercase()
        return when (scheme) {
            "file" -> if (isBundledEditorUrl(url)) EditorLinkAction.ALLOW_IN_WEBVIEW else EditorLinkAction.BLOCK
            "http", "https", "mailto" -> EditorLinkAction.OPEN_EXTERNALLY
            else -> EditorLinkAction.BLOCK
        }
    }

    /** Same rules as the transcript: no host, no percent-encoding, no backslashes, no dot segments. */
    private fun isBundledEditorUrl(url: String): Boolean {
        val uri = runCatching { URI(url) }.getOrNull() ?: return false
        if (!uri.rawAuthority.isNullOrEmpty()) return false
        val rawPath = uri.rawPath ?: return false
        if ('%' in rawPath || '\\' in rawPath) return false
        if (!rawPath.startsWith(EDITOR_ASSET_DIR)) return false
        return rawPath.removePrefix(EDITOR_ASSET_DIR).split('/').none { it == "." || it == ".." }
    }
}

/** JavaScript for the `window.nimbalystEditor` bridge. Strings are JSON-encoded, never spliced. */
object EditorCommands {
    private val gson = Gson()

    fun loadMarkdown(markdown: String) = "window.nimbalystEditor && window.nimbalystEditor.loadMarkdown(${gson.toJson(markdown)})"
    /**
     * A remote save: loaded outright when clean. With unsaved edits it is
     * deferred: its frontmatter is taken now, its body only if the edits are undone.
     */
    fun remoteUpdate(markdown: String, dirty: Boolean) = if (dirty) deferRemote(markdown) else loadMarkdown(markdown)
    fun deferRemote(markdown: String) = "window.nimbalystEditor && window.nimbalystEditor.deferRemote(${gson.toJson(markdown)})"
    /** The answer for the bundle's save [revision]: ok when sent or queued in the outbox. */
    fun saveResult(revision: Long, ok: Boolean) = "window.nimbalystEditor && window.nimbalystEditor.saveResult($revision, $ok)"
    /** Save now (Save button, app going to background); arrives as a ContentChanged. */
    const val FLUSH = "window.nimbalystEditor && window.nimbalystEditor.flush()"
    /** The background flush for an editor: always for an editable one, never for a read-only one. */
    fun flushFor(canWrite: Boolean): String? = if (canWrite) FLUSH else null
    /** The unsaved file, or null when clean; for an editor about to be destroyed. */
    const val FINAL_CONTENT = "window.nimbalystEditor ? window.nimbalystEditor.finalContent() : null"
    fun setReadOnly(readOnly: Boolean) = "window.nimbalystEditor && window.nimbalystEditor.setReadOnly($readOnly)"
    fun formatText(format: EditorFormat) = "window.nimbalystEditor && window.nimbalystEditor.formatText(${gson.toJson(format.command)})"

    /** `evaluateJavascript` hands back the result JSON-encoded; null when the editor is not mounted. */
    fun decodeContent(result: String?): String? =
        result?.takeIf { it != "null" }?.let { runCatching { gson.fromJson(it, String::class.java) }.getOrNull() }
}

enum class EditorFormat(val command: String) {
    BOLD("bold"),
    ITALIC("italic"),
    CODE("code"),
    STRIKETHROUGH("strikethrough"),
}

/** The `@JavascriptInterface` object; decodes off the JS thread and delivers on the main thread. */
class EditorBridgeRelay {
    @Volatile
    var handler: ((EditorBridgeMessage) -> Unit)? = null
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun postMessage(payload: String) {
        val message = EditorBridgeMessage.parse(payload) ?: return
        main.post { handler?.invoke(message) }
    }
}

/**
 * A WebView locked to the bundled editor, with the transcript's restrictions:
 * no file or content access beyond the APK assets, no navigation off
 * `editor-dist/`, external links in a Custom Tab. [onFailure] reports a load
 * error or a renderer death (returning true keeps the app alive). Returns null,
 * after reporting through [onFailure], when the WebView provider is missing,
 * disabled, or mid-update.
 */
internal fun createDocumentEditorWebView(
    context: Context,
    relay: EditorBridgeRelay,
    newWebView: (Context) -> WebView = { WebView(it) },
    onFailure: (String) -> Unit,
): WebView? {
    val webView = try {
        newWebView(context)
    } catch (error: Exception) {
        Log.e("DocumentEditorWebView", "Could not create the editor WebView", error)
        onFailure(context.getString(R.string.webview_unavailable))
        return null
    }
    return webView.configureForEditor(relay, onFailure)
}

@SuppressLint("SetJavaScriptEnabled")
private fun WebView.configureForEditor(
    relay: EditorBridgeRelay,
    onFailure: (String) -> Unit,
): WebView = apply {
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    setBackgroundColor(android.graphics.Color.rgb(0x1A, 0x1A, 0x1A))
    webChromeClient = WebChromeClient()
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url?.toString()
            return when (DocumentEditorLinks.classify(url)) {
                EditorLinkAction.ALLOW_IN_WEBVIEW -> false
                EditorLinkAction.BLOCK -> true
                EditorLinkAction.OPEN_EXTERNALLY -> {
                    if (url != null) TranscriptExternalLinks.open(view.context, url)
                    true
                }
            }
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) onFailure("Failed to load editor: ${error.description}")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onFailure("The editor stopped unexpectedly. Close and reopen the file.")
            return true
        }
    }
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.allowFileAccess = false
    settings.allowFileAccessFromFileURLs = false
    settings.allowUniversalAccessFromFileURLs = false
    settings.allowContentAccess = false
    settings.cacheMode = WebSettings.LOAD_DEFAULT
    // Registered before loadUrl so the bridge exists when the bundle first runs.
    addJavascriptInterface(relay, "AndroidEditorBridge")
    loadUrl(DocumentEditorLinks.EDITOR_URL)
}
