package com.nimbalyst.app.sync

import android.content.Context
import android.content.res.Configuration
import android.os.Build
import com.google.gson.Gson

/**
 * What this device tells the index room about itself. The server uses the
 * announce for the desktop's device list and for push suppression; the desktop
 * pushes settings and models when a mobile device announces. Status rules
 * match iOS `WebSocketClient` and the desktop.
 */
internal class DevicePresence(
    private val context: Context,
    private val gson: Gson,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    @Volatile private var lastActivityAt: Long = clock()
    @Volatile private var connectedAt: Long = clock()
    @Volatile var isInForeground: Boolean = true
        private set

    /** Throttled to once per second, matching Electron and iOS. */
    fun reportActivity() {
        val now = clock()
        if (now - lastActivityAt >= ACTIVITY_THROTTLE_MS) lastActivityAt = now
    }

    fun setForeground(foreground: Boolean) {
        isInForeground = foreground
        if (foreground) reportActivity()
    }

    fun markConnected() {
        connectedAt = clock()
    }

    fun status(): String = when {
        !isInForeground -> "away"
        clock() - lastActivityAt > IDLE_THRESHOLD_MS -> "idle"
        else -> "active"
    }

    fun announcement(): String = gson.toJson(
        DeviceAnnounceMessage(
            device = DeviceInfo(
                deviceId = WebSocketClient.getDeviceId(context),
                name = deviceName(),
                type = deviceType(),
                platform = "android",
                appVersion = WebSocketClient.appVersion,
                connectedAt = connectedAt,
                lastActiveAt = lastActivityAt,
                isFocused = isInForeground,
                status = status()
            )
        )
    )

    val deviceId: String get() = WebSocketClient.getDeviceId(context)

    fun registerPushToken(token: String): String =
        gson.toJson(RegisterPushTokenMessage(token = token, platform = "android", deviceId = deviceId))

    fun unregisterPushToken(): String = gson.toJson(UnregisterPushTokenMessage(deviceId = deviceId))

    private fun deviceName(): String {
        val manufacturer = Build.MANUFACTURER.orEmpty()
        val model = Build.MODEL.orEmpty()
        val name = if (model.startsWith(manufacturer, ignoreCase = true)) model else "$manufacturer $model"
        return name.trim().ifBlank { "Android device" }
    }

    private fun deviceType(): String {
        val smallestWidth = context.resources.configuration.smallestScreenWidthDp
        return if (smallestWidth != Configuration.SMALLEST_SCREEN_WIDTH_DP_UNDEFINED && smallestWidth >= 600) {
            "tablet"
        } else {
            "mobile"
        }
    }

    private companion object {
        const val IDLE_THRESHOLD_MS = 5L * 60L * 1000L
        const val ACTIVITY_THROTTLE_MS = 1000L
    }
}
