package com.nimbalyst.app.notifications

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.nimbalyst.app.MainActivity
import com.nimbalyst.app.NimbalystApplication

/**
 * Receives inbound FCM messages for the Nimbalyst Android app.
 *
 * Token rotation: [onNewToken] is invoked by the FCM SDK whenever the registration
 * token changes. It delegates to [NotificationManager.handleNewToken], which stores
 * the new token in state and forwards it through [NotificationManager.onTokenReceived]
 * — the same callback that [com.nimbalyst.app.sync.SyncManager] wires on init to call
 * [com.nimbalyst.app.sync.SyncManager.registerPushToken].
 *
 * Inbound payload: [onMessageReceived] expects a **data-only** FCM message so that
 * delivery is reliable in all app states. The expected data keys are:
 *
 * | Key        | Type   | Description                                          |
 * |------------|--------|------------------------------------------------------|
 * | `sessionId`| String | Nimbalyst session ID used to build the deep-link URI |
 * | `title`    | String | Notification title (optional)                        |
 * | `body`     | String | Notification body text (optional)                   |
 *
 * Tapping the notification opens [MainActivity] via `nimbalyst://session/<sessionId>`.
 * [MainActivity.handleIntent] routes that `session` host to in-app navigation by
 * calling [NimbalystApplication.requestSessionNavigation], which the Compose nav host
 * observes to open the session.
 */
class NimbalystFirebaseMessagingService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "NimbalystFCMService"
        private const val CHANNEL_ID = "nimbalyst_notifications"
        private const val CHANNEL_NAME = "Nimbalyst Notifications"
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "FCM token refreshed: ${token.take(8)}...")

        val app = applicationContext as NimbalystApplication
        // Touch syncManager first so the lazy singleton is created and its init block
        // wires notificationManager.onTokenReceived before we invoke handleNewToken.
        @Suppress("UNUSED_EXPRESSION")
        app.syncManager
        app.notificationManager.handleNewToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val sessionId = data["sessionId"]

        val title = data["title"]
            ?: message.notification?.title
            ?: "Nimbalyst"
        val body = data["body"]
            ?: message.notification?.body
            ?: "You have a new notification."

        Log.d(TAG, "FCM message received: sessionId=$sessionId title=$title")

        val notificationManager = NotificationManagerCompat.from(this)

        ensureNotificationChannel(notificationManager)

        val contentIntent = buildContentIntent(sessionId)

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        if (notificationManager.areNotificationsEnabled()) {
            val notificationId = sessionId?.hashCode() ?: System.currentTimeMillis().toInt()
            notificationManager.notify(notificationId, notification)
        } else {
            Log.d(TAG, "Notifications not enabled; skipping post.")
        }
    }

    private fun ensureNotificationChannel(notificationManager: NotificationManagerCompat) {
        val channel = NotificationChannelCompat.Builder(
            CHANNEL_ID,
            NotificationManagerCompat.IMPORTANCE_HIGH
        )
            .setName(CHANNEL_NAME)
            .setDescription("Notifications from the Nimbalyst desktop app.")
            .build()
        notificationManager.createNotificationChannel(channel)
    }

    private fun buildContentIntent(sessionId: String?): PendingIntent {
        val deepLink = if (!sessionId.isNullOrBlank()) {
            Uri.parse("nimbalyst://session/$sessionId")
        } else {
            Uri.parse("nimbalyst://home")
        }

        val intent = Intent(this, MainActivity::class.java).apply {
            data = deepLink
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        return PendingIntent.getActivity(
            this,
            sessionId?.hashCode() ?: 0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }
}
