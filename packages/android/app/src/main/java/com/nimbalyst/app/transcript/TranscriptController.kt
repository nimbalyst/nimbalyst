package com.nimbalyst.app.transcript

import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Imperative handle on the transcript for the session detail screen: Scroll to
 * Top and Jump to Prompt. Pass it to [TranscriptWebView]; calls made before the
 * transcript has loaded a session are no-ops (and [getPromptList] returns empty).
 */
class TranscriptController {
    @Volatile
    internal var webView: WebView? = null

    @Volatile
    internal var isReady: Boolean = false

    fun scrollToTop() {
        target()?.evaluateJavascript("window.nimbalyst?.scrollToTop?.();", null)
    }

    /** Scroll to the UI row [index], as returned in [TranscriptPrompt.index]. */
    fun scrollToMessage(index: Int) {
        val arg = TranscriptPayloadBuilder.jsString(index.toString())
        target()?.evaluateJavascript("window.nimbalyst?.scrollToMessage?.($arg);", null)
    }

    /** The user prompts in the active transcript, oldest first. Delivered on the main thread. */
    fun getPromptList(callback: (List<TranscriptPrompt>) -> Unit) {
        val webView = target() ?: return callback(emptyList())
        webView.evaluateJavascript("JSON.stringify(window.nimbalyst?.getPromptList?.() || []);") { result ->
            callback(TranscriptBridge.parsePromptList(result))
        }
    }

    suspend fun getPromptList(): List<TranscriptPrompt> = suspendCancellableCoroutine { continuation ->
        getPromptList { prompts -> if (continuation.isActive) continuation.resume(prompts) }
    }

    private fun target(): WebView? = webView?.takeIf { isReady }
}

@Composable
fun rememberTranscriptController(): TranscriptController = remember { TranscriptController() }
