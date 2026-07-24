package com.nimbalyst.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectsScreen() {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    val projects by app.repository.observeProjects().collectAsState(initial = emptyList())
    val syncState by app.syncManager.state.collectAsState()
    val createSessionPrompt = remember { mutableStateOf("") }
    val projectMessage = remember { mutableStateOf<String?>(null) }
    val coroutineScope = rememberCoroutineScope()
    var isRefreshing by remember { mutableStateOf(false) }

    Column(modifier = Modifier.fillMaxSize()) {
        ScreenScaffold(title = "Projects")

        projects.firstOrNull()?.let { project ->
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Text(
                        text = "Request new desktop session",
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(
                        text = "Target project: ${project.name}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedTextField(
                        value = createSessionPrompt.value,
                        onValueChange = { createSessionPrompt.value = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Optional initial prompt") },
                        minLines = 2
                    )
                    Button(
                        onClick = {
                            coroutineScope.launch {
                                val result = app.syncManager.createSession(
                                    projectId = project.id,
                                    initialPrompt = createSessionPrompt.value.ifBlank { null }
                                )
                                projectMessage.value = result.exceptionOrNull()?.message
                                    ?: "Session request sent to desktop."
                                if (result.isSuccess) {
                                    AnalyticsManager.capture("mobile_session_created")
                                    createSessionPrompt.value = ""
                                }
                            }
                        },
                        enabled = syncState.indexConnected
                    ) {
                        Text("Create session on desktop")
                    }
                    projectMessage.value?.let { message ->
                        Text(
                            text = message,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (resultLooksLikeError(message)) {
                                MaterialTheme.colorScheme.error
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            }
                        )
                    }
                }
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
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                items(projects, key = { it.id }) { project ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Text(text = project.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                text = "${project.sessionCount} sessions",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(top = 6.dp)
                            )
                            project.lastUpdatedAt?.let { lastUpdatedAt ->
                                Text(
                                    text = "Last updated: $lastUpdatedAt",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(top = 6.dp)
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun resultLooksLikeError(message: String): Boolean {
    return message.contains("failed", ignoreCase = true) ||
        message.contains("not connected", ignoreCase = true) ||
        message.contains("rejected", ignoreCase = true)
}
