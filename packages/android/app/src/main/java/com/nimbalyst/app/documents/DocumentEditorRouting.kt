package com.nimbalyst.app.documents

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.R
import com.nimbalyst.app.transcript.TranscriptExternalLinks
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.wiki.EditorLinkTarget
import com.nimbalyst.app.wiki.WikiDocuments
import com.nimbalyst.app.wiki.WikiFormat
import com.nimbalyst.app.wiki.WikiPage
import com.nimbalyst.app.wiki.WikiPageHeader
import com.nimbalyst.app.wiki.WikiSnapshot
import com.nimbalyst.app.wiki.WikiTable
import com.nimbalyst.app.wiki.WikiTableView
import com.nimbalyst.app.wiki.WikiTypes
import com.nimbalyst.app.wiki.displayRows
import com.nimbalyst.app.wiki.resolveEditorLink
import com.nimbalyst.app.wiki.wikiSnapshot
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** What a synced file is, given what the project's Local wiki knows about it. */
internal sealed interface DocumentKind {
    /** Markdown outside a wiki (or a wiki file the reader does not list). */
    data object Plain : DocumentKind
    data class Page(val snapshot: WikiSnapshot, val page: WikiPage) : DocumentKind
    data class Table(val table: WikiTable) : DocumentKind
    /** Any other CSV: shown as a read-only grid, as on iOS. */
    data object Csv : DocumentKind
    /** A file in a wiki written by a newer format (or with an unreadable marker): shown, never saved. */
    data object Locked : DocumentKind
}

/** Mirrors iOS `WikiAwareDocumentView.resolve`: table types first, then CSV, then wiki pages. */
internal fun classifyDocument(relativePath: String, folder: String?, snapshot: WikiSnapshot?): DocumentKind {
    val isCsv = relativePath.lowercase().endsWith(".csv")
    val path = folder?.let { WikiDocuments.wikiPath(relativePath, it) }
    if (path != null && snapshot != null) {
        // Checked before anything else so no entry point (Wiki tab, Files, a transcript link) can save into it.
        if (snapshot.isUnsupportedVersion) return if (isCsv) DocumentKind.Csv else DocumentKind.Locked
        snapshot.tableAtPath(path)?.let { return DocumentKind.Table(it) }
        if (isCsv) return DocumentKind.Csv
        snapshot.pageAtPath(path)?.let { return DocumentKind.Page(snapshot, it) }
    }
    return if (isCsv) DocumentKind.Csv else DocumentKind.Plain
}

/** The project's wiki folder and types, observed so a config that arrives later takes effect. */
internal data class WikiLocation(val folder: String?, val typesJson: String?)

/**
 * A synced file, opened with what the Local wiki knows about it, mirroring iOS
 * `WikiAwareDocumentView`: pages open in the document editor (typed pages with
 * their type and fields above the body, links between pages followed in place,
 * with Back returning to the previous page), table types and other CSV files
 * as a read-only grid. Files outside a wiki open as before.
 */
