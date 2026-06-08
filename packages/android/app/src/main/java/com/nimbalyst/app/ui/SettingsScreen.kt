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
