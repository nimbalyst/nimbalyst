package com.nimbalyst.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.pairing.QRPairingData
import com.nimbalyst.app.sync.SyncedProviderUsage
import com.nimbalyst.app.sync.SyncedTokenUsage
import com.nimbalyst.app.sync.SyncedUsageWindow
import java.text.NumberFormat
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSignOut: () -> Unit,
    onUnpair: () -> Unit
) {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    val pairingState by app.pairingStore.state.collectAsState()
    val syncState by app.syncManager.state.collectAsState()
    val connectedDevices by app.syncManager.connectedDevices.collectAsState()
    val planUsage by app.syncManager.planUsage.collectAsState()
    val coroutineScope = rememberCoroutineScope()

    // Dev section: tap version label 7 times to reveal
    var devTapCount by remember { mutableIntStateOf(0) }
    var showDevSection by remember { mutableStateOf(false) }

    // Dev section state
    var showQrScanner by remember { mutableStateOf(false) }
    var qrPayload by remember { mutableStateOf("") }
    var devMessage by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .navigationBarsPadding()
            .verticalScroll(rememberScrollState())
    ) {
        TopAppBar(
            title = { Text("Settings") },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                }
            }
        )

        // Account section
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
                    text = "Account",
                    style = MaterialTheme.typography.titleMedium
                )

                pairingState.credentials?.let { credentials ->
                    if (!credentials.authEmail.isNullOrBlank()) {
                        Text(
                            text = credentials.authEmail!!,
                            style = MaterialTheme.typography.bodyLarge
                        )
                    }
                    Text(
                        text = "Server: ${credentials.serverUrl}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Text(
                    text = "Sync: ${syncState.statusLabel}",
                    style = MaterialTheme.typography.bodyMedium
                )
                syncState.lastError?.let { error ->
                    Text(
                        text = error,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
            }
        }

        // Connected devices section
        if (connectedDevices.isNotEmpty()) {
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Text(
                        text = "Connected Devices",
                        style = MaterialTheme.typography.titleMedium
                    )
                    connectedDevices.forEach { device ->
                        Text(
                            text = "${device.name} (${device.platform})",
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }
        }

        // Plan usage section (synced from the desktop usage trackers)
        planUsage?.let { usage ->
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
            ) {
                Column(
                    modifier = Modifier.padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text(
                        text = "Plan Usage",
                        style = MaterialTheme.typography.titleMedium
                    )
                    usage.claude?.let { ProviderUsageBlock(name = "Claude", usage = it) }
                    usage.codex?.let { ProviderUsageBlock(name = "Codex", usage = it) }
                    usage.fugu?.let { ProviderUsageBlock(name = "Fugu", usage = it) }
                }
            }
        }

        // Analytics section
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
                    text = "Analytics",
                    style = MaterialTheme.typography.titleMedium
                )
                var analyticsEnabled by remember { mutableStateOf(AnalyticsManager.isEnabled) }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Send anonymous usage data",
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = "Help improve Nimbalyst with anonymous analytics. No session content is collected.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Switch(
                        checked = analyticsEnabled,
                        onCheckedChange = { enabled ->
                            analyticsEnabled = enabled
                            if (enabled) AnalyticsManager.optIn() else AnalyticsManager.optOut()
                        }
                    )
                }
            }
        }

        // Sign out / Unpair section
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp)
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                OutlinedButton(
                    onClick = onSignOut,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Sign Out")
                }

                Button(
                    onClick = onUnpair,
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error
                    )
                ) {
                    Text("Unpair Device")
                }
            }
        }

        // Version label (tap to reveal dev section)
        val packageInfo = remember {
            runCatching {
                context.packageManager.getPackageInfo(context.packageName, 0)
            }.getOrNull()
        }
        Text(
            text = "Nimbalyst Android v${packageInfo?.versionName ?: "dev"}",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .padding(16.dp)
                .clickable {
                    devTapCount++
                    if (devTapCount >= 7) {
                        showDevSection = true
                    }
                }
        )

        // Hidden dev/debug section
        if (showDevSection) {
            HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))

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
                        text = "Developer",
                        style = MaterialTheme.typography.titleMedium
                    )

                    OutlinedButton(
                        onClick = { app.syncManager.requestFullSync() },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Force Full Sync")
                    }

                    OutlinedTextField(
                        value = qrPayload,
                        onValueChange = { qrPayload = it },
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("QR payload or nimbalyst://pair link") },
                        minLines = 3
                    )
                    OutlinedButton(
                        onClick = {
                            val parsed = QRPairingData.parse(qrPayload)
                            if (parsed == null) {
                                devMessage = "Invalid QR payload."
                            } else {
                                AnalyticsManager.setDistinctIdFromPairing(parsed.analyticsId)
                                val existing = pairingState.credentials
                                if (existing != null) {
                                    app.pairingStore.savePairing(
                                        existing.copy(
                                            serverUrl = parsed.serverUrl,
                                            encryptionSeed = parsed.seed,
                                            pairedUserId = parsed.userId,
                                            personalOrgId = parsed.personalOrgId,
                                            personalUserId = parsed.personalUserId
                                        )
                                    )
                                }
                                devMessage = "Imported pairing payload."
                            }
                        },
                        enabled = qrPayload.isNotBlank(),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Import pairing payload")
                    }
                    OutlinedButton(
                        onClick = { showQrScanner = !showQrScanner },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(if (showQrScanner) "Hide QR scanner" else "Scan pairing QR")
                    }

                    if (showQrScanner) {
                        PairingQrScanner(
                            onScanned = { rawValue ->
                                val parsed = QRPairingData.parse(rawValue)
                                if (parsed == null) {
                                    devMessage = "Invalid pairing QR code."
                                } else {
                                    AnalyticsManager.setDistinctIdFromPairing(parsed.analyticsId)
                                    devMessage = "Scanned pairing payload."
                                    showQrScanner = false
                                }
                            },
                            onCancel = { showQrScanner = false }
                        )
                    }

                    devMessage?.let { msg ->
                        Text(
                            text = msg,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(32.dp))
    }
}

