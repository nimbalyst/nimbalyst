package com.nimbalyst.app.pairing

import android.content.Context
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.nimbalyst.app.auth.AuthCallbackData
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class PairingStore(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val preferences = EncryptedSharedPreferences.create(
        context,
        "nimbalyst_pairing",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    private val _state = MutableStateFlow(loadState())
    val state: StateFlow<PairingState> = _state.asStateFlow()

    fun savePairing(credentials: PairingCredentials) {
        val sanitizedCredentials = credentials.sanitizedForServerChange(_state.value.credentials)
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
        preferences.edit { clear() }
        _state.value = PairingState()
    }

    private fun loadState(): PairingState {
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

    private companion object {
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
