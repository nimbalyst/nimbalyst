package com.nimbalyst.app.transcript

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.nimbalyst.app.data.MessageEntity

@Composable
fun TranscriptWebView(
    modifier: Modifier = Modifier,
    sessionId: String,
    sessionTitle: String,
    provider: String,
    model: String,
    mode: String,
    isExecuting: Boolean = false,
    agentStatusKind: String? = null,
    agentStatusLabel: String? = null,
    agentStatusDetail: String? = null,
    messages: List<MessageEntity>,
    transcriptTailJson: String? = null,
    transcriptHistoryPageJson: String? = null,
    onPromptSubmitted: (String) -> Unit = {},
    onInteractiveResponse: (TranscriptBridgeMessage) -> Unit = {},
    onLoadOlderHistory: (Long?, Int?) -> Unit = { _, _ -> },
) {
    val context = LocalContext.current

    if (!context.hasTranscriptAssets()) {
        MissingTranscriptAssets(modifier = modifier, sessionTitle = sessionTitle)
        return
    }

    val webView = remember { TranscriptWebViewPool.take(context) }
    val retryHandler = remember { Handler(Looper.getMainLooper()) }
    val pendingRetry = remember { mutableListOf<Runnable>() }

    DisposableEffect(Unit) {
        onDispose {
            pendingRetry.forEach { retryHandler.removeCallbacks(it) }
            pendingRetry.clear()
            TranscriptWebViewPool.recycle(webView)
        }
    }

    AndroidView(
        modifier = modifier,
        factory = { _ ->
            webView.apply {
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        return request.url?.scheme != "file"
                    }

                    override fun onPageFinished(view: WebView, url: String?) {
                        super.onPageFinished(view, url)
                        if (url == TRANSCRIPT_ASSET_URL) {
                            view.pushSessionPayload(
                                sessionId = sessionId,
                                sessionTitle = sessionTitle,
                                provider = provider,
                                model = model,
                                mode = mode,
                                isExecuting = isExecuting,
                                agentStatusKind = agentStatusKind,
                                agentStatusLabel = agentStatusLabel,
                                agentStatusDetail = agentStatusDetail,
                                messages = messages,
                                viewMessagesJson = transcriptTailJson,
                                historyPageJson = transcriptHistoryPageJson
                            )
                        }
                    }
                }
                removeJavascriptInterface("AndroidBridge")
                addJavascriptInterface(
                    TranscriptBridge { message ->
                        when (message.type) {
                            "prompt" -> message.text?.let(onPromptSubmitted)
                            "interactive_response" -> onInteractiveResponse(message)
                            "load_older_history" -> onLoadOlderHistory(message.beforeRawMessageId, message.count)
                        }
                    },
                    "AndroidBridge"
                )
                // Pooled WebViews load the transcript during warmup, before this
                // session-scoped bridge exists. Reload so AndroidBridge is injected
                // into the page that handles interactive widgets.
                loadUrl(TRANSCRIPT_ASSET_URL)

                // Try to push payload immediately. If React is still mounting, this
                // is a no-op. onPageFinished, the update block, and retries will
                // push again.
                pushSessionPayload(
                    sessionId = sessionId,
                    sessionTitle = sessionTitle,
                    provider = provider,
                    model = model,
                    mode = mode,
                    isExecuting = isExecuting,
                    agentStatusKind = agentStatusKind,
                    agentStatusLabel = agentStatusLabel,
                    agentStatusDetail = agentStatusDetail,
                    messages = messages,
                    viewMessagesJson = transcriptTailJson,
                    historyPageJson = transcriptHistoryPageJson
                )
                scheduleRetry(retryHandler, pendingRetry, this,
                    sessionId, sessionTitle, provider, model, mode, isExecuting, agentStatusKind, agentStatusLabel, agentStatusDetail, messages, transcriptTailJson, transcriptHistoryPageJson)
            }
        },
        update = { wv ->
            // Cancel pending retries since we have fresh data
            pendingRetry.forEach { retryHandler.removeCallbacks(it) }
            pendingRetry.clear()

            wv.pushSessionPayload(
                sessionId = sessionId,
                sessionTitle = sessionTitle,
                provider = provider,
                model = model,
                mode = mode,
                isExecuting = isExecuting,
                agentStatusKind = agentStatusKind,
                agentStatusLabel = agentStatusLabel,
                agentStatusDetail = agentStatusDetail,
                messages = messages,
                viewMessagesJson = transcriptTailJson,
                historyPageJson = transcriptHistoryPageJson
            )
            // Schedule a retry in case React hasn't mounted yet
            scheduleRetry(retryHandler, pendingRetry, wv,
                sessionId, sessionTitle, provider, model, mode, isExecuting, agentStatusKind, agentStatusLabel, agentStatusDetail, messages, transcriptTailJson, transcriptHistoryPageJson)
        }
    )
}

