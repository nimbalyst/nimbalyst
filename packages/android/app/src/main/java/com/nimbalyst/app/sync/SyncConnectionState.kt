package com.nimbalyst.app.sync

data class SyncConnectionState(
    val indexConnected: Boolean = false,
    val sessionConnected: Boolean = false,
    val isConnecting: Boolean = false,
    val activeSessionId: String? = null,
    val lastError: String? = null,
    val lastIndexSyncAt: Long? = null,
    val lastSessionSyncAt: Long? = null,
) {
    val statusLabel: String
        get() = when {
            isConnecting -> "Connecting"
            sessionConnected -> "Connected (session)"
            indexConnected -> "Connected (index)"
            lastError != null -> "Disconnected with error"
            else -> "Disconnected"
        }
}
