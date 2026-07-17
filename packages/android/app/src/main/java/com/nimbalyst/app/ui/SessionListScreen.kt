package com.nimbalyst.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.ui.components.ConnectionIndicator
import com.nimbalyst.app.utils.RelativeTimestamp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Calendar

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
    var isRefreshing by remember { mutableStateOf(false) }
    var showCreateMenu by remember { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
    ) {
        TopAppBar(
            title = { Text(projectName, maxLines = 1, overflow = TextOverflow.Ellipsis) },
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
                Box {
                    IconButton(onClick = { showCreateMenu = true }) {
                        Icon(Icons.Default.Add, contentDescription = "New session")
                    }
                    DropdownMenu(
                        expanded = showCreateMenu,
                        onDismissRequest = { showCreateMenu = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text("New Session") },
                            onClick = {
                                showCreateMenu = false
                                coroutineScope.launch {
                                    val result = app.syncManager.createSession(projectId)
                                    if (result.isSuccess) {
                                        AnalyticsManager.capture("mobile_session_created")
                                    }
                                }
                            }
                        )
                    }
                }
            }
        )

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
                // Interleave workstreams and standalone sessions in one list, bucketed by
                // time period (matches iOS SessionListView -- no separate Workstreams section).
                val timeGrouped = SessionListGrouping.groupByTime(
                    SessionListGrouping.buildItems(sessions)
                )

                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    timeGrouped.forEach { (label, groupItems) ->
                        item(key = "header-$label") {
                            Text(
                                text = label,
                                style = MaterialTheme.typography.labelLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 12.dp, bottom = 4.dp)
                            )
                        }
                        items(groupItems, key = { it.key }) { item ->
                            when (item) {
                                is SessionListGrouping.Item.Standalone -> SessionRow(
                                    session = item.session,
                                    onClick = { navController.navigate("sessions/${item.session.id}") }
                                )
                                is SessionListGrouping.Item.Workstream -> WorkstreamGroup(
                                    parent = item.parent,
                                    children = item.children,
                                    onSessionClick = { sessionId ->
                                        navController.navigate("sessions/$sessionId")
                                    }
                                )
                            }
                        }
                    }

                    item { Spacer(modifier = Modifier.height(16.dp)) }
                }
            }
        }
    }
}

@Composable
private fun SessionRow(
    session: SessionEntity,
    onClick: () -> Unit
) {
    val hasUnread = session.lastMessageAt != null &&
        (session.lastReadAt == null || session.lastMessageAt > session.lastReadAt)

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (hasUnread) {
                Box(
                    modifier = Modifier
                        .padding(end = 12.dp)
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                )
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = session.titleDecrypted ?: "Untitled session",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = if (hasUnread) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                Row(
                    modifier = Modifier.padding(top = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "${session.provider ?: "unknown"} -- ${session.mode ?: "agent"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    session.phase?.let { phase ->
                        Text(
                            text = phase,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }
            Column(
                horizontalAlignment = Alignment.End
            ) {
                Text(
                    text = RelativeTimestamp.format(session.updatedAt),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (session.isExecuting) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .padding(top = 4.dp)
                            .size(14.dp),
                        strokeWidth = 2.dp
                    )
                }
            }
        }
    }
}

