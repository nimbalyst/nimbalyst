package com.nimbalyst.app.screenshots

import android.content.Intent
import com.nimbalyst.app.NimbalystApplication
import kotlinx.coroutines.launch

enum class ScreenshotScreen {
    PROJECTS,
    SESSIONS,
    DETAIL,
    COMPOSER,
    SETTINGS,
    PAIRING,

    /** The whole app with real navigation over demo data -- used for video capture. */
    WALKTHROUGH,
}

/**
 * Play Store screenshot capture, driven from adb:
 *
 *   adb shell am start -n com.nimbalyst.app/.MainActivity \
 *     --ez screenshot_mode true --es screenshot_screen sessions
 *
 * Debug source set only -- the release variant gets the inert stub in
 * app/src/release, so none of this reaches a shipped build. See
 * scripts/take-screenshots.sh and docs/ANDROID_MARKETING_SCREENSHOTS.md.
 */
object ScreenshotMode {
    const val EXTRA_ENABLED = "screenshot_mode"
    const val EXTRA_SCREEN = "screenshot_screen"

    fun isEnabled(intent: Intent?): Boolean =
        intent?.getBooleanExtra(EXTRA_ENABLED, false) == true

    fun screen(intent: Intent?): ScreenshotScreen =
        resolveScreen(intent?.getStringExtra(EXTRA_SCREEN))

    internal fun resolveScreen(raw: String?): ScreenshotScreen =
        when (raw?.trim()?.lowercase()) {
            "sessions" -> ScreenshotScreen.SESSIONS
            "detail" -> ScreenshotScreen.DETAIL
            "composer" -> ScreenshotScreen.COMPOSER
            "settings" -> ScreenshotScreen.SETTINGS
            "pairing" -> ScreenshotScreen.PAIRING
            "walkthrough" -> ScreenshotScreen.WALKTHROUGH
            else -> ScreenshotScreen.PROJECTS
        }

    /**
     * Put the app into a paired, synced-looking state with demo content. Sync
     * state is applied synchronously; the database seed runs on the app scope
     * and lands through the same Room flows the screens already observe.
     */
    fun apply(app: NimbalystApplication, screen: ScreenshotScreen, now: Long) {
        app.pairingStore.savePairing(ScreenshotDemoData.pairingCredentials())
        app.syncManager.enterScreenshotMode(ScreenshotDemoData.connectedDevices(now), now)

        app.applicationScope.launch {
            app.repository.reconcileIndexSnapshot(
                projects = ScreenshotDemoData.projects(),
                sessions = ScreenshotDemoData.sessions(now),
                syncedAt = now
            )
            app.database.messageDao().upsertAll(ScreenshotDemoData.messages(now))
            app.database.sessionDao().updateDraftInput(
                sessionId = ScreenshotDemoData.SHOWCASE_SESSION_ID,
                draftInput = if (screen == ScreenshotScreen.COMPOSER) ScreenshotDemoData.DEMO_DRAFT else null,
                draftUpdatedAt = now
            )
        }
    }
}
