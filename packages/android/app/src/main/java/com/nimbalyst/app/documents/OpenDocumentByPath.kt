package com.nimbalyst.app.documents

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.nimbalyst.app.R
import com.nimbalyst.app.ui.components.NimbalystSecondaryButton
import com.nimbalyst.app.ui.theme.NimbalystColors

sealed interface OpenDocumentResult {
    data class Ready(val relativePath: String) : OpenDocumentResult
    /** The path is not inside the session's project, so it can never sync. */
    data object OutsideProject : OpenDocumentResult
    /** Inside the project, but it did not arrive before the timeout. */
    data object NotSynced : OpenDocumentResult
}

/** [filePath] relative to the project root ([projectId] is the workspace path), or null when outside it. */
fun relativePathInProject(projectId: String, filePath: String): String? {
    val root = projectId.trimEnd('/')
    if (root.isEmpty() || !filePath.startsWith("$root/")) return null
    return filePath.removePrefix("$root/").takeIf { it.isNotEmpty() }
}

/**
 * Resolves a transcript `open_file` path to a synced document, connecting the
 * project's room and waiting for it when it is not cached yet (a file the
 * session just wrote). Mirrors iOS `SessionDetailView.handleOpenFile`.
 */
suspend fun DocumentSyncManager.openDocumentByPath(
    projectId: String,
    filePath: String,
    timeoutMs: Long = 8_000L,
): OpenDocumentResult {
    val relativePath = relativePathInProject(projectId, filePath) ?: return OpenDocumentResult.OutsideProject
    return if (awaitDocument(projectId, relativePath, timeoutMs) != null) {
        OpenDocumentResult.Ready(relativePath)
    } else {
        OpenDocumentResult.NotSynced
    }
}

/**
 * A full-screen editor for a transcript `open_file` tap. Shows "Syncing this
 * file…" while the file is fetched, then the editor, or why it cannot open.
 */
@Composable
fun DocumentFileSheet(projectId: String, filePath: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val manager = remember { Documents.manager(context) }
    var result by remember(projectId, filePath) { mutableStateOf<OpenDocumentResult?>(null) }

    LaunchedEffect(projectId, filePath) {
        result = manager.openDocumentByPath(projectId, filePath)
    }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(modifier = Modifier.fillMaxSize().background(NimbalystColors.backgroundSecondary)) {
            when (val current = result) {
                is OpenDocumentResult.Ready -> DocumentEditorScreen(projectId, current.relativePath, onBack = onDismiss)
                null -> Status(stringResource(R.string.open_file_syncing), progress = true, onDismiss)
                OpenDocumentResult.NotSynced -> Status(stringResource(R.string.open_file_not_synced), progress = false, onDismiss)
                OpenDocumentResult.OutsideProject -> Status(stringResource(R.string.open_file_outside_project), progress = false, onDismiss)
            }
        }
    }
}

@Composable
private fun Status(text: String, progress: Boolean, onDismiss: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        if (progress) CircularProgressIndicator(color = NimbalystColors.primary)
        Text(text, color = NimbalystColors.textMuted, textAlign = TextAlign.Center)
        NimbalystSecondaryButton(text = stringResource(R.string.open_file_close), onClick = onDismiss)
    }
}
