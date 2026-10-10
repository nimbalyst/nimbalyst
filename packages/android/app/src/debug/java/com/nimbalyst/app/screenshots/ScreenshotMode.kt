package com.nimbalyst.app.screenshots

import android.content.Intent
import com.nimbalyst.app.NimbalystApplication
import com.nimbalyst.app.sync.EncryptedSettingsPayload
import com.nimbalyst.app.sync.SettingsSyncApplier
import com.nimbalyst.app.sync.SyncedSettings
import kotlinx.coroutines.launch

enum class ScreenshotScreen {
    PROJECTS,
    SESSIONS,
    DETAIL,
    COMPOSER,
    SETTINGS,
    PAIRING,

    /** Session list with the new-session model picker open (the script opens it). */
    NEW_SESSION,

    /** Session list with the computer picker open (the script opens it). */
    COMPUTERS,

    /** The project's Files tab (the script switches tabs). */
    FILES,

    /** A document open in the editor (the script opens it from the Files tab). */
    DOCUMENT,

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
            "newsession" -> ScreenshotScreen.NEW_SESSION
            "computers" -> ScreenshotScreen.COMPUTERS
            "files" -> ScreenshotScreen.FILES
            "document" -> ScreenshotScreen.DOCUMENT
            "walkthrough" -> ScreenshotScreen.WALKTHROUGH
            else -> ScreenshotScreen.PROJECTS
        }

    /**
     * Put the app into a paired, synced-looking state with demo content. Sync
     * state is applied synchronously; the database seed runs on the app scope
     * and lands through the same Room flows the screens already observe.
     */
    fun apply(app: NimbalystApplication, screen: ScreenshotScreen, now: Long) {
        val credentials = ScreenshotDemoData.pairingCredentials()
        app.pairingStore.savePairing(credentials)
        app.syncManager.enterScreenshotMode(ScreenshotDemoData.connectedDevices(now), now)
        // The push opt-in dialog would cover the first capture.
        app.notificationManager.markOptInOffered()
        seedDesktopSettings(app, now)
        ScreenshotDocuments.install(app, credentials, now)

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

    /**
     * The model list and Meta Agent gate the desktop would publish. They are read from
     * preferences when SyncManager starts, so they show from the next launch on; the
     * capture script's warm-up launch takes care of that.
     */
    private fun seedDesktopSettings(app: NimbalystApplication, now: Long) {
        SettingsSyncApplier(app).accept(
            EncryptedSettingsPayload(
                encryptedSettings = "",
                settingsIv = "",
                deviceId = ScreenshotDemoData.connectedDevices(now).first().deviceId,
                timestamp = now,
                version = now
            ),
            SyncedSettings(
                availableModels = ScreenshotDemoData.availableModels(),
                defaultModel = ScreenshotDemoData.DEFAULT_MODEL_ID,
                metaAgentEnabled = true,
                version = now
            )
        )
    }
}
