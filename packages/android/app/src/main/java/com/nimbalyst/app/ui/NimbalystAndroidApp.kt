package com.nimbalyst.app.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import com.nimbalyst.app.sync.ExecutionHosts
import com.nimbalyst.app.transcript.TranscriptWebViewPool
import com.nimbalyst.app.ui.navigation.AppSaveFailureBanner
import com.nimbalyst.app.ui.navigation.ComputerPicker
import com.nimbalyst.app.ui.navigation.DocumentSurfaceMarker
import com.nimbalyst.app.ui.navigation.appSaveFailures
import com.nimbalyst.app.ui.navigation.ReconnectingStrip
import com.nimbalyst.app.ui.navigation.AuthDegradedBanner
import com.nimbalyst.app.sync.AuthHealth
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.ui.navigation.SyncErrorBanner
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ViewSidebar
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.R
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.documents.DocumentEditorScreen
import com.nimbalyst.app.notifications.VisibleSession
import com.nimbalyst.app.pairing.QRPairingData
import com.nimbalyst.app.ui.navigation.PendingSessionScreen
import com.nimbalyst.app.ui.navigation.WIDE_LAYOUT_MIN_WIDTH_DP
import com.nimbalyst.app.ui.navigation.WorkspaceNavigation
import com.nimbalyst.app.ui.sessiondetail.SessionDetailStores
import com.nimbalyst.app.attachments.AttachmentStore
import com.nimbalyst.app.ui.navigation.credentialsForScannedPairing
import com.nimbalyst.app.ui.theme.NimbalystColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

@Composable
fun NimbalystAndroidApp(
    navigation: WorkspaceNavigation = viewModel(),
    sessionStores: SessionDetailStores = viewModel(),
) {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    val context = LocalContext.current
    val pairingState by app.pairingStore.state.collectAsState()
    val nav by navigation.state.collectAsState()
    val authHealth by app.syncManager.authHealth.collectAsState()

    // Sync already cleared the auth session; login routing follows, and the reason goes
    // where the sign-in screen shows callback errors.
    LaunchedEffect(authHealth) {
        (authHealth as? AuthHealth.SignedOut)?.let { navigation.reportAuthCallbackFailure(it.reason) }
    }

    // Track app open
    LaunchedEffect(Unit) {
        val packageInfo = runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0)
        }.getOrNull()
        AnalyticsManager.capture(
            "mobile_app_opened",
            mapOf(
                "platform" to "android",
                "nimbalyst_mobile_version" to (packageInfo?.versionName ?: "unknown")
            )
        )
    }

    // Auto-connect sync when credentials are ready
    LaunchedEffect(pairingState.credentials) {
        if (pairingState.isSyncConfigured) {
            app.syncManager.connectIfConfigured()
        } else {
            app.syncManager.disconnect()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            app.syncManager.leaveSessionRoom()
        }
    }

    // nimbalyst://pair opens the scanner; only what our own camera reads is applied.
    if (nav.scannerRequested) {
        val invalidQr = stringResource(R.string.pairing_invalid_qr)
        var scanError by remember { mutableStateOf<String?>(null) }
        BackHandler { navigation.consumeScannerRequest() }
        Column(modifier = Modifier.fillMaxSize()) {
            scanError?.let {
                Text(it, color = NimbalystColors.error, modifier = Modifier.padding(16.dp))
            }
            PairingQrScanner(
                onScanned = { raw ->
                    val parsed = QRPairingData.parse(raw)
                    if (parsed == null) {
                        scanError = invalidQr
                    } else {
                        AnalyticsManager.setDistinctIdFromPairing(parsed.analyticsId)
                        AnalyticsManager.capture("mobile_pairing_completed")
                        app.pairingStore.savePairing(credentialsForScannedPairing(pairingState.credentials, parsed))
                        navigation.consumeScannerRequest()
                    }
                },
                onCancel = { navigation.consumeScannerRequest() }
            )
        }
        return
    }

    // Unsaved document edits stay visible on every screen, including after a sign-out.
    val saveFailures = appSaveFailures()
    Column(modifier = Modifier.fillMaxSize()) {
    if (saveFailures.isNotEmpty()) {
        AppSaveFailureBanner(saveFailures, modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars))
    }
    Box(
        modifier = Modifier
            .weight(1f)
            .then(if (saveFailures.isNotEmpty()) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)
    ) {
    // State-driven navigation matching iOS: Pairing -> Login -> Main app
    when {
        !pairingState.isPaired -> {
            PairingScreen(
                onPaired = { credentials ->
                    app.pairingStore.savePairing(credentials)
                }
            )
        }

        !pairingState.isAuthenticated -> {
            LoginScreen(
                serverUrl = pairingState.credentials?.serverUrl ?: "",
                pairedEmail = pairingState.credentials?.pairedUserId,
                onUnpair = {
                    app.syncManager.disconnect()
                    TranscriptWebViewPool.resetForAccountChange(context)
                    sessionStores.resetForAccountChange(app)
                    app.applicationScope.launch {
                        app.repository.clearPrototypeData()
                    }
                    app.pairingStore.clearPairing()
                    navigation.clearAccount()
                },
                callbackFailure = nav.authCallbackFailure,
                onDismissCallbackFailure = { navigation.reportAuthCallbackFailure(null) }
            )
        }

        else -> {
            MainApp(navigation, sessionStores)
        }
    }
    }
    }
}

