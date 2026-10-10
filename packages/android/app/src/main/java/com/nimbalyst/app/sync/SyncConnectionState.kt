package com.nimbalyst.app.sync

data class SyncConnectionState(
    val indexConnected: Boolean = false,
    val sessionConnected: Boolean = false,
    val isConnecting: Boolean = false,
    val activeSessionId: String? = null,
    val lastError: String? = null,
    val lastIndexSyncAt: Long? = null,
    val lastSessionSyncAt: Long? = null,
    /** Index rows in the last full snapshot this device's key could not read. */
    val unreadableSessionCount: Int = 0,
    /**
     * The last complete snapshot had many rows and none readable: this
     * device's pairing key does not match the desktop's. Suggest re-pairing.
     */
    val encryptionMismatch: Boolean = false,
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
