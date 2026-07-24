package com.nimbalyst.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Card
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.ui.components.ConnectionIndicator
import com.nimbalyst.app.utils.RelativeTimestamp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProjectListScreen(navController: NavController) {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    val projects by app.repository.observeProjects().collectAsState(initial = emptyList())
    val syncState by app.syncManager.state.collectAsState()
    val connectedDevices by app.syncManager.connectedDevices.collectAsState()
    var isRefreshing by remember { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()

    Column(modifier = Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text("Nimbalyst") },
            navigationIcon = {
                IconButton(onClick = { navController.navigate("settings") }) {
                    Icon(Icons.Default.Settings, contentDescription = "Settings")
                }
            },
            actions = {
                ConnectionIndicator(
                    syncState = syncState,
                    connectedDevices = connectedDevices,
                    modifier = Modifier.padding(end = 16.dp)
                )
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
            if (projects.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "No projects yet. Projects will appear once synced from your Mac.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    items(projects, key = { it.id }) { project ->
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    val encodedId = URLEncoder.encode(project.id, StandardCharsets.UTF_8.toString())
                                    val encodedName = URLEncoder.encode(project.name, StandardCharsets.UTF_8.toString())
                                    navController.navigate("sessions?projectId=$encodedId&name=$encodedName")
                                }
                        ) {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(
                                        text = project.name,
                                        style = MaterialTheme.typography.titleMedium
                                    )
                                    if (project.sessionCount > 0) {
                                        Text(
                                            text = "${project.sessionCount} session${if (project.sessionCount != 1) "s" else ""}",
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            modifier = Modifier.padding(top = 4.dp)
                                        )
                                    }
                                }
                                project.lastUpdatedAt?.let { ts ->
                                    Text(
                                        text = RelativeTimestamp.format(ts),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
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
