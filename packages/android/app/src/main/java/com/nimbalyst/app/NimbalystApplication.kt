package com.nimbalyst.app

import android.app.Application
import com.nimbalyst.app.data.NimbalystDatabase
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.notifications.NotificationManager
import com.nimbalyst.app.pairing.PairingStore
import com.nimbalyst.app.analytics.AnalyticsManager
import com.nimbalyst.app.sync.SyncManager
import com.nimbalyst.app.sync.WebSocketClient
import com.nimbalyst.app.transcript.TranscriptWebViewPool
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class NimbalystApplication : Application() {
    val applicationScope: CoroutineScope by lazy {
        CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }

    // A session id pending in-app navigation, set when the app is opened via a
    // notification tap / `nimbalyst://session/<id>` deep link. The Compose nav
    // host observes this and routes to the session, then clears it.
    private val _pendingSessionNavigation = MutableStateFlow<String?>(null)
    val pendingSessionNavigation: StateFlow<String?> = _pendingSessionNavigation.asStateFlow()

    fun requestSessionNavigation(sessionId: String) {
        _pendingSessionNavigation.value = sessionId
    }

    fun consumeSessionNavigation() {
        _pendingSessionNavigation.value = null
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
        TranscriptWebViewPool.warmup(this)
        // Label every sync WebSocket connection with this build's version so the
        // server can attribute connect/disconnect telemetry to platform + version.
        WebSocketClient.appVersion = runCatching {
            packageManager.getPackageInfo(packageName, 0).versionName
        }.getOrNull()
    }

    override fun onTerminate() {
        super.onTerminate()
        applicationScope.cancel()
    }
}