@Composable
private fun MainApp(navigation: WorkspaceNavigation, sessionStores: SessionDetailStores) {
    val context = LocalContext.current
    val app = context.applicationContext as NimbalystApplication
    val coroutineScope = rememberCoroutineScope()
    val nav by navigation.state.collectAsState()
    val projects by app.repository.observeProjects().collectAsState(initial = emptyList())
    val syncState by app.syncManager.state.collectAsState()
    val syncError by app.syncManager.syncError.collectAsState()
    val connectedDevices by app.syncManager.connectedDevices.collectAsState()
    val pairingState by app.pairingStore.state.collectAsState()

    // The computer picker lists desktop and headless machines; the list is scoped to the
    // chosen one. Desktop history synced before sessions carried a host stays under a desktop.
    val hosts = remember(connectedDevices) { ExecutionHosts.hosts(connectedDevices) }
    LaunchedEffect(hosts) {
        navigation.rememberHosts(hosts)
        navigation.adoptDefaultHost(ExecutionHosts.defaultHost(connectedDevices)?.deviceId)
    }
    val includeUnattributed = nav.includesUnattributedSessions
    val computerPicker: @Composable RowScope.() -> Unit = {
        ComputerPicker(
            hosts = hosts,
            selectedHostId = nav.hostDeviceId,
            syncConnected = syncState.indexConnected,
            onSelect = navigation::chooseHost
        )
    }
    // The panes below are created once; read these through State so they stay current.
    val currentPicker by rememberUpdatedState(computerPicker)
    val currentIncludeUnattributed by rememberUpdatedState(includeUnattributed)

    PushOptInPrompt()

    // Both panes are movable and keep their saveable state, so crossing the 700dp line
    // (rotation, window resize) moves the same composition instead of rebuilding it:
    // the open transcript, draft, list scroll and filters all survive.
    val saveableStates = rememberSaveableStateHolder()
    val listPane = remember {
        movableContentOf { state: WorkspaceNavigation.State, projectName: String? ->
            saveableStates.SaveableStateProvider("list") {
                val projectId = state.projectId
                if (projectId == null) {
                    ProjectListScreen(
                        onOpenProject = { project ->
                            navigation.chooseProject(project.id)
                            AnalyticsManager.capture("mobile_project_selected")
                        },
                        onOpenSettings = { navigation.showSettings(true) },
                        toolbarActions = { currentPicker() }
                    )
                } else {
                    SessionListScreen(
                        projectId = projectId,
                        projectName = projectName ?: "",
                        selectedSessionId = state.sessionId,
                        onSelectSession = navigation::select,
                        onBack = { navigation.chooseProject(null) },
                        onOpenDocument = navigation::openDocument,
                        onTabChanged = navigation::clearSelection,
                        hostDeviceId = state.hostDeviceId,
                        includeUnattributedSessions = currentIncludeUnattributed,
                        toolbarActions = { currentPicker() },
                        navigation = navigation
                    )
                }
            }
        }
    }
    val detailPane = remember {
        movableContentOf { state: WorkspaceNavigation.State ->
            val sessionId = state.sessionId
            val documentPath = state.documentPath
            val projectId = state.projectId
            if (documentPath != null && projectId != null) {
                key("doc:$projectId/$documentPath") {
                    DocumentSurfaceMarker()
                    DocumentEditorScreen(
                        projectId = projectId,
                        relativePath = documentPath,
                        onBack = navigation::clearSelection
                    )
                }
            } else if (sessionId == null) {
                NoSelection()
            } else {
                key(sessionId) {
                    saveableStates.SaveableStateProvider("session:$sessionId") {
                        DisposableEffect(sessionId) {
                            VisibleSession.show(sessionId)
                            onDispose { VisibleSession.hide(sessionId) }
                        }
                        PendingSessionScreen(
                            sessionId = sessionId,
                            onBack = { navigation.select(null) },
                            onOpenSession = navigation::openSession,
                            onResolved = { projectId -> navigation.adoptResolvedSession(sessionId, projectId) }
                        )
                    }
                }
            }
        }
    }

    val projectName = projects.firstOrNull { it.id == nav.projectId }?.name

    // Banners sit above the workspace and take the status bar inset from it.
    val authHealth by app.syncManager.authHealth.collectAsState()
    val authDegraded = authHealth is AuthHealth.Degraded
    val bannerVisible = authDegraded || syncError != null || !syncState.indexConnected
    Column(modifier = Modifier.fillMaxSize()) {
    Column(
        modifier = if (bannerVisible) Modifier.windowInsetsPadding(WindowInsets.statusBars) else Modifier
    ) {
        if (authDegraded) {
            // Same account signs in again: clear only the auth session, keep pairing and place.
            AuthDegradedBanner(onSignIn = {
                val existing = app.pairingStore.state.value.credentials ?: return@AuthDegradedBanner
                app.syncManager.disconnect()
                app.pairingStore.savePairing(existing.withoutAuthSession())
            })
        } else {
            ReconnectingStrip(isDisconnected = pairingState.isSyncConfigured && !syncState.indexConnected)
        }
        syncError?.let { error ->
            SyncErrorBanner(error = error, onDismiss = app.syncManager::clearSyncError)
        }
    }
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxSize()
            .then(if (bannerVisible) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier)
    ) {
        val isWide = maxWidth >= WIDE_LAYOUT_MIN_WIDTH_DP.dp
        BackHandler(enabled = nav.projectId != null || (nav.hasSelection && !isWide)) {
            navigation.navigateBack(isWide)
        }
        if (isWide) {
            Row(modifier = Modifier.fillMaxSize()) {
                Box(modifier = Modifier.width(360.dp).fillMaxHeight()) { listPane(nav, projectName) }
                VerticalDivider(color = NimbalystColors.border)
                Box(modifier = Modifier.weight(1f).fillMaxHeight()) { detailPane(nav) }
            }
        } else if (nav.hasSelection) {
            detailPane(nav)
        } else {
            listPane(nav, projectName)
        }
    }
    }

    // Settings covers the workspace rather than replacing it, so closing it returns to
    // the same list position and open session.
    if (nav.showSettings) {
        BackHandler { navigation.showSettings(false) }
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            SettingsScreen(
                onBack = { navigation.showSettings(false) },
                onSignOut = {
                    // Clear auth but keep pairing -- goes to LoginScreen
                    val existing = app.pairingStore.state.value.credentials ?: return@SettingsScreen
                    app.syncManager.unregisterPushToken()
                    app.syncManager.disconnect()
                    TranscriptWebViewPool.resetForAccountChange(context)
                    sessionStores.resetForAccountChange(app)
                    navigation.clearAccount()
                    app.pairingStore.savePairing(existing.withoutAuthSession())
                },
                onUnpair = {
                    app.syncManager.unregisterPushToken()
                    app.syncManager.disconnect()
                    TranscriptWebViewPool.resetForAccountChange(context)
                    sessionStores.resetForAccountChange(app)
                    coroutineScope.launch {
                        app.repository.clearPrototypeData()
                    }
                    app.pairingStore.clearPairing()
                    navigation.clearAccount()
                    AnalyticsManager.capture("mobile_device_unpairing")
                    AnalyticsManager.reset()
                },
                onAccountDeleted = {
                    // Server-side data is already purged; clear all local state.
                    app.syncManager.disconnect()
                    TranscriptWebViewPool.resetForAccountChange(context)
                    sessionStores.resetForAccountChange(app)
                    coroutineScope.launch {
                        app.repository.clearPrototypeData()
                    }
                    app.pairingStore.clearPairing()
                    navigation.clearAccount()
                    AnalyticsManager.capture("mobile_account_deleted")
                    AnalyticsManager.reset()
                }
            )
        }
    }

    // Owned by the shell so a failure that lands after leaving the list still shows.
    nav.creationFailure?.let { message ->
        AlertDialog(
            onDismissRequest = { navigation.reportCreationFailure(null) },
            title = { Text(stringResource(R.string.session_create_failed_title)) },
            text = { Text(message) },
            confirmButton = {
                TextButton(onClick = { navigation.reportCreationFailure(null) }) {
                    Text(stringResource(R.string.session_create_failed_ok))
                }
            }
        )
    }
}

