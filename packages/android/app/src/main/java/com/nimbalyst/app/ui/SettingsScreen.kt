package com.nimbalyst.app.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import com.nimbalyst.app.R
import com.nimbalyst.app.sync.DeviceInfo
import com.nimbalyst.app.transcript.TranscriptExternalLinks
import com.nimbalyst.app.ui.navigation.credentialsForScannedPairing
import com.nimbalyst.app.ui.theme.NimbalystColors
import com.nimbalyst.app.utils.RelativeTimestamp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import com.nimbalyst.app.auth.AccountDeletionClient
import com.nimbalyst.app.pairing.QRPairingData
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onSignOut: () -> Unit,
    onUnpair: () -> Unit,
    onAccountDeleted: () -> Unit
) {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    val pairingState by app.pairingStore.state.collectAsState()
    val syncState by app.syncManager.state.collectAsState()
    val connectedDevices by app.syncManager.connectedDevices.collectAsState()
    val notificationState by app.notificationManager.state.collectAsState()
    val defaultModel by app.syncManager.desktopDefaultModel.collectAsState()
    val availableModels by app.syncManager.availableModels.collectAsState()
    val coroutineScope = rememberCoroutineScope()
    val notificationPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        app.notificationManager.handlePermissionResult(granted)
    }

    LaunchedEffect(Unit) {
        app.notificationManager.refreshAuthorization()
    }

    // Dev section: tap version label 7 times to reveal
    var devTapCount by remember { mutableIntStateOf(0) }
    var showDevSection by remember { mutableStateOf(false) }

    // Account deletion state
    var showDeleteAccountConfirm by remember { mutableStateOf(false) }
    var isDeletingAccount by remember { mutableStateOf(false) }
    var deleteAccountError by remember { mutableStateOf<String?>(null) }

    // Dev section state
    var showQrScanner by remember { mutableStateOf(false) }
    var qrPayload by remember { mutableStateOf("") }
    var devMessage by remember { mutableStateOf<String?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
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

        ConnectionSection(
            isConnected = syncState.indexConnected,
            serverUrl = pairingState.credentials?.serverUrl,
            devices = connectedDevices.filter { it.inventoryHidden != true }
        )

        // Account section
        pairingState.credentials?.authEmail?.takeIf { it.isNotBlank() }?.let { email ->
            SettingsCard(title = stringResource(R.string.settings_account)) {
                Text(text = email, style = MaterialTheme.typography.bodyLarge)
            }
        }

        // Default model for new sessions, as chosen on the desktop app.
        SettingsCard(title = stringResource(R.string.settings_default_model)) {
            Text(
                text = defaultModel?.let { id -> availableModels.firstOrNull { it.id == id }?.name ?: id }
                    ?: stringResource(R.string.settings_default_model_unset),
                style = MaterialTheme.typography.bodyMedium
            )
            Text(
                text = stringResource(R.string.settings_default_model_detail),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // Notifications section
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
                    text = "Notifications",
                    style = MaterialTheme.typography.titleMedium
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Push notifications",
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = notificationStatusText(
                                isEnabledInApp = notificationState.isEnabledInApp,
                                isAuthorized = notificationState.isAuthorized,
                                hasToken = !notificationState.deviceToken.isNullOrBlank(),
                                lastError = notificationState.lastError
                            ),
                            style = MaterialTheme.typography.bodySmall,
                            color = if (notificationState.lastError == null) {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            } else {
                                MaterialTheme.colorScheme.error
                            }
                        )
                    }
                    Switch(
                        checked = notificationState.isEnabledInApp,
                        onCheckedChange = { enabled ->
                            app.notificationManager.setPushEnabled(enabled)
                            if (enabled) {
                                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                                    !notificationState.isAuthorized
                                ) {
                                    notificationPermissionLauncher.launch(
                                        Manifest.permission.POST_NOTIFICATIONS
                                    )
                                }
                            } else {
                                app.syncManager.unregisterPushToken()
                            }
                        }
                    )
                }
                if (notificationState.isEnabledInApp && !notificationState.isAuthorized) {
                    OutlinedButton(
                        onClick = {
                            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                                data = Uri.fromParts("package", context.packageName, null)
                            }
                            context.startActivity(intent)
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Open Android Settings")
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
                TextButton(
                    onClick = {
                        TranscriptExternalLinks.open(context, PRIVACY_POLICY_URL)
                    },
                    contentPadding = PaddingValues(0.dp)
                ) {
                    Text(stringResource(R.string.settings_privacy_policy), color = NimbalystColors.primary)
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

                if (pairingState.isAuthenticated) {
                    OutlinedButton(
                        onClick = { showDeleteAccountConfirm = true },
                        enabled = !isDeletingAccount,
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = MaterialTheme.colorScheme.error
                        )
                    ) {
                        if (isDeletingAccount) {
                            CircularProgressIndicator(
                                modifier = Modifier.height(16.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.error
                            )
                        } else {
                            Text("Delete Account")
                        }
                    }

                    deleteAccountError?.let { msg ->
                        Text(
                            text = msg,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                }
            }
        }

        if (showDeleteAccountConfirm) {
            AlertDialog(
                onDismissRequest = { showDeleteAccountConfirm = false },
                title = { Text("Delete your account?") },
                text = {
                    Text(
                        "This will permanently delete your account and all synced " +
                            "data, including sessions, shared links, and device pairings. " +
                            "This cannot be undone."
                    )
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            showDeleteAccountConfirm = false
                            val credentials = pairingState.credentials
                            if (credentials == null) {
                                deleteAccountError = "Not paired."
                                return@TextButton
                            }
                            isDeletingAccount = true
                            deleteAccountError = null
                            coroutineScope.launch {
                                val result = AccountDeletionClient.deleteAccount(
                                    serverUrl = credentials.serverUrl,
                                    jwt = credentials.authJwt
                                )
                                isDeletingAccount = false
                                result.fold(
                                    onSuccess = { onAccountDeleted() },
                                    onFailure = { err ->
                                        deleteAccountError =
                                            err.message ?: "Account deletion failed"
                                    }
                                )
                            }
                        }
                    ) {
                        Text(
                            "Delete Account",
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showDeleteAccountConfirm = false }) {
                        Text("Cancel")
                    }
                }
            )
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
                                app.pairingStore.savePairing(
                                    credentialsForScannedPairing(pairingState.credentials, parsed)
                                )
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
                                    app.pairingStore.savePairing(
                                        credentialsForScannedPairing(pairingState.credentials, parsed)
                                    )
                                    devMessage = "Imported scanned pairing payload."
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

private const val PRIVACY_POLICY_URL = "https://nimbalyst.com/privacy-policy"

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text(text = title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

/** Mirrors the iOS Connection section: status, server, and the account's devices. */
@Composable
private fun ConnectionSection(isConnected: Boolean, serverUrl: String?, devices: List<DeviceInfo>) {
    SettingsCard(title = stringResource(R.string.settings_connection)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.settings_status), modifier = Modifier.weight(1f))
            StatusDot(if (isConnected) NimbalystColors.success else NimbalystColors.textDisabled)
            Text(
                text = stringResource(if (isConnected) R.string.settings_connected else R.string.settings_disconnected),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 6.dp)
            )
        }
        serverUrl?.let { url ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.settings_server), modifier = Modifier.padding(end = 16.dp))
                Text(
                    text = url,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.End,
                    modifier = Modifier.weight(1f)
                )
            }
        }
        if (devices.isNotEmpty()) {
            HorizontalDivider()
            Text(
                text = stringResource(R.string.settings_devices, devices.size),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            devices.forEach { device ->
                val online = device.isOnline != false
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(if (online) NimbalystColors.success else NimbalystColors.textDisabled)
                    Column(modifier = Modifier.padding(start = 10.dp).weight(1f)) {
                        Text(device.name, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            text = if (online) {
                                device.platform
                            } else {
                                stringResource(
                                    R.string.settings_device_last_seen,
                                    device.platform,
                                    device.lastSeenAt?.let { RelativeTimestamp.format(it) }
                                        ?: stringResource(R.string.settings_device_offline)
                                )
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatusDot(color: Color) {
    Box(
        modifier = Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(color)
    )
}

private fun notificationStatusText(
    isEnabledInApp: Boolean,
    isAuthorized: Boolean,
    hasToken: Boolean,
    lastError: String?,
): String {
    if (!isEnabledInApp) {
        return "Get notified when AI sessions complete or need your attention."
    }
    if (!isAuthorized) {
        return lastError ?: "Allow notifications in Android Settings to receive alerts."
    }
    if (lastError != null) {
        return lastError
    }
    return if (hasToken) {
        "Push is ready for session updates."
    } else {
        "Waiting for Firebase registration."
    }
}
