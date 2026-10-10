package com.nimbalyst.app.documents

import android.view.View
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Save
import androidx.compose.material.icons.outlined.TextFormat
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.launch

private sealed interface EditorLoad {
    data object Loading : EditorLoad
    data class Loaded(val markdown: String, val syncId: String) : EditorLoad
    data object Missing : EditorLoad
    data object DecryptFailed : EditorLoad
    data class SyncFailed(val message: String) : EditorLoad
}

/**
 * Decides the teardown save. The bundle's ack can lag native: native may have
 * persisted AB while the bundle still reports AB unsaved, and a remote save may
 * have landed since. Re-saving AB then would overwrite it, so the teardown
 * save is skipped when it is exactly the last body native persisted or loaded
 * for this document. Genuinely unsaved text still saves (last write wins).
 */
internal class TeardownSaveGuard {
    private var lastPersistedBody: String? = null

    /** A save of [content] was sent or queued. */
    fun onPersisted(content: String) {
        lastPersistedBody = content
    }

    /** [content] was loaded into the editor (initial load, remote apply, read-only reload). */
    fun onLoaded(content: String) {
        lastPersistedBody = content
    }

    /** [finalContent] is the bundle's answer (null when it has nothing unsaved). */
    fun shouldSave(finalContent: String?): Boolean = finalContent != null && finalContent != lastPersistedBody
}