/** Drop the previous account's open sessions, unsent drafts, and their attachment files. */
private fun SessionDetailStores.resetForAccountChange(app: NimbalystApplication) {
    val orphaned = clearAll()
    if (orphaned.isNotEmpty()) {
        app.applicationScope.launch(Dispatchers.IO) { orphaned.forEach(AttachmentStore::delete) }
    }
}

@Composable
private fun NoSelection() {
    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)
    ) {
        Icon(
            Icons.AutoMirrored.Outlined.ViewSidebar,
            contentDescription = null,
            tint = NimbalystColors.textFaint,
            modifier = Modifier.size(40.dp)
        )
        Text(
            text = stringResource(R.string.workspace_no_selection),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/** Asks once, after the first sign-in, whether to turn on push (iOS asks at the same point). */
@Composable
private fun PushOptInPrompt() {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    var show by remember { mutableStateOf(app.notificationManager.shouldOfferOptIn()) }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        app.notificationManager.handlePermissionResult(granted)
    }
    if (!show) return

    fun answer(enable: Boolean) {
        show = false
        app.notificationManager.markOptInOffered()
        if (!enable) return
        app.notificationManager.setPushEnabled(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !app.notificationManager.state.value.isAuthorized) {
            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    AlertDialog(
        onDismissRequest = { answer(false) },
        title = { Text(stringResource(R.string.push_opt_in_title)) },
        text = { Text(stringResource(R.string.push_opt_in_message)) },
        confirmButton = { TextButton(onClick = { answer(true) }) { Text(stringResource(R.string.push_opt_in_enable)) } },
        dismissButton = { TextButton(onClick = { answer(false) }) { Text(stringResource(R.string.push_opt_in_not_now)) } }
    )
}

/** The same credentials with the sign-in removed; pairing (server, seed, account) stays. */
private fun PairingCredentials.withoutAuthSession() = copy(
    authJwt = null,
    authUserId = null,
    orgId = null,
    sessionToken = null,
    authEmail = null,
    authExpiresAt = null
)
