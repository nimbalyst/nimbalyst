package com.nimbalyst.app

import android.app.Activity
import android.app.Application
import android.os.Bundle
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingStore
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.sync.SyncManager
import com.nimbalyst.app.sync.WebSocketClient
import android.util.Log
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel

class NimbalystApplication : Application() {
    val applicationScope: CoroutineScope by lazy {
        // Without a handler, any exception escaping a launched coroutine on this
        // scope kills the process (#1336). Log it instead; the sync layer
        // reports its own failures through SyncConnectionState.
        val handler = CoroutineExceptionHandler { _, error ->
            Log.e("NimbalystApplication", "Uncaught coroutine failure: ${error.message}", error)
        }
        CoroutineScope(SupervisorJob() + Dispatchers.IO + handler)
    }

    val database: NimbalystDatabase by lazy {
        NimbalystDatabase.getInstance(this)
    }

    val repository: NimbalystRepository by lazy {
        NimbalystRepository(database)
    }

    val pairingStore: PairingStore by lazy {
        PairingStore(this)
    }

    val notificationManager: NotificationManager by lazy {
        NotificationManager(this)
    }

    val syncManager: SyncManager by lazy {
        SyncManager(
            context = this,
            repository = repository,
            pairingStore = pairingStore,
            notificationManager = notificationManager,
            scope = applicationScope
        )
    }

    override fun onCreate() {
        super.onCreate()
        AnalyticsManager.initialize(this)
        // No WebView warmup here: push-only starts (FCM) never show a transcript,
        // and a missing or updating WebView provider would crash every start.
        // MainActivity warms the pool once the first frame is up.
        // Label every sync WebSocket connection with this build's version so the
        // server can attribute connect/disconnect telemetry to platform + version.
        WebSocketClient.appVersion = runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName
        }.getOrNull()
        registerActivityLifecycleCallbacks(ForegroundTracker { foreground ->
            syncManager.setAppInForeground(foreground)
        })
    }

    override fun onTerminate() {
        super.onTerminate()
        applicationScope.cancel()
    }
}

/** Reports when the first activity starts and the last one stops. */
private class ForegroundTracker(
    private val onChange: (Boolean) -> Unit,
) : Application.ActivityLifecycleCallbacks {
    private var started = 0

    override fun onActivityStarted(activity: Activity) {
        if (started++ == 0) onChange(true)
    }

    override fun onActivityStopped(activity: Activity) {
        if (--started == 0) onChange(false)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
