package com.nimbalyst.app.ui.sessionlist

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.CallSplit
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.automirrored.outlined.DriveFileMove
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.CreateNewFolder
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Unarchive
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.R
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.sync.SessionCreationOptions
import com.nimbalyst.app.ui.navigation.WorkspaceNavigation
import kotlinx.coroutines.launch

enum class CreateKind { SESSION, WORKSTREAM, META_AGENT }

/** The create request iOS `SessionListView` sends for each "+" entry. */
internal fun creationOptions(
    kind: CreateKind,
    projectId: String,
    modelId: String?,
    targetDeviceId: String?,
    parentSessionId: String? = null,
) = SessionCreationOptions(
    projectId = projectId,
    sessionType = if (kind == CreateKind.WORKSTREAM) SessionListGrouping.WORKSTREAM_TYPE else null,
    parentSessionId = parentSessionId,
    provider = providerFromModelId(modelId),
    model = modelId,
    agentRole = if (kind == CreateKind.META_AGENT) SessionListGrouping.META_AGENT_ROLE else null,
    targetDeviceId = targetDeviceId,
)

/**
 * Session list mutations. Creation is awaited in [WorkspaceNavigation] so the result
 * survives the list leaving the screen; the rest are fire-and-forget on the app scope,
 * and a failed send surfaces through the sync error banner.
 */
internal class SessionListActions(
    private val app: NimbalystApplication,
    private val navigation: WorkspaceNavigation,
    private val projectId: String,
    private val targetDeviceId: String?,
    private val failureFallback: String,
) {
    fun create(
        kind: CreateKind,
        modelId: String?,
        parentSessionId: String? = null,
        navigate: Boolean = true,
        onCreated: suspend (String) -> Unit = {},
    ) {
        val options = creationOptions(kind, projectId, modelId, targetDeviceId, parentSessionId)
        app.syncManager.createSession(options).fold(
            onSuccess = { requestId ->
                AnalyticsManager.capture(
                    when {
                        parentSessionId != null -> "mobile_child_session_created"
                        kind == CreateKind.WORKSTREAM -> "mobile_workstream_created"
                        kind == CreateKind.META_AGENT -> "mobile_meta_agent_created"
                        else -> "mobile_session_created"
                    },
                    mapOf("model" to (modelId ?: "default"))
                )
                navigation.trackCreation(requestId, navigate, app.syncManager::awaitSessionCreation, onCreated)
            },
            onFailure = { navigation.reportCreationFailure(it.message ?: failureFallback) }
        )
    }

    /** The worktree session arrives through the index; refusals and timeouts use the sync banner. */
    fun createWorktree() {
        app.syncManager.createWorktree(projectId, targetDeviceId).fold(
            onSuccess = { AnalyticsManager.capture("mobile_worktree_created") },
            onFailure = { navigation.reportCreationFailure(it.message ?: failureFallback) }
        )
    }

    /** Create a workstream, then move [session] into it once the desktop confirms. */
    fun startWorkstream(session: SessionEntity) {
        AnalyticsManager.capture("mobile_convert_to_workstream")
        create(CreateKind.WORKSTREAM, modelId = null, navigate = false) { workstreamId ->
            app.syncManager.updateSessionParent(session.id, workstreamId)
        }
    }

    fun moveToWorkstream(sessionId: String, workstreamId: String) {
        app.applicationScope.launch { app.syncManager.updateSessionParent(sessionId, workstreamId) }
    }

    fun setArchived(sessionIds: List<String>, archived: Boolean) {
        AnalyticsManager.capture(if (archived) "mobile_session_archived" else "mobile_session_unarchived")
        app.applicationScope.launch { sessionIds.forEach { app.syncManager.setSessionArchived(it, archived) } }
    }

    /** Local only, as on iOS: removes this device's copy. */
    fun delete(sessionIds: List<String>) {
        app.applicationScope.launch { sessionIds.forEach { app.repository.deleteSession(it) } }
    }
}

/** What a long-press offers, per row kind (iOS context menus). */
internal enum class RowAction { ADD_SESSION, START_WORKSTREAM, MOVE_TO_WORKSTREAM, ARCHIVE, UNARCHIVE, DELETE }