@Composable
private fun WorkstreamGroup(
    parent: SessionEntity,
    children: List<SessionEntity>,
    onSessionClick: (String) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded }
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = Icons.Default.Folder,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp)
                )
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .padding(horizontal = 12.dp)
                ) {
                    Text(
                        text = parent.titleDecrypted ?: "Untitled workstream",
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Text(
                        text = "${children.size} sessions",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Icon(
                    imageVector = if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                    contentDescription = if (expanded) "Collapse" else "Expand"
                )
            }

            AnimatedVisibility(visible = expanded) {
                Column(modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp)) {
                    children.sortedByDescending { it.updatedAt }.forEach { child ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp)
                                .clickable { onSessionClick(child.id) }
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                val childUnread = child.lastMessageAt != null &&
                                    (child.lastReadAt == null || child.lastMessageAt > child.lastReadAt)
                                if (childUnread) {
                                    Box(
                                        modifier = Modifier
                                            .padding(end = 8.dp)
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(MaterialTheme.colorScheme.primary)
                                    )
                                }
                                Text(
                                    text = child.titleDecrypted ?: "Untitled",
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f)
                                )
                                if (child.isExecuting) {
                                    CircularProgressIndicator(
                                        modifier = Modifier
                                            .padding(start = 8.dp)
                                            .size(14.dp),
                                        strokeWidth = 2.dp
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Pure grouping logic for the session list, matching iOS `SessionListView`:
 * workstream groups and standalone sessions are interleaved into a single list and
 * bucketed by relative time period using each item's last-update timestamp. A workstream's
 * timestamp is its newest child's `updatedAt` (falling back to the parent), so an active
 * workstream floats up next to recently-touched standalone sessions instead of being pinned
 * to a separate section.
 */
internal object SessionListGrouping {
    sealed interface Item {
        val effectiveUpdatedAt: Long
        val key: String

        data class Standalone(val session: SessionEntity) : Item {
            override val effectiveUpdatedAt: Long get() = session.updatedAt
            override val key: String get() = session.id
        }

        data class Workstream(
            val parent: SessionEntity,
            val children: List<SessionEntity>
        ) : Item {
            override val effectiveUpdatedAt: Long
                get() = children.maxOfOrNull { it.updatedAt } ?: parent.updatedAt
            override val key: String get() = "ws-${parent.id}"
        }
    }

    /**
     * Partition raw sessions into standalone rows and workstream groups. Workstream parents are
     * `sessionType == "workstream"`; a session with a non-blank `parentSessionId` is a child of
     * its parent. Everything else is standalone. Children are sorted newest-first.
     */
    fun buildItems(sessions: List<SessionEntity>): List<Item> {
        val workstreamParents = sessions.filter { it.sessionType == "workstream" }
        val childSessionsByParent = sessions
            .filter { !it.parentSessionId.isNullOrBlank() }
            .groupBy { it.parentSessionId!! }
        val claimedIds = buildSet {
            workstreamParents.forEach { add(it.id) }
            sessions.filter { !it.parentSessionId.isNullOrBlank() }.forEach { add(it.id) }
        }

        val items = mutableListOf<Item>()
        sessions.filter { it.id !in claimedIds }.forEach { items.add(Item.Standalone(it)) }
        workstreamParents.forEach { parent ->
            items.add(
                Item.Workstream(
                    parent = parent,
                    children = (childSessionsByParent[parent.id] ?: emptyList())
                        .sortedByDescending { it.updatedAt }
                )
            )
        }
        return items
    }

    /**
     * Bucket interleaved items by relative time period using `effectiveUpdatedAt`, newest
     * bucket first, newest item first within each bucket. Empty buckets are omitted.
     */
    fun groupByTime(
        items: List<Item>,
        now: Calendar = Calendar.getInstance()
    ): List<Pair<String, List<Item>>> {
        val today = (now.clone() as Calendar).apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        val yesterday = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -1) }
        val thisWeek = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -7) }
        val lastWeek = (today.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, -14) }
        val thisMonth = (today.clone() as Calendar).apply { add(Calendar.MONTH, -1) }

        val groups = linkedMapOf<String, MutableList<Item>>()

        items.sortedByDescending { it.effectiveUpdatedAt }.forEach { item ->
            val label = when {
                item.effectiveUpdatedAt >= today.timeInMillis -> "Today"
                item.effectiveUpdatedAt >= yesterday.timeInMillis -> "Yesterday"
                item.effectiveUpdatedAt >= thisWeek.timeInMillis -> "This Week"
                item.effectiveUpdatedAt >= lastWeek.timeInMillis -> "Last Week"
                item.effectiveUpdatedAt >= thisMonth.timeInMillis -> "This Month"
                else -> "Older"
            }
            groups.getOrPut(label) { mutableListOf() }.add(item)
        }

        return groups.map { (label, list) -> label to list.toList() }
    }
}
