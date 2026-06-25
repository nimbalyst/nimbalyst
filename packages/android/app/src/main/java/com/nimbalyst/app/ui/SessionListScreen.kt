package com.nimbalyst.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.sync.SyncedAvailableModel
import com.nimbalyst.app.ui.components.ConnectionIndicator
import com.nimbalyst.app.utils.RelativeTimestamp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Calendar

internal fun nestedWorkstreamChildIds(sessions: List<SessionEntity>): Set<String> {
    val workstreamParentIds = sessions
        .filter { it.sessionType == "workstream" }
        .mapTo(mutableSetOf()) { it.id }
    if (workstreamParentIds.isEmpty()) return emptySet()

    return sessions
        .asSequence()
        .filter { it.parentSessionId in workstreamParentIds }
        .mapTo(mutableSetOf()) { it.id }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    projectId: String,
    projectName: String,
    navController: NavController
) {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    val sessions by app.repository.observeSessionsForProject(projectId)
        .collectAsState(initial = emptyList())
    val syncState by app.syncManager.state.collectAsState()
    val connectedDevices by app.syncManager.connectedDevices.collectAsState()
    val availableModels by app.syncManager.availableModels.collectAsState()
    val desktopDefaultModel by app.syncManager.desktopDefaultModel.collectAsState()
    var isRefreshing by remember { mutableStateOf(false) }
    var showModelPicker by remember { mutableStateOf(false) }
    var selectedCreateModelId by remember { mutableStateOf<String?>(null) }
    var isCreatingSession by remember { mutableStateOf(false) }
    var createSessionError by remember { mutableStateOf<String?>(null) }
    var sessionActionError by remember { mutableStateOf<String?>(null) }
    var sessionPendingDelete by remember { mutableStateOf<SessionEntity?>(null) }
    val coroutineScope = rememberCoroutineScope()
    val modelChoices = remember(availableModels) {
        val fallbackModels = listOf(
            SyncedAvailableModel(
                id = "openai-codex:gpt-5.5",
                name = "GPT 5.5",
                provider = "openai-codex"
            ),
            SyncedAvailableModel(
                id = "openai-codex:gpt-5",
                name = "GPT 5",
                provider = "openai-codex"
            ),
            SyncedAvailableModel(
                id = "claude-code:fable",
                name = "Claude Fable",
                provider = "claude-code"
            ),
            SyncedAvailableModel(
                id = "opencode:sakana/fugu-ultra",
                name = "Fugu Ultra",
                provider = "opencode"
            )
        )
        (availableModels + fallbackModels)
            .distinctBy { it.id }
            .sortedWith(compareBy<SyncedAvailableModel> { it.provider }.thenBy { it.name })
    }
    val defaultCreateModelId = remember(modelChoices, desktopDefaultModel) {
        val ids = modelChoices.map { it.id }.toSet()
        desktopDefaultModel?.takeIf { it in ids }
            ?: modelChoices.firstOrNull { it.id == "openai-codex:gpt-5.5" }?.id
            ?: modelChoices.firstOrNull { it.id == "openai-codex:gpt-5" }?.id
            ?: modelChoices.firstOrNull()?.id
    }
    val createSession: (SyncedAvailableModel?) -> Unit = { selectedModel ->
        if (!isCreatingSession) {
            coroutineScope.launch {
                isCreatingSession = true
                createSessionError = null
                try {
                    val result = app.syncManager.createSession(
                        projectId = projectId,
                        provider = selectedModel?.provider,
                        model = selectedModel?.id
                    )
                    result.onSuccess { sessionId ->
                        AnalyticsManager.capture("mobile_session_created")
                        navController.navigate("sessions/$sessionId")
                    }.onFailure { error ->
                        createSessionError = error.message ?: "Failed to create session."
                    }
                } finally {
                    isCreatingSession = false
                }
            }
        }
    }
    val selectedCreateModel = modelChoices.firstOrNull { it.id == selectedCreateModelId }
        ?: modelChoices.firstOrNull { it.id == defaultCreateModelId }
    val visibleError = createSessionError ?: sessionActionError
    val runSessionAction: (suspend () -> Result<Unit>) -> Unit = { action ->
        coroutineScope.launch {
            sessionActionError = null
            action().onFailure { error ->
                sessionActionError = error.message ?: "Session action failed."
            }
        }
    }

    val pinnedSessions = remember(sessions) {
        sessions.filter { it.isPinned }.sortedByDescending { it.updatedAt }
    }
    val unpinnedSessions = remember(sessions) { sessions.filterNot { it.isPinned } }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        MaterialTheme.colorScheme.surface,
                        MaterialTheme.colorScheme.background,
                        MaterialTheme.colorScheme.background
                    )
                )
            )
            .navigationBarsPadding()
    ) {
        TopAppBar(
            title = { Text(projectName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
            navigationIcon = {
                IconButton(onClick = { navController.popBackStack() }) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            },
            actions = {
                ConnectionIndicator(
                    syncState = syncState,
                    connectedDevices = connectedDevices,
                    modifier = Modifier.padding(end = 8.dp)
                )
                IconButton(
                    onClick = {
                        selectedCreateModelId = defaultCreateModelId
                        showModelPicker = true
                    },
                    enabled = syncState.indexConnected && !isCreatingSession
                ) {
                    if (isCreatingSession) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    } else {
                        Icon(Icons.Default.Add, contentDescription = "New session")
                    }
                }
            }
        )

        if (showModelPicker) {
            AlertDialog(
                onDismissRequest = {
                    if (!isCreatingSession) {
                        showModelPicker = false
                    }
                },
                title = { Text("Pick a model") },
                text = {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(max = 420.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        items(modelChoices, key = { it.id }) { model ->
                            val selected = model.id == selectedCreateModel?.id
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(16.dp))
                                    .clickable { selectedCreateModelId = model.id }
                                    .padding(horizontal = 6.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                RadioButton(
                                    selected = selected,
                                    onClick = { selectedCreateModelId = model.id }
                                )
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = model.name.ifBlank { model.id },
                                        style = MaterialTheme.typography.bodyLarge,
                                        fontWeight = FontWeight.SemiBold
                                    )
                                    Text(
                                        text = "${providerFamilyLabel(model.provider, model.id)} - ${model.id}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = selectedCreateModel != null && !isCreatingSession,
                        onClick = {
                            val model = selectedCreateModel ?: return@TextButton
                            showModelPicker = false
                            createSession(model)
                        }
                    ) {
                        Text("Create")
                    }
                },
                dismissButton = {
                    TextButton(
                        enabled = !isCreatingSession,
                        onClick = { showModelPicker = false }
                    ) {
                        Text("Cancel")
                    }
                }
            )
        }

        sessionPendingDelete?.let { session ->
            AlertDialog(
                onDismissRequest = { sessionPendingDelete = null },
                title = { Text("Delete session?") },
                text = {
                    Text(
                        text = "This removes \"${session.titleDecrypted ?: "Untitled session"}\" from desktop and mobile."
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            sessionPendingDelete = null
                            runSessionAction { app.syncManager.deleteSession(session.id) }
                        }
                    ) {
                        Text("Delete")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { sessionPendingDelete = null }) {
                        Text("Cancel")
                    }
                }
            )
        }

        AnimatedVisibility(visible = visibleError != null) {
            Surface(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                color = MaterialTheme.colorScheme.errorContainer,
                shape = RoundedCornerShape(16.dp)
            ) {
                Text(
                    text = visibleError.orEmpty(),
                    modifier = Modifier.padding(14.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }

        PullToRefreshBox(
            isRefreshing = isRefreshing,
            onRefresh = {
                isRefreshing = true
                app.syncManager.requestFullSync()
                coroutineScope.launch {
                    delay(1000)
                    isRefreshing = false
                }
            },
            modifier = Modifier.fillMaxSize()
        ) {
            if (sessions.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "No sessions yet. Start a session from your Mac, or tap + to create one.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                // Separate workstream parents and their children
                val workstreamParents = unpinnedSessions
                    .filter { it.sessionType == "workstream" }
                    .sortedByDescending { it.updatedAt }
                val nestedChildIds = nestedWorkstreamChildIds(unpinnedSessions)
                val childSessionsByParent = unpinnedSessions
                    .filter { it.id in nestedChildIds }
                    .groupBy { it.parentSessionId!! }
                val standaloneIds = buildSet {
                    workstreamParents.forEach { add(it.id) }
                    addAll(nestedChildIds)
                }
                val standaloneSessions = unpinnedSessions.filter { it.id !in standaloneIds }

                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp),
                    contentPadding = PaddingValues(bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp)
                ) {
                    item(key = "session-hero") {
                        SessionListHero(
                            projectName = projectName,
                            sessionCount = sessions.size,
                            pinnedCount = pinnedSessions.size
                        )
                    }

                    if (pinnedSessions.isNotEmpty()) {
                        item(key = "header-pinned") {
                            SectionHeader(
                                label = "Pinned",
                                count = pinnedSessions.size,
                                modifier = Modifier.padding(top = 4.dp)
                            )
                        }
                        items(pinnedSessions, key = { "pinned-${it.id}" }) { session ->
                            SessionRow(
                                session = session,
                                onClick = { navController.navigate("sessions/${session.id}") },
                                onTogglePinned = { target ->
                                    runSessionAction { app.syncManager.setSessionPinned(target.id, !target.isPinned) }
                                },
                                onArchive = { target ->
                                    runSessionAction { app.syncManager.archiveSession(target.id) }
                                },
                                onDelete = { target -> sessionPendingDelete = target },
                                onCancel = { target ->
                                    runSessionAction { app.syncManager.cancelSession(target.id) }
                                }
                            )
                        }
                    }

                    // Workstream groups at the top
                    if (workstreamParents.isNotEmpty()) {
                        item(key = "header-workstreams") {
                            SectionHeader(
                                label = "Workstreams",
                                count = workstreamParents.size,
                                modifier = Modifier.padding(top = 8.dp)
                            )
                        }
                        items(workstreamParents, key = { "ws-${it.id}" }) { parent ->
                            WorkstreamGroup(
                                parent = parent,
                                children = childSessionsByParent[parent.id] ?: emptyList(),
                                onSessionClick = { sessionId ->
                                    navController.navigate("sessions/$sessionId")
                                },
                                onTogglePinned = { target ->
                                    runSessionAction { app.syncManager.setSessionPinned(target.id, !target.isPinned) }
                                },
                                onArchive = { target ->
                                    runSessionAction { app.syncManager.archiveSession(target.id) }
                                },
                                onDelete = { target -> sessionPendingDelete = target },
                                onCancel = { target ->
                                    runSessionAction { app.syncManager.cancelSession(target.id) }
                                }
                            )
                        }
                    }

                    // Standalone sessions grouped by time
                    val timeGrouped = groupSessionsByTime(standaloneSessions)
                    timeGrouped.forEach { (label, groupSessions) ->
                        item(key = "header-$label") {
                            SectionHeader(
                                label = label,
                                count = groupSessions.size,
                                modifier = Modifier.padding(top = 8.dp)
                            )
                        }
                        items(groupSessions, key = { it.id }) { session ->
                            SessionRow(
                                session = session,
                                onClick = { navController.navigate("sessions/${session.id}") },
                                onTogglePinned = { target ->
                                    runSessionAction { app.syncManager.setSessionPinned(target.id, !target.isPinned) }
                                },
                                onArchive = { target ->
                                    runSessionAction { app.syncManager.archiveSession(target.id) }
                                },
                                onDelete = { target -> sessionPendingDelete = target },
                                onCancel = { target ->
                                    runSessionAction { app.syncManager.cancelSession(target.id) }
                                }
                            )
                        }
                    }

                    item { Spacer(modifier = Modifier.height(16.dp)) }
                }
            }
        }
    }
}

@Composable
private fun SessionListHero(
    projectName: String,
    sessionCount: Int,
    pinnedCount: Int
) {
    val primary = MaterialTheme.colorScheme.primary
    val secondary = providerAccentColor("claude-code", null)

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 4.dp, bottom = 8.dp),
        shape = RoundedCornerShape(28.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.42f),
        contentColor = MaterialTheme.colorScheme.onSurface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.18f))
    ) {
        Box(
            modifier = Modifier
                .background(
                    Brush.linearGradient(
                        listOf(
                            primary.copy(alpha = 0.22f),
                            secondary.copy(alpha = 0.14f),
                            Color.Transparent
                        )
                    )
                )
                .padding(20.dp)
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = projectName,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Black,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MetaChip("${sessionCount} session${if (sessionCount == 1) "" else "s"}")
                    if (pinnedCount > 0) {
                        MetaChip("$pinnedCount pinned", highlighted = true)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(
    label: String,
    count: Int,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(top = 4.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.onSurface
        )
        Spacer(modifier = Modifier.width(8.dp))
        Surface(
            shape = RoundedCornerShape(999.dp),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)
        ) {
            Text(
                text = count.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
            )
        }
    }
}

@Composable
private fun SessionRow(
    session: SessionEntity,
    onClick: () -> Unit,
    onTogglePinned: (SessionEntity) -> Unit,
    onArchive: (SessionEntity) -> Unit,
    onDelete: (SessionEntity) -> Unit,
    onCancel: (SessionEntity) -> Unit
) {
    val hasUnread = session.lastMessageAt != null &&
        (session.lastReadAt == null || session.lastMessageAt > session.lastReadAt)
    val accent = providerAccentColor(session.provider, session.model)

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (session.isPinned) 0.58f else 0.38f),
            contentColor = MaterialTheme.colorScheme.onSurface
        ),
        border = BorderStroke(
            width = 1.dp,
            color = if (session.isPinned) accent.copy(alpha = 0.5f) else MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.14f)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(modifier = Modifier.padding(end = 12.dp)) {
                ProviderLogo(
                    provider = session.provider,
                    model = session.model,
                    size = 44.dp
                )
                if (hasUnread) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary)
                    )
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Text(
                        text = session.titleDecrypted ?: "Untitled session",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = if (hasUnread || session.isPinned) FontWeight.Bold else FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    if (session.isPinned) {
                        Icon(
                            imageVector = Icons.Default.Star,
                            contentDescription = "Pinned",
                            modifier = Modifier.size(16.dp),
                            tint = accent
                        )
                    }
                }
                Row(
                    modifier = Modifier.padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    MetaChip(providerModelLabel(session.provider, session.model), highlighted = session.isPinned)
                    session.phase?.let { phase ->
                        MetaChip(phase)
                    }
                }
                AgentStatusInline(
                    session = session,
                    modifier = Modifier.padding(top = 8.dp)
                )
            }
            Column(
                horizontalAlignment = Alignment.End,
                modifier = Modifier.padding(start = 8.dp)
            ) {
                Text(
                    text = RelativeTimestamp.format(session.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (session.effectiveIsExecuting() && session.agentStatusDisplayLabel() != null) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .padding(top = 4.dp)
                            .size(14.dp),
                        strokeWidth = 2.dp
                    )
                }
                SessionActionsMenu(
                    session = session,
                    onTogglePinned = onTogglePinned,
                    onArchive = onArchive,
                    onDelete = onDelete,
                    onCancel = onCancel
                )
            }
        }
    }
}

