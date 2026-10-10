package com.nimbalyst.app.pairing

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.nimbalyst.app.auth.AuthCallbackData
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.ProviderException

/**
 * Persists pairing credentials in EncryptedSharedPreferences.
 *
 * The prefs file can become undecryptable: the Keystore master key is
 * device-bound, so a copy restored by device transfer, a Keystore reset, or a
 * corrupted keyset makes opening or reading it throw (AEADBadTagException,
 * KeyStoreException, ...). Rather than crash on every launch, the store retries
 * once, then deletes only the pairing prefs file and starts unpaired. That is the
 * only data it destroys, and it is re-establishable: the user re-scans the
 * desktop QR code. Synced data in Room is untouched.
 */
class PairingStore internal constructor(
    private val context: Context,
    private val openPreferences: (Context) -> SharedPreferences,
) {
    constructor(context: Context) : this(context, { openEncryptedPreferences(it) })

    // Null only when the prefs cannot be opened even after a reset (a broken
    // Keystore). Pairing then lives in memory for this process only.
    private var preferences: SharedPreferences? = openWithRecovery()

    private val _state = MutableStateFlow(loadStateWithRecovery())
    val state: StateFlow<PairingState> = _state.asStateFlow()

    fun savePairing(credentials: PairingCredentials) {
        val sanitizedCredentials = credentials.sanitizedForServerChange(_state.value.credentials)
        val preferences = preferences
        if (preferences == null) {
            Log.w(TAG, "Pairing storage is unavailable; this pairing will not survive an app restart.")
            _state.value = PairingState(sanitizedCredentials)
            return
        }
        preferences.edit {
            putString(KEY_SERVER_URL, sanitizedCredentials.serverUrl)
            putString(KEY_ENCRYPTION_SEED, sanitizedCredentials.encryptionSeed)
            putString(KEY_PAIRED_USER_ID, sanitizedCredentials.pairedUserId)
            putString(KEY_AUTH_JWT, sanitizedCredentials.authJwt)
            putString(KEY_AUTH_USER_ID, sanitizedCredentials.authUserId)
            putString(KEY_ORG_ID, sanitizedCredentials.orgId)
            putString(KEY_PERSONAL_USER_ID, sanitizedCredentials.personalUserId)
            putString(KEY_PERSONAL_ORG_ID, sanitizedCredentials.personalOrgId)
            putString(KEY_SESSION_TOKEN, sanitizedCredentials.sessionToken)
            putString(KEY_AUTH_EMAIL, sanitizedCredentials.authEmail)
            putString(KEY_AUTH_EXPIRES_AT, sanitizedCredentials.authExpiresAt)
        }
        _state.value = PairingState(sanitizedCredentials)
    }

    fun saveAuthSession(session: AuthCallbackData) {
        val existing = _state.value.credentials ?: return
        savePairing(
            existing.copy(
                authJwt = session.sessionJwt,
                authUserId = session.userId,
                orgId = session.orgId,
                sessionToken = session.sessionToken,
                authEmail = session.email,
                authExpiresAt = session.expiresAt
            )
        )
    }

    fun clearPairing() {
        preferences?.edit { clear() }
        _state.value = PairingState()
    }

    private fun openWithRecovery(): SharedPreferences? {
        var failure: Throwable? = null
        repeat(OPEN_ATTEMPTS) {
            try {
                return openPreferences(context)
            } catch (error: Throwable) {
                if (!isUnreadablePrefsError(error)) throw error
                failure = error
            }
        }
        return resetAndReopen(failure!!)
    }

    private fun loadStateWithRecovery(): PairingState {
        val preferences = preferences ?: return PairingState()
        return try {
            loadState(preferences)
        } catch (error: Throwable) {
            if (!isUnreadablePrefsError(error)) throw error
            this.preferences = resetAndReopen(error)
            PairingState()
        }
    }

    private fun resetAndReopen(cause: Throwable): SharedPreferences? {
        // Logged before deleting so the reset is visible even if the process dies.
        Log.w(
            TAG,
            "Pairing storage '$PREFS_NAME' cannot be decrypted; deleting it and starting unpaired. " +
                "Re-scan the desktop QR code to pair again.",
            cause
        )
        context.deleteSharedPreferences(PREFS_NAME)
        return try {
            openPreferences(context)
        } catch (error: Throwable) {
            if (!isUnreadablePrefsError(error)) throw error
            Log.e(TAG, "Pairing storage still unusable after reset; pairing will not persist.", error)
            null
        }
    }

    private fun loadState(preferences: SharedPreferences): PairingState {
        val serverUrl = preferences.getString(KEY_SERVER_URL, null)
        val encryptionSeed = preferences.getString(KEY_ENCRYPTION_SEED, null)
        val pairedUserId = preferences.getString(KEY_PAIRED_USER_ID, null)
        val authJwt = preferences.getString(KEY_AUTH_JWT, null)
        val authUserId = preferences.getString(KEY_AUTH_USER_ID, null)
        val orgId = preferences.getString(KEY_ORG_ID, null)
        val personalUserId = preferences.getString(KEY_PERSONAL_USER_ID, null)
        val personalOrgId = preferences.getString(KEY_PERSONAL_ORG_ID, null)
        val sessionToken = preferences.getString(KEY_SESSION_TOKEN, null)
        val authEmail = preferences.getString(KEY_AUTH_EMAIL, null)
        val authExpiresAt = preferences.getString(KEY_AUTH_EXPIRES_AT, null)

        return if (serverUrl.isNullOrBlank() || encryptionSeed.isNullOrBlank()) {
            PairingState()
        } else {
            PairingState(
                PairingCredentials(
                    serverUrl = serverUrl,
                    encryptionSeed = encryptionSeed,
                    pairedUserId = pairedUserId,
                    authJwt = authJwt,
                    authUserId = authUserId,
                    orgId = orgId,
                    personalUserId = personalUserId,
                    personalOrgId = personalOrgId,
                    sessionToken = sessionToken,
                    authEmail = authEmail,
                    authExpiresAt = authExpiresAt
                )
            )
        }
    }

    internal companion object {
        private const val TAG = "PairingStore"
        internal const val PREFS_NAME = "nimbalyst_pairing"
        private const val OPEN_ATTEMPTS = 2

        private fun openEncryptedPreferences(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }

        // Keystore and Tink failures: GeneralSecurityException covers
        // AEADBadTagException and KeyStoreException; a corrupt keyset surfaces as
        // an IOException (InvalidProtocolBufferException); Keystore can also throw
        // ProviderException; a value that fails to decrypt on read is a
        // SecurityException from EncryptedSharedPreferences.
        internal fun isUnreadablePrefsError(error: Throwable): Boolean =
            error is GeneralSecurityException ||
                error is IOException ||
                error is ProviderException ||
                error is SecurityException

        const val KEY_SERVER_URL = "server_url"
        const val KEY_ENCRYPTION_SEED = "encryption_seed"
        const val KEY_PAIRED_USER_ID = "paired_user_id"
        const val KEY_AUTH_JWT = "auth_jwt"
        const val KEY_AUTH_USER_ID = "auth_user_id"
        const val KEY_ORG_ID = "org_id"
        const val KEY_PERSONAL_USER_ID = "personal_user_id"
        const val KEY_PERSONAL_ORG_ID = "personal_org_id"
        const val KEY_SESSION_TOKEN = "session_token"
        const val KEY_AUTH_EMAIL = "auth_email"
        const val KEY_AUTH_EXPIRES_AT = "auth_expires_at"
    }
}