internal fun rowActions(group: SessionListGrouping.Group, hasWorkstreams: Boolean): List<RowAction> {
    val archive = if (group.parent.isArchived) RowAction.UNARCHIVE else RowAction.ARCHIVE
    return when (group.kind) {
        GroupKind.STANDALONE -> listOfNotNull(
            RowAction.START_WORKSTREAM,
            RowAction.MOVE_TO_WORKSTREAM.takeIf { hasWorkstreams },
            archive,
            RowAction.DELETE,
        )
        GroupKind.WORKSTREAM -> listOf(RowAction.ADD_SESSION, archive, RowAction.DELETE)
        GroupKind.WORKTREE -> listOf(archive, RowAction.DELETE)
    }
}

/** Groups act on every member; a standalone row on itself. */
internal fun actionTargets(group: SessionListGrouping.Group): List<String> = when (group.kind) {
    GroupKind.WORKTREE -> group.sessionIds
    else -> listOf(group.parent.id)
}

@Composable
internal fun RowActionsMenu(
    expanded: Boolean,
    group: SessionListGrouping.Group,
    hasWorkstreams: Boolean,
    onDismiss: () -> Unit,
    onAction: (RowAction) -> Unit,
) {
    val isGroup = group.kind == GroupKind.WORKTREE
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        rowActions(group, hasWorkstreams).forEach { action ->
            if (action == RowAction.ARCHIVE || action == RowAction.UNARCHIVE) HorizontalDivider()
            val (label, icon) = when (action) {
                RowAction.ADD_SESSION -> R.string.session_action_add_session to Icons.Outlined.AddComment
                RowAction.START_WORKSTREAM -> R.string.session_action_start_workstream to Icons.Outlined.CreateNewFolder
                RowAction.MOVE_TO_WORKSTREAM -> R.string.session_action_move_to_workstream to Icons.AutoMirrored.Outlined.DriveFileMove
                RowAction.ARCHIVE -> (if (isGroup) R.string.session_action_archive_group else R.string.session_action_archive) to Icons.Outlined.Archive
                RowAction.UNARCHIVE -> (if (isGroup) R.string.session_action_unarchive_group else R.string.session_action_unarchive) to Icons.Outlined.Unarchive
                RowAction.DELETE -> (if (isGroup) R.string.session_action_delete_group else R.string.session_action_delete) to Icons.Outlined.Delete
            }
            val color = if (action == RowAction.DELETE) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
            DropdownMenuItem(
                text = { Text(stringResource(label), color = color) },
                leadingIcon = { Icon(icon, contentDescription = null, tint = color) },
                onClick = { onDismiss(); onAction(action) }
            )
        }
    }
}

@Composable
internal fun CreateMenu(
    expanded: Boolean,
    metaAgentEnabled: Boolean,
    onDismiss: () -> Unit,
    onCreate: (CreateKind) -> Unit,
    onCreateWorktree: () -> Unit,
) {
    @Composable
    fun Item(label: Int, icon: ImageVector, onClick: () -> Unit) = DropdownMenuItem(
        text = { Text(stringResource(label)) },
        leadingIcon = { Icon(icon, contentDescription = null) },
        onClick = { onDismiss(); onClick() }
    )
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        Item(R.string.session_list_new_session, Icons.AutoMirrored.Outlined.Chat) { onCreate(CreateKind.SESSION) }
        Item(R.string.session_list_new_worktree, Icons.AutoMirrored.Filled.CallSplit, onCreateWorktree)
        Item(R.string.session_list_new_workstream, Icons.Outlined.CreateNewFolder) { onCreate(CreateKind.WORKSTREAM) }
        if (metaAgentEnabled) {
            Item(R.string.session_list_new_meta_agent, Icons.Outlined.Hub) { onCreate(CreateKind.META_AGENT) }
        }
    }
}

@Composable
internal fun MoveToWorkstreamDialog(
    workstreams: List<SessionEntity>,
    onPick: (SessionEntity) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.session_action_move_to_workstream)) },
        text = {
            LazyColumn(modifier = Modifier.heightIn(max = 400.dp)) {
                items(workstreams, key = { it.id }) { ws ->
                    Text(
                        text = ws.titleDecrypted ?: stringResource(R.string.session_list_workstream),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(ws) }
                            .padding(vertical = 12.dp)
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.session_action_cancel)) } }
    )
}
