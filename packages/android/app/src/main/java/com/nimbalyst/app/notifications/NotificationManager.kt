package com.nimbalyst.app.notifications

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

class NotificationManager(
    private val context: Context,
) {
    private val _state = MutableStateFlow(
        NotificationState(
            isAuthorized = hasNotificationPermission()
        )
    )

    var onTokenReceived: ((String) -> Unit)? = null

    val state: StateFlow<NotificationState> = _state.asStateFlow()

    init {
        refreshAuthorization()
    }

    fun refreshAuthorization() {
        val authorized = hasNotificationPermission()
        _state.update {
            it.copy(
                isAuthorized = authorized,
                lastError = if (authorized) it.lastError else null
            )
        }
        if (authorized) {
            fetchToken()
        }
    }

    fun handlePermissionResult(granted: Boolean) {
        _state.update { it.copy(isAuthorized = granted) }
        if (granted) {
            fetchToken()
        }
    }

    fun fetchToken() {
        // When google-services.json is present the google-services plugin's
        // FirebaseInitProvider has already initialized the default app at startup,
        // so initializeApp() would throw "already exists". Treat an existing app
        // as configured; otherwise try initializeApp() (null = no config resources).
        val configured = FirebaseApp.getApps(context).isNotEmpty() ||
            runCatching { FirebaseApp.initializeApp(context) != null }.getOrDefault(false)
        if (!configured) {
            _state.update {
                it.copy(
                    lastError = "Firebase is not configured for Android. Add google-services.json to enable push."
                )
            }
            return
        }

        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                _state.update { it.copy(deviceToken = token, lastError = null) }
                onTokenReceived?.invoke(token)
            }
            .addOnFailureListener { error ->
                _state.update { it.copy(lastError = error.message ?: "Failed to get FCM token.") }
            }
    }

    /**
     * Called by [NimbalystFirebaseMessagingService.onNewToken] when FCM rotates the
     * registration token. Persists the token into state (so the next index-connect
     * picks it up via [SyncManager]'s reconnect path) and forwards it immediately
     * via [onTokenReceived] if the sync channel is already wired.
     */
    fun handleNewToken(token: String) {
        _state.update { it.copy(deviceToken = token, lastError = null) }
        onTokenReceived?.invoke(token)
    }

    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return true
        }
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }
}

data class NotificationState(
    val isAuthorized: Boolean,
    val deviceToken: String? = null,
    val lastError: String? = null,
)
