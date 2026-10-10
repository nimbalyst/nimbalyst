package com.nimbalyst.app.screenshots

import android.app.Activity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.ui.NimbalystAndroidApp
import com.nimbalyst.app.ui.PairingScreen
import com.nimbalyst.app.ui.SettingsScreen
import com.nimbalyst.app.ui.navigation.WIDE_LAYOUT_MIN_WIDTH_DP
import com.nimbalyst.app.ui.navigation.WorkspaceNavigation

/**
 * Renders one screen for a screenshot capture. Workspace screens run the real app shell
 * with the navigation preset, so a phone shows one pane and a tablet (>= 700dp) shows
 * the list and detail side by side. Pairing and settings render on their own.
 */
@Composable
fun ScreenshotHost(screen: ScreenshotScreen) {
    // The walkthrough video keeps its bars: record-walkthrough.sh taps fixed coordinates.
    if (screen != ScreenshotScreen.WALKTHROUGH) HideNavigationBars()
    when (screen) {
        ScreenshotScreen.SETTINGS -> SettingsScreen(
            onBack = {},
            onSignOut = {},
            onUnpair = {},
            onAccountDeleted = {}
        )

        ScreenshotScreen.PAIRING -> PairingScreen(onPaired = {})

        // The demo credentials make this land straight in the main app, so the
        // video walkthrough gets real navigation instead of an isolated screen.
        ScreenshotScreen.WALKTHROUGH -> NimbalystAndroidApp()

        else -> Workspace(screen)
    }
}

@Composable
private fun Workspace(screen: ScreenshotScreen) {
    val navigation: WorkspaceNavigation = viewModel()
    val isWide = LocalConfiguration.current.screenWidthDp >= WIDE_LAYOUT_MIN_WIDTH_DP
    remember(screen, isWide) {
        val projectId = if (screen == ScreenshotScreen.PROJECTS) null else ScreenshotDemoData.SHOWCASE_PROJECT_ID
        navigation.chooseProject(projectId)
        // A phone shows the transcript only when asked; a tablet always fills its detail pane.
        // FILES and DOCUMENT start clear: switching to the Files tab drops any selection.
        val showSession = when (screen) {
            ScreenshotScreen.DETAIL, ScreenshotScreen.COMPOSER -> true
            ScreenshotScreen.SESSIONS, ScreenshotScreen.NEW_SESSION, ScreenshotScreen.COMPUTERS -> isWide
            else -> false
        }
        if (projectId != null && showSession) navigation.select(ScreenshotDemoData.SHOWCASE_SESSION_ID)
    }
    // With no server, every read receipt and draft push fails delivery; that banner is
    // true in screenshot mode and noise in a store listing.
    val app = LocalContext.current.applicationContext as NimbalystApplication
    LaunchedEffect(Unit) {
        app.syncManager.syncError.collect { if (it != null) app.syncManager.clearSyncError() }
    }
    NimbalystAndroidApp(navigation)
}

/**
 * A large-screen launcher pins a taskbar of other apps' icons along the bottom edge,
 * and a phone shows the gesture pill. Neither belongs in a listing, so the capture
 * hides the navigation bars the way an immersive app would.
 */
@Composable
private fun HideNavigationBars() {
    val activity = LocalContext.current as? Activity ?: return
    val view = LocalView.current
    DisposableEffect(activity) {
        WindowCompat.getInsetsController(activity.window, view).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.navigationBars())
        }
        onDispose { }
    }
}