@Composable
private fun SessionActionsMenu(
    session: SessionEntity,
    onTogglePinned: (SessionEntity) -> Unit,
    onArchive: (SessionEntity) -> Unit,
    onDelete: (SessionEntity) -> Unit,
    onCancel: (SessionEntity) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }

    Box {
        IconButton(onClick = { expanded = true }) {
            Icon(Icons.Default.MoreVert, contentDescription = "Session actions")
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            if (session.effectiveIsExecuting()) {
                DropdownMenuItem(
                    text = { Text("Interrupt") },
                    onClick = {
                        expanded = false
                        onCancel(session)
                    }
                )
            }
            DropdownMenuItem(
                text = { Text(if (session.isPinned) "Unpin" else "Pin") },
                onClick = {
                    expanded = false
                    onTogglePinned(session)
                }
            )
            DropdownMenuItem(
                text = { Text("Archive") },
                onClick = {
                    expanded = false
                    onArchive(session)
                }
            )
            DropdownMenuItem(
                text = { Text("Delete") },
                onClick = {
                    expanded = false
                    onDelete(session)
                }
            )
        }
    }
}

@Composable
private fun MetaChip(
    text: String,
    highlighted: Boolean = false
) {
    Surface(
        shape = RoundedCornerShape(999.dp),
        color = if (highlighted) {
            MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
        } else {
            MaterialTheme.colorScheme.surface.copy(alpha = 0.42f)
        }
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = if (highlighted) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp)
        )
    }
}