@Composable
private fun ProviderUsageBlock(name: String, usage: SyncedProviderUsage) {
    val limitsUnavailable = usage.limitsAvailable == false
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = name,
            style = MaterialTheme.typography.titleSmall
        )
        if (!limitsUnavailable) {
            usage.fiveHour?.let { UsageWindowRow(label = "5-hour", window = it) }
            usage.sevenDay?.let { UsageWindowRow(label = "7-day", window = it) }
            usage.sevenDayOpus?.let { UsageWindowRow(label = "7-day Opus", window = it) }
        } else {
            val message = if (usage.accountUsageConfigured == true && !usage.accountUsageError.isNullOrBlank()) {
                "Account limits unavailable: ${usage.accountUsageError}"
            } else {
                "Account limits unavailable; showing local token usage when available."
            }
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        usage.credits?.let { credits ->
            val label = when {
                credits.unlimited -> "Credits: unlimited"
                credits.balance != null -> "Credits: %.2f".format(credits.balance)
                credits.hasCredits -> "Credits available"
                else -> null
            }
            label?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        usage.tokenUsage?.let { TokenUsageRows(it) }
        usage.lastUpdated?.let { ts ->
            Text(
                text = "Updated ${formatAgo(ts)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun TokenUsageRows(usage: SyncedTokenUsage) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        usage.inputTokens?.let { SmallUsageRow(label = "Input tokens", value = formatTokenCount(it)) }
        usage.outputTokens?.let { SmallUsageRow(label = "Output tokens", value = formatTokenCount(it)) }
        usage.totalTokens?.let { SmallUsageRow(label = "Total tokens", value = formatTokenCount(it)) }
        usage.sessionCount?.let { SmallUsageRow(label = "Sessions", value = it.toString()) }
    }
}

@Composable
private fun SmallUsageRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodySmall
        )
    }
}

@Composable
private fun UsageWindowRow(label: String, window: SyncedUsageWindow) {
    val fraction = (window.utilization / 100.0).coerceIn(0.0, 1.0).toFloat()
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "$label — ${window.utilization.toInt()}%",
                style = MaterialTheme.typography.bodySmall
            )
            val resetsText = window.resetsAt?.let { formatResetsIn(it) }.orEmpty()
            if (resetsText.isNotBlank()) {
                Text(
                    text = resetsText,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth()
        )
    }
}

private fun formatTokenCount(value: Long): String {
    return NumberFormat.getIntegerInstance().format(value)
}

private fun formatResetsIn(resetsAtIso: String): String {
    return try {
        val resetMs = java.time.Instant.parse(resetsAtIso).toEpochMilli()
        val deltaMin = ((resetMs - System.currentTimeMillis()) / 60_000L).coerceAtLeast(0)
        val hours = deltaMin / 60
        val minutes = deltaMin % 60
        if (hours > 0) "resets in ${hours}h ${minutes}m" else "resets in ${minutes}m"
    } catch (_: Exception) {
        ""
    }
}

private fun formatAgo(timestampMs: Long): String {
    val deltaMin = ((System.currentTimeMillis() - timestampMs) / 60_000L).coerceAtLeast(0)
    return when {
        deltaMin < 1 -> "just now"
        deltaMin < 60 -> "${deltaMin}m ago"
        else -> "${deltaMin / 60}h ago"
    }
}
