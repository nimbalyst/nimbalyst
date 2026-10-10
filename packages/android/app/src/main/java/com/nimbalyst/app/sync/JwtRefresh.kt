package com.nimbalyst.app.sync

import android.util.Log
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.nimbalyst.app.pairing.PairingCredentials
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// Stytch JWTs expire after ~5 minutes. Refresh every 4 minutes to stay connected.
internal const val JWT_REFRESH_INTERVAL_MS = 4L * 60L * 1000L

/** What one refresh attempt proved. Only [Rejected] says anything about the session itself. */
sealed interface TokenRefresh {
    data class Refreshed(val credentials: PairingCredentials) : TokenRefresh

    /** The auth server refused the session token (401/403), or there is no token to send. */
    data object Rejected : TokenRefresh

    /** No verdict on the session: offline, a timeout, a server error, an unreadable answer. */
    data object Unavailable : TokenRefresh
}

/** Exchanges the stored session token for a fresh JWT. */
fun interface TokenRefresher {
    suspend fun refresh(credentials: PairingCredentials): TokenRefresh
}

internal data class JwtClaims(
    val sub: String?,
    val orgId: String?
)

internal fun extractJwtClaims(jwt: String, gson: Gson): JwtClaims? {
    val parts = jwt.split('.')
    if (parts.size != 3) {
        return null
    }

    val payload = runCatching {
        val normalized = parts[1]
            .replace('-', '+')
            .replace('_', '/')
            .let { value ->
                val padding = value.length % 4
                if (padding == 0) value else value + "=".repeat(4 - padding)
            }
        String(java.util.Base64.getDecoder().decode(normalized), StandardCharsets.UTF_8)
    }.getOrNull() ?: return null

    val json = runCatching { gson.fromJson(payload, JsonObject::class.java) }.getOrNull() ?: return null
    val orgId = json.getAsJsonObject("https://stytch.com/organization")
        ?.get("organization_id")
        ?.takeIf { !it.isJsonNull }
        ?.asString

    return JwtClaims(
        sub = json.get("sub")?.takeIf { !it.isJsonNull }?.asString,
        orgId = orgId
    )
}

internal class HttpTokenRefresher(private val gson: Gson) : TokenRefresher {
    override suspend fun refresh(credentials: PairingCredentials): TokenRefresh =
        withContext(Dispatchers.IO) { refreshBlocking(credentials) }

    private fun refreshBlocking(credentials: PairingCredentials): TokenRefresh {
        val sessionToken = credentials.sessionToken
        if (sessionToken.isNullOrBlank()) {
            Log.d(TAG, "No session token available for JWT refresh")
            return TokenRefresh.Rejected
        }

        val baseUrl = credentials.serverUrl
            .replace("wss://", "https://")
            .replace("ws://", "http://")
            .trimEnd('/')

        return try {
            val url = URL("$baseUrl/auth/refresh")
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                outputStream.write("""{"session_token":"$sessionToken"}""".toByteArray())
            }

            val responseCode = connection.responseCode
            if (responseCode != 200) {
                Log.w(TAG, "JWT refresh failed with status $responseCode")
                return if (responseCode == 401 || responseCode == 403) TokenRefresh.Rejected else TokenRefresh.Unavailable
            }

            val responseBody = connection.inputStream.bufferedReader().readText()
            val json = gson.fromJson(responseBody, JsonObject::class.java) ?: return TokenRefresh.Unavailable
            fun field(name: String) = json.get(name)?.takeIf { !it.isJsonNull }?.asString

            val newJwt = field("session_jwt")
            if (newJwt.isNullOrBlank()) {
                Log.w(TAG, "JWT refresh response missing session_jwt")
                return TokenRefresh.Unavailable
            }

            TokenRefresh.Refreshed(credentials.copy(
                authJwt = newJwt,
                sessionToken = field("session_token") ?: sessionToken,
                authUserId = field("user_id") ?: credentials.authUserId,
                authEmail = field("email") ?: credentials.authEmail,
                authExpiresAt = field("expires_at") ?: credentials.authExpiresAt,
                orgId = field("org_id") ?: credentials.orgId
            ))
        } catch (e: Exception) {
            // Offline or unreachable: says nothing about whether the session is still valid.
            Log.w(TAG, "JWT refresh request failed: ${e.message}")
            TokenRefresh.Unavailable
        }
    }

    private companion object {
        const val TAG = "JwtRefresh"
        const val TIMEOUT_MS = 15_000
    }
}