@Composable
fun DocumentEditorScreen(
    projectId: String,
    relativePath: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    val manager = remember { Documents.manager(context) }
    val scope = rememberCoroutineScope()
    // Pages reached by following links; the last one is shown.
    var stack by rememberSaveable(projectId, relativePath) { mutableStateOf(listOf(relativePath)) }
    val current = stack.last()
    val notSynced = stringResource(R.string.wiki_link_not_synced)

    val location by remember(projectId) {
        app.repository.observeProjects()
            .map { projects -> projects.firstOrNull { it.id == projectId }.let { WikiLocation(it?.localWikiFolder, it?.localWikiTypesJson) } }
            .distinctUntilChanged()
    }.collectAsState(initial = null)
    val documents by remember(projectId) { manager.observeDocuments(projectId) }.collectAsStateWithLifecycle(initialValue = null)

    DisposableEffect(projectId) {
        val lease = manager.acquireProject(projectId)
        onDispose { lease.release() }
    }

    // Tagged with its path so a page reached by a link never shows with the previous page's kind.
    val resolution by produceState<Pair<String, DocumentKind>?>(null, current, location, documents) {
        val wiki = location ?: return@produceState
        val folder = wiki.folder
        if (folder == null || WikiDocuments.wikiPath(current, folder) == null) {
            value = current to classifyDocument(current, null, null)
            return@produceState
        }
        val all = documents ?: return@produceState
        val snapshot = manager.wikiSnapshot(projectId, folder, all, WikiTypes.parse(wiki.typesJson))
        value = current to classifyDocument(current, folder, snapshot)
    }
    val kind = resolution?.takeIf { it.first == current }?.second

    fun back() {
        if (stack.size > 1) stack = stack.dropLast(1) else onBack?.invoke()
    }
    BackHandler(enabled = stack.size > 1) { back() }
    val backAction: (() -> Unit)? = if (stack.size > 1) ::back else onBack

    fun follow(href: String, title: String?, snapshot: WikiSnapshot?) {
        when (val target = resolveEditorLink(href, title, current, location?.folder, snapshot)) {
            is EditorLinkTarget.External -> TranscriptExternalLinks.open(context, target.url)
            is EditorLinkTarget.Document -> scope.launch {
                if (manager.document(projectId, target.relativePath) != null) {
                    stack = stack + target.relativePath
                } else {
                    Toast.makeText(context, notSynced, Toast.LENGTH_SHORT).show()
                }
            }
            EditorLinkTarget.None -> Unit
        }
    }

    // Each page gets its own editor; leaving one flushes its unsaved edits.
    key(current) {
        when (val resolved = kind) {
            null -> ReadOnlyFrame(current.substringAfterLast('/'), backAction, modifier) {
                CircularProgressIndicator(color = NimbalystColors.primary, modifier = Modifier.align(Alignment.Center))
            }
            is DocumentKind.Table -> ReadOnlyFrame(resolved.table.title, backAction, modifier) {
                WikiTableView(resolved.table.header, resolved.table.displayRows(), resolved.table.malformed)
            }
            DocumentKind.Csv -> {
                val rows by produceState<List<List<String>>?>(null, current, documents) {
                    val text = manager.documentContent(projectId, current) ?: ""
                    value = runCatching { WikiFormat.parseCsv(text) }.getOrDefault(emptyList())
                }
                ReadOnlyFrame(current.substringAfterLast('/'), backAction, modifier) {
                    rows?.let { WikiTableView(it.firstOrNull().orEmpty(), it.drop(1), malformed = false) }
                }
            }
            // One call site for every editable kind: when the kind changes under an
            // open file (wiki config arriving, a page turning malformed) the same
            // editor gets the new permission and link handler instead of being rebuilt.
            is DocumentKind.Page, DocumentKind.Plain, DocumentKind.Locked -> {
                val spec = editorSpec(resolved)
                DocumentEditorContent(
                    projectId = projectId,
                    relativePath = current,
                    modifier = modifier,
                    onBack = backAction,
                    title = spec.title,
                    readOnly = spec.readOnly,
                    header = spec.typeName?.let { typeName -> { WikiPageHeader(typeName, spec.fields) } },
                    onLink = { href, title -> follow(href, title, spec.snapshot) },
                )
            }
        }
    }
}

/** How the editor shows a page, a plain file or a locked wiki file. */
internal data class EditorSpec(
    val title: String?,
    val readOnly: Boolean,
    /** Type display name of a typed page, for the header; null without one. */
    val typeName: String?,
    val fields: List<com.nimbalyst.app.wiki.WikiField>,
    /** The wiki links resolve in; null outside a wiki. */
    val snapshot: WikiSnapshot?,
)

internal fun editorSpec(kind: DocumentKind): EditorSpec = when (kind) {
    is DocumentKind.Page -> EditorSpec(
        title = kind.page.title,
        // Malformed frontmatter and editor files (drawings, sheets) are never rewritten from the phone.
        readOnly = kind.page.malformed || kind.page.documentType != "markdown",
        typeName = kind.page.type?.let(kind.snapshot::typeName),
        fields = kind.page.fields,
        snapshot = kind.snapshot,
    )
    DocumentKind.Locked -> EditorSpec(null, readOnly = true, typeName = null, fields = emptyList(), snapshot = null)
    else -> EditorSpec(null, readOnly = false, typeName = null, fields = emptyList(), snapshot = null)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReadOnlyFrame(
    title: String,
    onBack: (() -> Unit)?,
    modifier: Modifier,
    content: @Composable androidx.compose.foundation.layout.BoxScope.() -> Unit,
) {
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
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 17.sp) },
            )
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding), content = content)
    }
}