@Composable
private fun WorkstreamGroup(
    parent: SessionEntity,
    children: List<SessionEntity>,
    onSessionClick: (String) -> Unit,
    onTogglePinned: (SessionEntity) -> Unit,
    onArchive: (SessionEntity) -> Unit,
    onDelete: (SessionEntity) -> Unit,
    onCancel: (SessionEntity) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    val sortedChildren = remember(children) { children.sortedByDescending { it.updatedAt } }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.34f),
            contentColor = MaterialTheme.colorScheme.onSurface
        ),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.14f))
    ) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
                    contentColor = MaterialTheme.colorScheme.primary
                ) {
                    Icon(
                        imageVector = Icons.Default.Folder,
                        contentDescription = null,
                        modifier = Modifier
                            .padding(10.dp)
                            .size(20.dp)
                    )
                }
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 12.dp)
                ) {
                    Text(
                        text = parent.titleDecrypted ?: "Untitled workstream",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = "${sortedChildren.size} session${if (sortedChildren.size == 1) "" else "s"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = if (expanded) "Collapse" else "Expand"
                )
                SessionActionsMenu(
                    session = parent,
                    onTogglePinned = onTogglePinned,
                    onArchive = onArchive,
                    onDelete = onDelete,
                    onCancel = onCancel
                )
            }

            AnimatedVisibility(visible = expanded) {
                Column(modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
                    sortedChildren.forEach { child ->
                        ChildSessionRow(
                            child = child,
                            onClick = { onSessionClick(child.id) },
                            onTogglePinned = onTogglePinned,
                            onArchive = onArchive,
                            onDelete = onDelete,
                            onCancel = onCancel
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ChildSessionRow(
    child: SessionEntity,
    onClick: () -> Unit,
    onTogglePinned: (SessionEntity) -> Unit,
    onArchive: (SessionEntity) -> Unit,
    onDelete: (SessionEntity) -> Unit,
    onCancel: (SessionEntity) -> Unit
) {
    val childUnread = child.lastMessageAt != null &&
        (child.lastReadAt == null || child.lastMessageAt > child.lastReadAt)

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp)
            .clip(RoundedCornerShape(18.dp))
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.34f),
        contentColor = MaterialTheme.colorScheme.onSurface
    ) {
        Row(
            modifier = Modifier.padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(modifier = Modifier.padding(end = 10.dp)) {
                ProviderLogo(
                    provider = child.provider,
                    model = child.model,
                    size = 32.dp
                )
                if (childUnread) {
                    Box(
                        modifier = Modifier
                            .align(Alignment.TopEnd)
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(MaterialTheme.colorScheme.primary)
                    )
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = child.titleDecrypted ?: "Untitled",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (childUnread) FontWeight.Bold else FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = providerModelLabel(child.provider, child.model),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp)
                )
                AgentStatusInline(
                    session = child,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
            if (child.effectiveIsExecuting() && child.agentStatusDisplayLabel() != null) {
                CircularProgressIndicator(
                    modifier = Modifier
                        .padding(start = 8.dp)
                        .size(14.dp),
                    strokeWidth = 2.dp
                )
            }
            SessionActionsMenu(
                session = child,
                onTogglePinned = onTogglePinned,
                onArchive = onArchive,
                onDelete = onDelete,
                onCancel = onCancel
            )
        }
    }
}

private fun groupSessionsByTime(sessions: List<SessionEntity>): List<Pair<String, List<SessionEntity>>> {
    val today = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }
    val yesterday = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -1) }
    val thisWeek = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -7) }
    val lastWeek = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -14) }
    val thisMonth = (today.clone() as Calendar).apply { add(Calendar.MONTH, -1) }

    val groups = linkedMapOf<String, MutableList<SessionEntity>>()

    sessions.sortedByDescending { it.updatedAt }.forEach { session ->
        val label = when {
            session.updatedAt >= today.timeInMillis -> "Today"
            session.updatedAt >= yesterday.timeInMillis -> "Yesterday"
            session.updatedAt >= thisWeek.timeInMillis -> "This Week"
            session.updatedAt >= lastWeek.timeInMillis -> "Last Week"
            session.updatedAt >= thisMonth.timeInMillis -> "This Month"
            else -> "Older"
        }
        groups.getOrPut(label) { mutableListOf() }.add(session)
    }

    return groups.map { (label, list) -> label to list.toList() }
}
