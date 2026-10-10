package com.nimbalyst.app.wiki

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Sell
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nimbalyst.app.R
import com.nimbalyst.app.documents.DocumentSyncManager
import com.nimbalyst.app.documents.DocumentSyncState
import com.nimbalyst.app.documents.DocumentSummary
import com.nimbalyst.app.documents.Documents
import com.nimbalyst.app.sync.SyncedWikiType
import com.nimbalyst.app.ui.components.NimbalystSecondaryButton
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.ui.theme.NimbalystShapes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The project's wiki snapshot from its synced files, re-read when a wiki file changes. */
internal suspend fun DocumentSyncManager.wikiSnapshot(
    projectId: String,
    folder: String,
    documents: List<DocumentSummary>,
    types: List<SyncedWikiType>,
): WikiSnapshot = withContext(Dispatchers.Default) {
    WikiStore.shared.snapshot(projectId, folder, documents, types) { documentContent(projectId, it) }
}

/**
 * The project's Local wiki as a page tree, mirroring iOS `WikiTreeView`: titles
 * and `order` from the files, Home first, child pages under their parent, table
 * types among their siblings, sync conflict copies under the page they diverged
 * from. Trash and the marker never show. [onOpenDocument] takes the
 * project-relative path, as the Files tab's does.
 */
@Composable
fun WikiTreeScreen(
    projectId: String,
    folder: String,
    typesJson: String?,
    onOpenDocument: (relativePath: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val manager = remember { Documents.manager(context) }
    val documents by remember(projectId) { manager.observeDocuments(projectId) }.collectAsStateWithLifecycle(initialValue = null)
    val states by manager.states.collectAsStateWithLifecycle()
    val syncState = states[projectId] ?: DocumentSyncState.Connecting
    val types = remember(typesJson) { WikiTypes.parse(typesJson) }
    val expansion = remember(projectId) { WikiExpansionStore(context, projectId) }
    var expanded by remember(projectId) { mutableStateOf(expansion.load()) }
    var query by rememberSaveable(projectId) { mutableStateOf("") }

    DisposableEffect(projectId) {
        val lease = manager.acquireProject(projectId)
        onDispose { lease.release() }
    }

    val snapshot by produceState<WikiSnapshot?>(null, documents, folder, types) {
        val all = documents ?: return@produceState
        value = manager.wikiSnapshot(projectId, folder, all, types)
    }

    Column(modifier = modifier.fillMaxSize()) {
        WikiSearchField(query) { query = it }
        val current = snapshot
        when {
            current == null -> Centered { Progress(stringResource(R.string.wiki_loading)) }
            current.isUnsupportedVersion -> Centered { Message(stringResource(R.string.wiki_unsupported_version)) }
            current.tree.isEmpty() -> when (syncState) {
                DocumentSyncState.Ready -> Centered { Message(stringResource(R.string.wiki_empty)) }
                is DocumentSyncState.Failed -> Centered {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Message(syncState.message)
                        NimbalystSecondaryButton(text = stringResource(R.string.documents_retry), onClick = { manager.retryProject(projectId) })
                    }
                }
                else -> Centered { Progress(stringResource(R.string.wiki_syncing)) }
            }
            else -> {
                val synced = remember(documents) { documents.orEmpty().mapTo(HashSet()) { it.relativePath } }
                val rows = remember(current, synced, expanded, query) { wikiTreeRows(current, folder, synced, expanded, query) }
                if (rows.isEmpty()) {
                    Centered { Message(stringResource(R.string.wiki_no_matches, query.trim())) }
                } else {
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(rows, key = { it.id }) { row ->
                            WikiRow(
                                row = row,
                                isExpanded = row.id in expanded,
                                onToggle = {
                                    expanded = if (row.id in expanded) expanded - row.id else expanded + row.id
                                    expansion.save(expanded)
                                },
                                onOpen = { path -> onOpenDocument(path) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Per-project expanded pages, kept across launches like iOS's `wikiTree.expanded` key. */
private class WikiExpansionStore(context: Context, private val projectId: String) {
    private val prefs = context.applicationContext.getSharedPreferences("nimbalyst_documents", Context.MODE_PRIVATE)
    private val key get() = "wikiTree.expanded.$projectId"

    fun load(): Set<String> = prefs.getStringSet(key, emptySet())?.toSet() ?: emptySet()

    fun save(ids: Set<String>) {
        prefs.edit().putStringSet(key, ids.toSet()).apply()
    }
}

@Composable
private fun WikiRow(row: WikiTreeRow, isExpanded: Boolean, onToggle: () -> Unit, onOpen: (String) -> Unit) {
    val isConflict = row.kind == WikiRowKind.CONFLICT
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { row.documentPath?.let(onOpen) ?: onToggle() }
            .padding(start = 8.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.width((14 * row.depth).dp))
        if (row.hasChildren) {
            IconButton(onClick = onToggle, modifier = Modifier.size(28.dp)) {
                Icon(
                    Icons.Filled.ChevronRight,
                    contentDescription = stringResource(if (isExpanded) R.string.wiki_collapse else R.string.wiki_expand, row.title),
                    tint = NimbalystColors.textFaint,
                    modifier = Modifier.size(20.dp).rotate(if (isExpanded) 90f else 0f),
                )
            }
        } else {
            Spacer(Modifier.width(28.dp))
        }
        Icon(
            when (row.kind) {
                WikiRowKind.CONFLICT -> Icons.Filled.Warning
                WikiRowKind.TYPED_PAGE -> Icons.Outlined.Sell
                WikiRowKind.TABLE -> Icons.Outlined.TableChart
                WikiRowKind.EDITOR_PAGE -> Icons.AutoMirrored.Outlined.InsertDriveFile
                WikiRowKind.PAGE -> Icons.Outlined.Description
            },
            contentDescription = null,
            tint = if (isConflict) NimbalystColors.warning else NimbalystColors.primary,
            modifier = Modifier.padding(end = 6.dp).size(18.dp),
        )
        Text(
            row.title,
            fontSize = 14.sp,
            color = if (row.documentPath == null && !row.hasChildren) NimbalystColors.textFaint else NimbalystColors.text,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        val badge = if (isConflict) stringResource(R.string.wiki_conflict_badge) else row.badge
        if (badge != null) {
            Text(
                badge,
                fontSize = 10.sp,
                color = if (isConflict) NimbalystColors.warning else NimbalystColors.textFaint,
                modifier = Modifier
                    .background(NimbalystColors.background, NimbalystShapes.capsule)
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun WikiSearchField(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        placeholder = { Text(stringResource(R.string.wiki_search_placeholder)) },
        leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
        trailingIcon = if (value.isNotEmpty()) {
            {
                IconButton(onClick = { onValueChange("") }) {
                    Icon(Icons.Default.Clear, contentDescription = stringResource(R.string.documents_clear_search))
                }
            }
        } else {
            null
        },
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    )
}

@Composable
private fun Progress(text: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(color = NimbalystColors.primary)
        Text(text, color = NimbalystColors.textMuted)
    }
}

@Composable
private fun Message(text: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.AutoMirrored.Outlined.MenuBook, contentDescription = null, tint = NimbalystColors.textFaint, modifier = Modifier.size(36.dp))
        Text(text, fontSize = 12.sp, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { content() }
}
