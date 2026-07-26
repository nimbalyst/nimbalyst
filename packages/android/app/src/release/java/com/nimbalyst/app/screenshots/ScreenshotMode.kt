package com.nimbalyst.app.screenshots

import android.content.Intent
import com.nimbalyst.app.NimbalystApplication

/**
 * Release stub. The real implementation lives in app/src/debug -- demo data and
 * the fake paired state must never ship. Keep this API identical to the debug
 * source set so MainActivity compiles against both variants.
 */
enum class ScreenshotScreen {
    PROJECTS,
}

object ScreenshotMode {
    fun isEnabled(intent: Intent?): Boolean = false

    fun screen(intent: Intent?): ScreenshotScreen = ScreenshotScreen.PROJECTS

    fun apply(app: NimbalystApplication, screen: ScreenshotScreen, now: Long) = Unit
}