private const val TRANSCRIPT_ASSET_URL = "file:///android_asset/transcript-dist/transcript.html"

private fun scheduleRetry(
    handler: Handler,
    pendingRetries: MutableList<Runnable>,
    webView: WebView,
    sessionId: String,
    sessionTitle: String,
    provider: String,
    model: String,
    mode: String,
    isExecuting: Boolean,
    agentStatusKind: String?,
    agentStatusLabel: String?,
    agentStatusDetail: String?,
    messages: List<MessageEntity>,
    viewMessagesJson: String?,
    historyPageJson: String?
) {
    // Retry at 200ms, 500ms, 1000ms to cover React mount timing
    for (delayMs in listOf(200L, 500L, 1000L)) {
        val retry = Runnable {
            webView.pushSessionPayload(
                sessionId,
                sessionTitle,
                provider,
                model,
                mode,
                isExecuting,
                agentStatusKind,
                agentStatusLabel,
                agentStatusDetail,
                messages,
                viewMessagesJson,
                historyPageJson
            )
        }
        pendingRetries.add(retry)
        handler.postDelayed(retry, delayMs)
    }
}

private fun WebView.pushSessionPayload(
    sessionId: String,
    sessionTitle: String,
    provider: String,
    model: String,
    mode: String,
    isExecuting: Boolean,
    agentStatusKind: String?,
    agentStatusLabel: String?,
    agentStatusDetail: String?,
    messages: List<MessageEntity>,
    viewMessagesJson: String?,
    historyPageJson: String?
) {
    val payload = TranscriptPayloadBuilder.buildSessionPayload(
        sessionId = sessionId,
        sessionTitle = sessionTitle,
        provider = provider,
        model = model,
        mode = mode,
        isExecuting = isExecuting,
        agentStatusKind = agentStatusKind,
        agentStatusLabel = agentStatusLabel,
        agentStatusDetail = agentStatusDetail,
        messages = messages,
        viewMessagesJson = viewMessagesJson,
        historyPageJson = historyPageJson
    )
    val payloadHash = payload.hashCode().toString()
    // Log diagnostic info, then attempt to load the session.
    val script = """
        (function() {
            var hasNimbalyst = typeof window.nimbalyst !== 'undefined';
            var payloadHash = ${gsonString(payloadHash)};
            var payload = $payload;
            var messageCount = Array.isArray(payload.messages) ? payload.messages.length : 0;
            var viewMessageCount = Array.isArray(payload.viewMessages) ? payload.viewMessages.length : 0;
            var historyMessageCount = payload.historyPage && Array.isArray(payload.historyPage.messages) ? payload.historyPage.messages.length : 0;
            console.log('[TranscriptWebView] pushPayload: nimbalyst=' + hasNimbalyst + ' messages=' + messageCount + ' viewMessages=' + viewMessageCount + ' historyMessages=' + historyMessageCount);
            if (hasNimbalyst) {
                if (window.__nimbalystLastPayloadHash === payloadHash) {
                    return;
                }
                try {
                    window.nimbalyst.loadSession(payload);
                    window.__nimbalystLastPayloadHash = payloadHash;
                    console.log('[TranscriptWebView] loadSession succeeded');
                } catch(e) {
                    console.error('[TranscriptWebView] loadSession error: ' + e.message);
                }
            }
        })();
    """.trimIndent()
    evaluateJavascript(script, null)
}

private fun gsonString(value: String): String =
    com.google.gson.Gson().toJson(value)

@Composable
private fun MissingTranscriptAssets(
    modifier: Modifier,
    sessionTitle: String
) {
    Card(modifier = modifier) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(20.dp),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = "Transcript assets are missing for \"$sessionTitle\".\n\nRun `npm run build:transcript` and `npm run sync:transcript-assets` in packages/android.",
                style = MaterialTheme.typography.bodyMedium
            )
        }
    }
}

private fun Context.hasTranscriptAssets(): Boolean {
    return try {
        assets.open("transcript-dist/transcript.html").close()
        true
    } catch (_: Exception) {
        false
    }
}
