package com.nimbalyst.app.pairing

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.nimbalyst.app.auth.AuthCallbackData
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class PairingStore(context: Context) {
    private val appContext = context.applicationContext
    private val masterKey = MasterKey.Builder(appContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val preferences = createPreferencesWithRecovery()

    private val _state = MutableStateFlow(loadState())
    val state: StateFlow<PairingState> = _state.asStateFlow()

    fun savePairing(credentials: PairingCredentials) {
        preferences.edit {
            putString(KEY_SERVER_URL, credentials.serverUrl)
            putString(KEY_ENCRYPTION_SEED, credentials.encryptionSeed)
            putString(KEY_PAIRED_USER_ID, credentials.pairedUserId)
            putString(KEY_AUTH_JWT, credentials.authJwt)
            putString(KEY_AUTH_USER_ID, credentials.authUserId)
            putString(KEY_ORG_ID, credentials.orgId)
            putString(KEY_PERSONAL_USER_ID, credentials.personalUserId)
            putString(KEY_PERSONAL_ORG_ID, credentials.personalOrgId)
            putString(KEY_SESSION_TOKEN, credentials.sessionToken)
            putString(KEY_AUTH_EMAIL, credentials.authEmail)
            putString(KEY_AUTH_EXPIRES_AT, credentials.authExpiresAt)
        }
        _state.value = PairingState(credentials)
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
        preferences.edit { clear() }
        _state.value = PairingState()
    }

    private fun loadState(): PairingState {
        val values = runCatching {
            LoadedValues(
                serverUrl = preferences.getString(KEY_SERVER_URL, null),
                encryptionSeed = preferences.getString(KEY_ENCRYPTION_SEED, null),
                pairedUserId = preferences.getString(KEY_PAIRED_USER_ID, null),
                authJwt = preferences.getString(KEY_AUTH_JWT, null),
                authUserId = preferences.getString(KEY_AUTH_USER_ID, null),
                orgId = preferences.getString(KEY_ORG_ID, null),
                personalUserId = preferences.getString(KEY_PERSONAL_USER_ID, null),
                personalOrgId = preferences.getString(KEY_PERSONAL_ORG_ID, null),
                sessionToken = preferences.getString(KEY_SESSION_TOKEN, null),
                authEmail = preferences.getString(KEY_AUTH_EMAIL, null),
                authExpiresAt = preferences.getString(KEY_AUTH_EXPIRES_AT, null)
            )
        }.getOrElse { error ->
            Log.w(TAG, "Unable to read pairing preferences; clearing corrupted pairing state.", error)
            runCatching { preferences.edit { clear() } }
            clearStoredPreferences(appContext)
            return PairingState()
        }

        return if (values.serverUrl.isNullOrBlank() || values.encryptionSeed.isNullOrBlank()) {
            PairingState()
        } else {
            PairingState(
                PairingCredentials(
                    serverUrl = values.serverUrl,
                    encryptionSeed = values.encryptionSeed,
                    pairedUserId = values.pairedUserId,
                    authJwt = values.authJwt,
                    authUserId = values.authUserId,
                    orgId = values.orgId,
                    personalUserId = values.personalUserId,
                    personalOrgId = values.personalOrgId,
                    sessionToken = values.sessionToken,
                    authEmail = values.authEmail,
                    authExpiresAt = values.authExpiresAt
                )
            )
        }
    }

    private fun createPreferencesWithRecovery(): SharedPreferences {
        return runCatching {
            createEncryptedPreferences()
        }.getOrElse { error ->
            Log.w(TAG, "Encrypted pairing preferences unavailable; resetting pairing state.", error)
            clearStoredPreferences(appContext)
            createEncryptedPreferences()
        }
    }

    private fun createEncryptedPreferences(): SharedPreferences {
        return EncryptedSharedPreferences.create(
            appContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    private data class LoadedValues(
        val serverUrl: String?,
        val encryptionSeed: String?,
        val pairedUserId: String?,
        val authJwt: String?,
        val authUserId: String?,
        val orgId: String?,
        val personalUserId: String?,
        val personalOrgId: String?,
        val sessionToken: String?,
        val authEmail: String?,
        val authExpiresAt: String?
    )

    private companion object {
        const val TAG = "PairingStore"
        const val PREFS_NAME = "nimbalyst_pairing"
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

        fun clearStoredPreferences(context: Context) {
            runCatching {
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .clear()
                    .commit()
            }
            runCatching {
                File(context.applicationInfo.dataDir, "shared_prefs/$PREFS_NAME.xml").delete()
            }
        }
    }
}
