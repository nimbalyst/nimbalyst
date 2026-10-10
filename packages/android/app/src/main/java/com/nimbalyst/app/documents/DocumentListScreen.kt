package com.nimbalyst.app.documents

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
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Brush
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.DataObject
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.components.NimbalystSecondaryButton
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.ui.theme.NimbalystShapes
import com.nimbalyst.app.utils.RelativeTimestamp
import com.nimbalyst.app.wiki.WikiDocuments

/**
 * A project's synced files as a collapsible tree, mirroring iOS
 * `DocumentListView`. Holds the project's document room open while shown;
 * [onOpenDocument] receives the file's relative path, which is what
 * [DocumentEditorScreen] takes. Inside the Local wiki at [wikiFolder], only
 * markdown pages are listed; table CSVs, the marker, sidecars and trash belong
 * to the Wiki tab.
 */
@Composable
fun DocumentListScreen(
    projectId: String,
    onOpenDocument: (relativePath: String) -> Unit,
    modifier: Modifier = Modifier,
    wikiFolder: String? = null,
) {
    val context = LocalContext.current
    val manager = remember { Documents.manager(context) }
    val documents by remember(projectId) { manager.observeDocuments(projectId) }
        .collectAsStateWithLifecycle(initialValue = null)
    val states by manager.states.collectAsStateWithLifecycle()
    val syncState = states[projectId] ?: DocumentSyncState.Connecting
    val expansionStore = remember(projectId) { ExpandedPathsStore(context, projectId) }
    var expanded by remember(projectId) { mutableStateOf(expansionStore.load()) }
    var query by rememberSaveable(projectId) { mutableStateOf("") }
    val failures by manager.saveFailures.collectAsStateWithLifecycle()

    DisposableEffect(projectId) {
        val lease = manager.acquireProject(projectId)
        onDispose { lease.release() }
    }

    val all = remember(documents, wikiFolder) {
        documents?.filterNot { WikiDocuments.isWikiDataFile(it.relativePath, wikiFolder) }
    }
    Column(modifier = modifier.fillMaxSize()) {
        SearchField(query) { query = it }
        // Where the user lands after leaving an editor whose last save failed.
        SaveFailureBanner(
            failures = failures.filter { it.projectId == projectId },
            onRetry = manager::retrySave,
            onDiscard = manager::discardUnsaved,
        )
        when {
            all == null -> Centered { Progress(stringResource(R.string.documents_loading)) }
            all.isEmpty() -> when (syncState) {
                DocumentSyncState.Ready -> Centered { EmptyState() }
                is DocumentSyncState.Failed -> Centered { SyncError(syncState.message) { manager.retryProject(projectId) } }
                else -> Centered { Progress(stringResource(R.string.documents_syncing)) }
            }
            else -> {
                SyncStatusBar(syncState, all.size) { manager.retryProject(projectId) }
                val matches = filterDocuments(all, query)
                if (matches.isEmpty()) {
                    Centered {
                        Text(
                            stringResource(R.string.documents_no_matches, query.trim()),
                            color = NimbalystColors.textMuted,
                            textAlign = TextAlign.Center,
                        )
                    }
                } else {
                    val visibleExpansion = expandedPathsFor(matches, query, expanded)
                    val nodes = remember(matches, visibleExpansion) { buildFlattenedTree(matches, visibleExpansion) }
                    LazyColumn(modifier = Modifier.fillMaxSize()) {
                        items(nodes, key = { it.id }) { node ->
                            FileTreeRow(
                                node = node,
                                isExpanded = node.path in visibleExpansion,
                                onClick = {
                                    if (node.isDirectory) {
                                        expanded = if (node.path in expanded) expanded - node.path else expanded + node.path
                                        expansionStore.save(expanded)
                                    } else {
                                        onOpenDocument(node.path)
                                    }
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Per-project expanded folders, kept across launches like iOS's UserDefaults key. */
internal class ExpandedPathsStore(context: Context, private val projectId: String) {
    private val prefs = context.applicationContext.getSharedPreferences("nimbalyst_documents", Context.MODE_PRIVATE)
    private val key get() = "fileTree.expandedPaths.$projectId"

    fun load(): Set<String> = prefs.getStringSet(key, emptySet())?.toSet() ?: emptySet()

    fun save(paths: Set<String>) {
        prefs.edit().putStringSet(key, paths.toSet()).apply()
    }
}

@Composable
private fun SearchField(value: String, onValueChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        placeholder = { Text(stringResource(R.string.documents_search_placeholder)) },
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
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
    )
}

@Composable
private fun SyncStatusBar(state: DocumentSyncState, count: Int, onRetry: () -> Unit) {
    when (state) {
        is DocumentSyncState.Failed -> SyncError(state.message, onRetry)
        DocumentSyncState.Connecting -> StatusLine(stringResource(R.string.documents_connecting), progress = true)
        is DocumentSyncState.Syncing -> StatusLine(stringResource(R.string.documents_syncing_received, state.received), progress = true)
        DocumentSyncState.Ready -> StatusLine(pluralStringResource(R.plurals.documents_file_count, count, count), progress = false)
    }
}

@Composable
private fun StatusLine(text: String, progress: Boolean) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(text, fontSize = 12.sp, color = NimbalystColors.textMuted)
        if (progress) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                color = NimbalystColors.primary,
                trackColor = NimbalystColors.backgroundTertiary,
            )
        }
    }
}

@Composable
private fun SyncError(message: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(message, fontSize = 13.sp, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
        NimbalystSecondaryButton(text = stringResource(R.string.documents_retry), onClick = onRetry)
    }
}

@Composable
private fun Progress(text: String) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(color = NimbalystColors.primary)
        Text(text, color = NimbalystColors.textMuted)
    }
}

@Composable
private fun EmptyState() {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(Icons.Outlined.Description, contentDescription = null, tint = NimbalystColors.textFaint, modifier = Modifier.size(48.dp))
        Text(stringResource(R.string.documents_empty_title), fontSize = 20.sp, color = NimbalystColors.text)
        Text(
            stringResource(R.string.documents_empty_detail),
            fontSize = 12.sp,
            color = NimbalystColors.textMuted,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun FileTreeRow(node: FileTreeNode, isExpanded: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(start = 8.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.width((14 * node.depth).dp))
        if (node.isDirectory) {
            Icon(
                Icons.Filled.ChevronRight,
                contentDescription = stringResource(
                    if (isExpanded) R.string.documents_folder_collapse else R.string.documents_folder_expand
                ),
                tint = NimbalystColors.textFaint,
                modifier = Modifier.size(22.dp).rotate(if (isExpanded) 90f else 0f),
            )
            Icon(
                if (isExpanded) Icons.Filled.Folder else Icons.Outlined.Folder,
                contentDescription = null,
                tint = NimbalystColors.primary,
                modifier = Modifier.padding(end = 6.dp).size(18.dp),
            )
            DirectoryLabel(node.displayLabel, Modifier.weight(1f))
        } else {
            Spacer(Modifier.width(22.dp))
            val style = fileIconStyle(node.displayLabel)
            Icon(style.icon, contentDescription = null, tint = style.color, modifier = Modifier.padding(end = 6.dp).size(18.dp))
            Text(
                node.displayLabel,
                fontSize = 14.sp,
                color = NimbalystColors.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        if (node.isDirectory && node.fileCount > 0) {
            Text(
                node.fileCount.toString(),
                fontSize = 10.sp,
                color = NimbalystColors.textFaint,
                modifier = Modifier
                    .background(NimbalystColors.background, NimbalystShapes.capsule)
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        } else if (node.lastModifiedAt != null) {
            Text(RelativeTimestamp.format(node.lastModifiedAt), fontSize = 11.sp, color = NimbalystColors.textDisabled)
        }
    }
}

/** Ancestor segments of a collapsed chain are faint; the last one reads as the folder name. */
@Composable
private fun DirectoryLabel(label: String, modifier: Modifier) {
    val parts = label.split('/')
    val text = buildAnnotatedString {
        parts.forEachIndexed { index, part ->
            if (index > 0) withStyle(SpanStyle(color = NimbalystColors.textDisabled, fontSize = 11.sp)) { append(" / ") }
            withStyle(SpanStyle(color = if (index == parts.lastIndex) NimbalystColors.text else NimbalystColors.textFaint)) {
                append(part)
            }
        }
    }
    Text(text, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = modifier)
}

internal data class FileIconStyle(val icon: ImageVector, val color: Color)

private val TypeScriptBlue = Color(0xFF3178C6)

/** Per-extension icon and color, matching iOS `FileTreeRow`. */
internal fun fileIconStyle(fileName: String): FileIconStyle {
    val ext = fileName.substringAfterLast('.', missingDelimiterValue = "").lowercase()
    return when (ext) {
        "md", "markdown" -> FileIconStyle(Icons.Outlined.Description, NimbalystColors.textMuted)
        "swift" -> FileIconStyle(Icons.Outlined.Code, NimbalystColors.error)
        "ts", "tsx" -> FileIconStyle(Icons.Outlined.Code, TypeScriptBlue)
        "js", "jsx" -> FileIconStyle(Icons.Outlined.Code, NimbalystColors.warning)
        "json" -> FileIconStyle(Icons.Outlined.DataObject, NimbalystColors.warning)
        "css", "scss" -> FileIconStyle(Icons.Outlined.Brush, NimbalystColors.purple)
        "yaml", "yml" -> FileIconStyle(Icons.AutoMirrored.Outlined.List, NimbalystColors.success)
        "html" -> FileIconStyle(Icons.Outlined.Language, NimbalystColors.primary)
        else -> FileIconStyle(Icons.AutoMirrored.Outlined.InsertDriveFile, NimbalystColors.textFaint)
    }
}
