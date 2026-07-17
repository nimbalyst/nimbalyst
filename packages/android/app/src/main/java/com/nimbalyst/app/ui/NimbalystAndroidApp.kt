package com.nimbalyst.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.analytics.AnalyticsManager
import kotlinx.coroutines.launch

@Composable
fun NimbalystAndroidApp() {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    val context = LocalContext.current
    val pairingState by app.pairingStore.state.collectAsState()
    val coroutineScope = rememberCoroutineScope()

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
                    coroutineScope.launch {
                        app.repository.clearPrototypeData()
                    }
                    app.pairingStore.clearPairing()
                }
            )
        }

        else -> {
            MainApp()
        }
    }
}

@Composable
private fun MainApp() {
    val app = LocalContext.current.applicationContext as NimbalystApplication
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val navController = rememberNavController()

    // Route to a session when opened via a notification tap (nimbalyst://session/<id>).
    val pendingSessionId by app.pendingSessionNavigation.collectAsState()
    LaunchedEffect(pendingSessionId) {
        pendingSessionId?.let { sessionId ->
            navController.navigate("sessions/$sessionId")
            app.consumeSessionNavigation()
        }
    }

    NavHost(navController = navController, startDestination = "projects") {
        composable("projects") {
            ProjectListScreen(navController = navController)
        }

        composable(
            "sessions?projectId={projectId}&name={projectName}",
            arguments = listOf(
                navArgument("projectId") { type = NavType.StringType },
                navArgument("projectName") { type = NavType.StringType; defaultValue = "Sessions" }
            )
        ) { backStackEntry ->
            val projectId = backStackEntry.arguments?.getString("projectId") ?: return@composable
            val projectName = backStackEntry.arguments?.getString("projectName") ?: "Sessions"
            SessionListScreen(
                projectId = projectId,
                projectName = projectName,
                navController = navController
            )
        }

        composable(
            "sessions/{sessionId}",
            arguments = listOf(
                navArgument("sessionId") { type = NavType.StringType }
            )
        ) { backStackEntry ->
            val sessionId = backStackEntry.arguments?.getString("sessionId") ?: return@composable
            SessionDetailScreen(
                sessionId = sessionId,
                onBack = { navController.popBackStack() }
            )
        }

        composable("settings") {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onSignOut = {
                    // Clear auth but keep pairing -- goes to LoginScreen
                    val existing = app.pairingStore.state.value.credentials ?: return@SettingsScreen
                    app.syncManager.disconnect()
                    app.pairingStore.savePairing(
                        existing.copy(
                            authJwt = null,
                            authUserId = null,
                            orgId = null,
                            sessionToken = null,
                            authEmail = null,
                            authExpiresAt = null
                        )
                    )
                },
                onUnpair = {
                    app.syncManager.disconnect()
                    coroutineScope.launch {
                        app.repository.clearPrototypeData()
                    }
                    app.pairingStore.clearPairing()
                    AnalyticsManager.capture("mobile_device_unpairing")
                    AnalyticsManager.reset()
                },
                onAccountDeleted = {
                    // Server-side data is already purged; clear all local state.
                    app.syncManager.disconnect()
                    coroutineScope.launch {
                        app.repository.clearPrototypeData()
                    }
                    app.pairingStore.clearPairing()
                    AnalyticsManager.capture("mobile_account_deleted")
                    AnalyticsManager.reset()
                }
            )
        }
    }
}
