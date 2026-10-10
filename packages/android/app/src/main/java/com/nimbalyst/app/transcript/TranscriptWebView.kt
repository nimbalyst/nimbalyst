package com.nimbalyst.app.transcript

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.data.MessageEntity
import kotlinx.coroutines.flow.flowOf

/**
 * The session transcript, rendered by the bundled React app in a pooled WebView.
 *
 * The first frame for a session sends a full `loadSession`; later Room
 * emissions send only `appendMessages`/`updateMetadata` deltas, and fall back
 * to a full load when the bridge rejects one (see [TranscriptSessionSync]).
 *
 * @param isExecuting whether the desktop is running a turn. Null derives it
 *   from the session row in Room.
 * @param controller handle for Scroll to Top / Jump to Prompt.
 * @param onOpenFile called when the transcript links to a file. Null shows a
 *   "not available yet" toast.
 */
@Composable
fun TranscriptWebView(
    modifier: Modifier = Modifier,
    sessionId: String,
    sessionTitle: String,
    provider: String,
    model: String,
    mode: String,
    messages: List<MessageEntity>,
    onPromptSubmitted: (String) -> Unit = {},
    onInteractiveResponse: (TranscriptBridgeMessage) -> Unit = {},
    isExecuting: Boolean? = null,
    controller: TranscriptController? = null,
    onOpenFile: ((String) -> Unit)? = null,
) {
    val context = LocalContext.current

    if (!context.hasTranscriptAssets()) {
        MissingTranscriptAssets(modifier = modifier, sessionTitle = sessionTitle)
        return
    }

    val sessionFlow = remember(sessionId, isExecuting == null) {
        val app = context.applicationContext as? NimbalystApplication
        if (isExecuting == null && app != null) app.repository.observeSession(sessionId) else flowOf(null)
    }
    val observedSession by sessionFlow.collectAsState(initial = null)
    val executing = isExecuting ?: (observedSession?.isExecuting ?: false)

    val host = remember { TranscriptHost(context, controller) }
    host.callbacks = TranscriptCallbacks(onPromptSubmitted, onInteractiveResponse, onOpenFile)

    DisposableEffect(host) {
        onDispose { host.dispose() }
    }

    val snapshot = TranscriptSnapshot(
        sessionId = sessionId,
        metadata = TranscriptMetadata(sessionTitle, provider, model, mode, executing),
        messages = messages
    )
    LaunchedEffect(host, snapshot) {
        host.submit(snapshot)
    }

    Box(modifier = modifier) {
        host.webView?.let { webView ->
            key(webView) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { webView },
                    // A dead view is destroyed here; a live one goes back to the pool.
                    onRelease = { view -> TranscriptWebViewPool.recycle(view) }
                )
            }
        }
        host.error?.let { message ->
            TranscriptErrorCard(
                message = message,
                debugInfo = { host.debugInfo() },
                onRetry = host::retry,
                onDismiss = host::dismissError,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(20.dp)
            )
        }
    }
}

@Composable
private fun TranscriptErrorCard(
    message: String,
    debugInfo: () -> String,
    onRetry: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val clipboard = LocalClipboardManager.current
    Card(modifier = modifier) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(text = "Transcript unavailable", style = MaterialTheme.typography.titleMedium)
            Text(text = message, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { clipboard.setText(AnnotatedString(debugInfo())) }) {
                    Text("Copy debug info")
                }
                TextButton(onClick = onDismiss) { Text("Dismiss") }
                Button(onClick = onRetry) { Text("Retry") }
            }
        }
    }
}

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
