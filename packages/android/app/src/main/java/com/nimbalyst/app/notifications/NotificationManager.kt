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
    private val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    private val _state = MutableStateFlow(
        NotificationState(
            isAuthorized = hasNotificationPermission(),
            isEnabledInApp = preferences.getBoolean(KEY_PUSH_ENABLED, false)
        )
    )

    var onTokenReceived: ((String) -> Unit)? = null
    var onTokenRemoved: (() -> Unit)? = null

    val state: StateFlow<NotificationState> = _state.asStateFlow()

    init {
        refreshAuthorization()
    }

    fun setPushEnabled(enabled: Boolean) {
        preferences.edit().putBoolean(KEY_PUSH_ENABLED, enabled).apply()
        _state.update {
            it.copy(
                isEnabledInApp = enabled,
                deviceToken = if (enabled) it.deviceToken else null,
                lastError = if (enabled) it.lastError else null
            )
        }

        if (enabled) {
            refreshAuthorization()
        } else {
            onTokenRemoved?.invoke()
        }
    }

    fun refreshAuthorization() {
        val authorized = hasNotificationPermission()
        _state.update {
            it.copy(
                isAuthorized = authorized,
                deviceToken = if (authorized) it.deviceToken else null,
                lastError = if (authorized || !it.isEnabledInApp) {
                    it.lastError
                } else {
                    "Notifications are blocked in Android settings."
                }
            )
        }
        if (authorized && _state.value.isEnabledInApp) {
            fetchToken()
        } else if (!authorized && _state.value.isEnabledInApp) {
            onTokenRemoved?.invoke()
        }
    }

    fun handlePermissionResult(granted: Boolean) {
        _state.update {
            it.copy(
                isAuthorized = granted,
                deviceToken = if (granted) it.deviceToken else null,
                lastError = if (granted || !it.isEnabledInApp) {
                    null
                } else {
                    "Notifications are blocked in Android settings."
                }
            )
        }
        if (granted && _state.value.isEnabledInApp) {
            fetchToken()
        } else if (!granted) {
            onTokenRemoved?.invoke()
        }
    }

    fun fetchToken() {
        if (!_state.value.isEnabledInApp) {
            return
        }

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
        if (!_state.value.isEnabledInApp || !_state.value.isAuthorized) {
            return
        }
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

    companion object {
        private const val PREFS_NAME = "nimbalyst_notifications"
        private const val KEY_PUSH_ENABLED = "push_enabled"
    }
}

data class NotificationState(
    val isAuthorized: Boolean,
    val isEnabledInApp: Boolean,
    val deviceToken: String? = null,
    val lastError: String? = null,
)