/**
 * Edits one synced markdown file in the bundled Lexical editor, mirroring iOS
 * `DocumentEditorView`. Each user edit is saved about half a second after
 * typing stops (the bundle debounces), and Save flushes immediately. Every
 * save starts in the bundle with a revision and is answered here with
 * `saveResult`; the bundle owns what is confirmed and whether it is dirty
 * (`pendingSave.ts`). A save
 * pushes the whole encrypted file; the server keeps the last write. Offline
 * saves are queued and sent when the project's room reconnects.
 *
 * The editor holds its project's room itself: after process restore it can be
 * the first screen, with no file list to have connected the room.
 *
 * [DocumentEditorScreen] decides what wraps it: a wiki page's [title] and
 * [header], [readOnly] for pages the phone must not rewrite, and [onLink] for
 * links tapped in the document.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DocumentEditorContent(
    projectId: String,
    relativePath: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    title: String? = null,
    readOnly: Boolean = false,
    header: (@Composable () -> Unit)? = null,
    onLink: ((href: String, title: String?) -> Unit)? = null,
) {
    val context = LocalContext.current
    val manager = remember { Documents.manager(context) }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val relay = remember { EditorBridgeRelay() }

    var load by remember(projectId, relativePath) { mutableStateOf<EditorLoad>(EditorLoad.Loading) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var editorReady by remember { mutableStateOf(false) }
    var contentPushed by remember { mutableStateOf(false) }
    // The bundle's dirty state: unsaved body, or a save not yet answered.
    var dirty by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var formatMenuOpen by remember { mutableStateOf(false) }
    val queued by remember(projectId) { manager.observeOutboxCount(projectId) }.collectAsStateWithLifecycle(0)
    val states by manager.states.collectAsStateWithLifecycle()
    val failures by manager.saveFailures.collectAsStateWithLifecycle()
    // Read through State by the bridge handler and lifecycle observer, which are
    // registered once: the permission and link handler can change while the
    // editor stays open (wiki config arriving, a page turning malformed).
    val canWrite by rememberUpdatedState(!readOnly)
    val currentOnLink by rememberUpdatedState(onLink)
    val teardown = remember(projectId, relativePath) { TeardownSaveGuard() }

    fun loadIntoEditor(view: WebView, markdown: String) {
        teardown.onLoaded(markdown)
        view.evaluateJavascript(EditorCommands.loadMarkdown(markdown), null)
    }

    /** Persists one bundle save and answers it; only Sent or Queued (in the outbox) count as persisted. */
    fun save(markdown: String, revision: Long) {
        if (!canWrite) {
            webView?.evaluateJavascript(EditorCommands.saveResult(revision, ok = false), null)
            return
        }
        scope.launch {
            val ok = when (val outcome = manager.saveDocument(projectId, relativePath, markdown)) {
                SaveOutcome.Sent, SaveOutcome.Queued -> {
                    teardown.onPersisted(markdown)
                    true
                }
                is SaveOutcome.Failed -> {
                    errorMessage = outcome.message
                    false
                }
            }
            webView?.evaluateJavascript(EditorCommands.saveResult(revision, ok), null)
        }
    }

    /**
     * Asks the bundle to save now; the save comes back as a ContentChanged like
     * any other. Not gated on `dirty`, which can lag the bundle; it no-ops when clean.
     */
    fun flush(view: WebView) {
        EditorCommands.flushFor(canWrite)?.let { view.evaluateJavascript(it, null) }
    }

    /**
     * The editor is going away and cannot wait for an answer: hands whatever is
     * unsaved (including a save still in flight) to the manager, which keeps it
     * until it is on disk and reports a failure in `saveFailures`.
     */
    fun saveFinal(view: WebView, then: () -> Unit) {
        // Not gated on `dirty`: dirty and save messages arrive asynchronously, so
        // native's flag can lag the bundle. The bundle's null is the answer.
        if (!canWrite) return then()
        view.evaluateJavascript(EditorCommands.FINAL_CONTENT) { result ->
            EditorCommands.decodeContent(result)
                ?.takeIf { canWrite && teardown.shouldSave(it) }
                ?.let { manager.saveInBackground(projectId, relativePath, it) }
            then()
        }
    }

    DisposableEffect(projectId) {
        val lease = manager.acquireProject(projectId)
        onDispose { lease.release() }
    }

    // Observed rather than looked up once: on a cold start the account, key,
    // and project transfer may all still be on their way.
    LaunchedEffect(projectId, relativePath) {
        manager.observeAvailability(projectId, relativePath).collect { availability ->
            if (load is EditorLoad.Loaded) return@collect
            load = when (availability) {
                DocumentAvailability.Waiting -> EditorLoad.Loading
                DocumentAvailability.Missing -> EditorLoad.Missing
                is DocumentAvailability.Failed -> EditorLoad.SyncFailed(availability.message)
                is DocumentAvailability.Available -> manager.documentContent(projectId, relativePath)
                    ?.let { EditorLoad.Loaded(it, availability.document.syncId) }
                    ?: EditorLoad.DecryptFailed
            }
        }
    }

    LaunchedEffect(editorReady, load, webView) {
        val loaded = load as? EditorLoad.Loaded ?: return@LaunchedEffect
        val view = webView ?: return@LaunchedEffect
        if (editorReady && !contentPushed) {
            contentPushed = true
            if (!canWrite) view.evaluateJavascript(EditorCommands.setReadOnly(true), null)
            loadIntoEditor(view, loaded.markdown)
        }
    }

    // Editability follows the current permission, not the one at mount. A page
    // that turns read-only with unsaved typing shows the file again: those
    // edits can never be saved from the phone.
    LaunchedEffect(readOnly, editorReady, webView) {
        val view = webView ?: return@LaunchedEffect
        if (!editorReady) return@LaunchedEffect
        view.evaluateJavascript(EditorCommands.setReadOnly(readOnly), null)
        if (readOnly && dirty && contentPushed) {
            // Loading resets the bundle's confirmed body, so it reports clean.
            manager.documentContent(projectId, relativePath)?.let { loadIntoEditor(view, it) }
        }
    }

    // Another device's save replaces the content unless there are local edits
    // in flight. Then the bundle defers it: the next save carries the remote
    // frontmatter (the phone never edits it), a local save still wins for the
    // body (last write wins), and undoing the edits shows the remote body.
    LaunchedEffect(load) {
        val syncId = (load as? EditorLoad.Loaded)?.syncId ?: return@LaunchedEffect
        manager.remoteUpdates.collect { update ->
            if (update.projectId != projectId || update.syncId != syncId || !contentPushed) return@collect
            val view = webView ?: return@collect
            if (dirty && canWrite) {
                view.evaluateJavascript(EditorCommands.remoteUpdate(update.markdown, dirty = true), null)
            } else {
                loadIntoEditor(view, update.markdown)
            }
        }
    }

    DisposableEffect(relay) {
        relay.handler = { message ->
            when (message) {
                EditorBridgeMessage.EditorReady -> editorReady = true
                is EditorBridgeMessage.Dirty -> dirty = message.isDirty
                // A read-only page is never written: save() answers it as failed.
                is EditorBridgeMessage.ContentChanged -> save(message.content, message.revision)
                is EditorBridgeMessage.Error -> errorMessage = message.message
                is EditorBridgeMessage.LinkClicked -> currentOnLink?.invoke(message.href, message.title)
            }
        }
        onDispose { relay.handler = null }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) webView?.let { flush(it) }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    Scaffold(
        modifier = modifier,
        containerColor = NimbalystColors.backgroundSecondary,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = NimbalystColors.background),
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.document_editor_back))
                        }
                    }
                },
                title = {
                    Text(title ?: relativePath.substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 17.sp)
                },
                actions = {
                    if (dirty) {
                        Box(
                            modifier = Modifier
                                .padding(horizontal = 8.dp)
                                .size(8.dp)
                                .background(NimbalystColors.primary, CircleShape)
                        )
                    }
                    val editable = load is EditorLoad.Loaded && editorReady && !readOnly
                    if (!readOnly) Box {
                        IconButton(onClick = { formatMenuOpen = true }, enabled = editable) {
                            Icon(Icons.Outlined.TextFormat, contentDescription = stringResource(R.string.document_editor_format))
                        }
                        DropdownMenu(expanded = formatMenuOpen, onDismissRequest = { formatMenuOpen = false }) {
                            listOf(
                                EditorFormat.BOLD to R.string.document_editor_bold,
                                EditorFormat.ITALIC to R.string.document_editor_italic,
                                EditorFormat.CODE to R.string.document_editor_code,
                                EditorFormat.STRIKETHROUGH to R.string.document_editor_strikethrough,
                            ).forEach { (format, label) ->
                                DropdownMenuItem(
                                    text = { Text(stringResource(label)) },
                                    onClick = {
                                        formatMenuOpen = false
                                        webView?.evaluateJavascript(EditorCommands.formatText(format), null)
                                    },
                                )
                            }
                        }
                    }
                    if (!readOnly) IconButton(
                        onClick = { webView?.evaluateJavascript(EditorCommands.FLUSH, null) },
                        enabled = editable,
                    ) {
                        Icon(Icons.Outlined.Save, contentDescription = stringResource(R.string.document_editor_save))
                    }
                },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding).imePadding()) {
            when (val current = load) {
                EditorLoad.Missing -> Notice(stringResource(R.string.document_editor_missing))
                EditorLoad.DecryptFailed -> Notice(stringResource(R.string.document_editor_decrypt_failed))
                is EditorLoad.SyncFailed -> Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
                ) {
                    Text(current.message, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
                    TextButton(onClick = { manager.retryProject(projectId) }) { Text(stringResource(R.string.documents_retry)) }
                }
                EditorLoad.Loading, is EditorLoad.Loaded -> {
                    Column(modifier = Modifier.fillMaxSize()) {
                        SaveFailureBanner(
                            failures = failures.filter { it.projectId == projectId && it.relativePath == relativePath },
                            onRetry = manager::retrySave,
                            onDiscard = manager::discardUnsaved,
                        )
                        // Pushes wait in the outbox until the server confirms them; only
                        // a room that is not ready means they are actually stuck here.
                        if (queued > 0 && states[projectId] != DocumentSyncState.Ready) {
                            Text(
                                stringResource(R.string.document_editor_queued),
                                fontSize = 12.sp,
                                color = NimbalystColors.textMuted,
                                modifier = Modifier.fillMaxWidth().background(NimbalystColors.background).padding(horizontal = 16.dp, vertical = 6.dp),
                            )
                        }
                        header?.invoke()
                        AndroidView(
                            modifier = Modifier.fillMaxSize(),
                            factory = { viewContext ->
                                // A plain View stands in when no WebView could be created; errorMessage explains why.
                                createDocumentEditorWebView(viewContext, relay) { errorMessage = it }
                                    ?.also { webView = it } ?: View(viewContext)
                            },
                            onRelease = { view ->
                                if (view is WebView) {
                                    // Save anything typed in the last half second, then free the renderer.
                                    saveFinal(view) { view.destroy() }
                                    if (webView === view) webView = null
                                }
                            },
                        )
                    }
                    if (current == EditorLoad.Loading || !editorReady) {
                        Column(
                            modifier = Modifier.fillMaxSize().background(NimbalystColors.backgroundSecondary),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            CircularProgressIndicator(color = NimbalystColors.primary)
                            Text(
                                stringResource(R.string.document_editor_loading),
                                color = NimbalystColors.textMuted,
                                modifier = Modifier.padding(top = 12.dp),
                            )
                        }
                    }
                }
            }
            errorMessage?.let { message ->
                val title = stringResource(R.string.document_editor_error_title)
                EditorErrorCard(
                    message = message,
                    onCopy = { clipboard.setText(AnnotatedString("$title\nDocument: $relativePath\n\n$message")) },
                    onDismiss = { errorMessage = null },
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

@Composable
private fun Notice(text: String) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
    }
}

@Composable
private fun EditorErrorCard(message: String, onCopy: () -> Unit, onDismiss: () -> Unit, modifier: Modifier) {
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier = modifier
            .padding(16.dp)
            .widthIn(max = 420.dp)
            .background(NimbalystColors.background, shape)
            .border(1.dp, NimbalystColors.border, shape)
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = NimbalystColors.warning)
        Text(stringResource(R.string.document_editor_error_title), color = NimbalystColors.text, fontSize = 16.sp)
        Text(message, color = NimbalystColors.textMuted, fontSize = 12.sp, textAlign = TextAlign.Center)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            TextButton(onClick = onCopy) { Text(stringResource(R.string.document_editor_copy)) }
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.document_editor_dismiss)) }
        }
    }
}
