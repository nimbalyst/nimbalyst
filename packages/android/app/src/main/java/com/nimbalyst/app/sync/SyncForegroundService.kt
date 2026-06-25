package com.nimbalyst.app.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.util.Log
import com.nimbalyst.app.NimbalystApplication

/**
 * Foreground service that keeps the app process network-capable while sync is
 * active. Without it, Android blocks background network per-uid
 * (BLOCKED_REASON_APP_BACKGROUND), so the sync WebSocket silently fails DNS
 * the moment the app leaves the foreground and the device drifts out of sync
 * with the desktop until the next launch.
 */
class SyncForegroundService : Service() {

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        // A null intent means the system restarted the sticky service after
        // process death: the fresh process has not connected sync yet.
        if (intent == null) {
            (application as NimbalystApplication).syncManager.connectIfConfigured()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "Desktop sync",
                    NotificationManager.IMPORTANCE_MIN
                )
            )
        }
        val contentIntent = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
        }
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Synced with desktop")
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "SyncForegroundService"
        private const val CHANNEL_ID = "sync"
        private const val NOTIFICATION_ID = 1001

        fun start(context: Context) {
            runCatching {
                context.startForegroundService(Intent(context, SyncForegroundService::class.java))
            }.onFailure {
                // Disallowed while the app is in the background; sync then only
                // runs while the app is foregrounded.
                Log.w(TAG, "Unable to start sync foreground service: $it")
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SyncForegroundService::class.java))
        }
    }
}
