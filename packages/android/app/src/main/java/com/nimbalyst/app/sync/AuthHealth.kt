package com.nimbalyst.app.sync

import com.nimbalyst.app.pairing.PairingCredentials
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Whether this device can still refresh its session. Drives the degraded-auth banner and the return to login. */
sealed interface AuthHealth {
    data object Ok : AuthHealth

    /** Refresh has failed [consecutiveFailures] times in a row: show the degraded-auth banner. */
    data class Degraded(val consecutiveFailures: Int) : AuthHealth

    /** Refresh kept failing; the auth session was cleared and the app should show login with [reason]. */
    data class SignedOut(val reason: String) : AuthHealth
}

/**
 * The JWT refresh failure policy, ported from iOS `AppState.refreshJWT`: three
 * consecutive failures degrade, five sign out, any success resets. A failure
 * counts at most once per refresh interval, so 401-driven retries during an
 * outage cannot race to a logout. Without the escalation a sustained outage
 * (the 2026-05-20 JWKS rotation answered refresh with 403) left clients
 * retrying forever in silence.
 */
internal class AuthHealthTracker(private val clock: () -> Long = System::currentTimeMillis) {
    private val _health = MutableStateFlow<AuthHealth>(AuthHealth.Ok)
    val health: StateFlow<AuthHealth> = _health.asStateFlow()

    private var consecutiveFailures = 0
    private var lastCountedAt: Long? = null

    @Synchronized
    fun recordSuccess() {
        consecutiveFailures = 0
        lastCountedAt = null
        _health.value = AuthHealth.Ok
    }

    /** Records a refresh the auth server rejected and returns the resulting health. Never call it for a network failure. */
    @Synchronized
    fun recordFailure(): AuthHealth {
        if (_health.value is AuthHealth.SignedOut) return _health.value
        val now = clock()
        val last = lastCountedAt
        if (last != null && now - last < COUNT_INTERVAL_MS) return _health.value
        lastCountedAt = now
        consecutiveFailures++
        _health.value = when {
            consecutiveFailures >= SIGN_OUT_THRESHOLD ->
                AuthHealth.SignedOut("Your session could not be refreshed. Please sign in again.")
            consecutiveFailures >= DEGRADED_THRESHOLD -> AuthHealth.Degraded(consecutiveFailures)
            else -> AuthHealth.Ok
        }
        return _health.value
    }

    companion object {
        const val DEGRADED_THRESHOLD = 3
        const val SIGN_OUT_THRESHOLD = 5
        /** Matches the iOS refresh cadence: at most one counted failure per four minutes. */
        const val COUNT_INTERVAL_MS = 4L * 60L * 1000L
    }
}

/** Drops the auth session and keeps the pairing, as iOS `AuthManager.logout` does. */
internal fun PairingCredentials.signedOut(): PairingCredentials = copy(
    authJwt = null,
    authUserId = null,
    orgId = null,
    sessionToken = null,
    authEmail = null,
    authExpiresAt = null,
)
