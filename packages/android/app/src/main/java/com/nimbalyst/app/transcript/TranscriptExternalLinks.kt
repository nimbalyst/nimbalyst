package com.nimbalyst.app.transcript

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.widget.Toast
import androidx.browser.customtabs.CustomTabsIntent
import com.nimbalyst.app.R

/** What to do with a navigation or `open_url` request from the transcript. */
enum class TranscriptLinkAction {
    /** The transcript page itself and its bundled assets. */
    ALLOW_IN_WEBVIEW,
    /** http(s): open in a Custom Tab. */
    OPEN_CUSTOM_TAB,
    /** mailto: hand to whatever app handles it. */
    OPEN_VIEW_INTENT,
    /** Anything else would navigate the WebView off transcript.html. */
    BLOCK,
}

object TranscriptExternalLinks {
    private const val TAG = "TranscriptLinks"

    /** The only directory the WebView may display. AndroidBridge is attached to any page it loads. */
    const val TRANSCRIPT_ASSET_DIR = "/android_asset/transcript-dist/"

    fun classify(url: String?): TranscriptLinkAction {
        val scheme = url?.substringBefore(':', missingDelimiterValue = "")?.lowercase()
        return when (scheme) {
            "file" -> if (isBundledTranscriptUrl(url)) TranscriptLinkAction.ALLOW_IN_WEBVIEW else TranscriptLinkAction.BLOCK
            "http", "https" -> TranscriptLinkAction.OPEN_CUSTOM_TAB
            "mailto" -> TranscriptLinkAction.OPEN_VIEW_INTENT
            else -> TranscriptLinkAction.BLOCK
        }
    }

    /**
     * True only for `file:///android_asset/transcript-dist/...` with no host,
     * no percent-encoding, no backslashes, and no dot segments. Bundle asset
     * names never need any of those, so rejecting them outright is simpler and
     * safer than decoding and re-normalizing the way the WebView would.
     */
    private fun isBundledTranscriptUrl(url: String): Boolean {
        val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return false
        if (!uri.scheme.equals("file", ignoreCase = true)) return false
        if (!uri.rawAuthority.isNullOrEmpty()) return false
        val rawPath = uri.rawPath ?: return false
        if ('%' in rawPath || '\\' in rawPath) return false
        if (!rawPath.startsWith(TRANSCRIPT_ASSET_DIR)) return false
        val segments = rawPath.removePrefix(TRANSCRIPT_ASSET_DIR).split('/')
        return segments.none { it == "." || it == ".." }
    }

    /** Open [url] outside the WebView. Returns false when it was blocked or nothing could open it. */
    fun open(context: Context, url: String): Boolean {
        val action = classify(url)
        val uri = Uri.parse(url)
        return try {
            when (action) {
                TranscriptLinkAction.OPEN_CUSTOM_TAB -> {
                    val intent = CustomTabsIntent.Builder().setShowTitle(true).build()
                    intent.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    intent.launchUrl(context, uri)
                    true
                }
                TranscriptLinkAction.OPEN_VIEW_INTENT -> {
                    context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    true
                }
                TranscriptLinkAction.ALLOW_IN_WEBVIEW, TranscriptLinkAction.BLOCK -> {
                    Log.i(TAG, "Blocked transcript navigation to $url")
                    false
                }
            }
        } catch (error: ActivityNotFoundException) {
            // Custom Tabs falls back to a browser on its own; this only fires
            // when no app can open the link at all.
            Log.w(TAG, "No app can open $url", error)
            Toast.makeText(context, R.string.link_no_app, Toast.LENGTH_SHORT).show()
            false
        }
    }
}
