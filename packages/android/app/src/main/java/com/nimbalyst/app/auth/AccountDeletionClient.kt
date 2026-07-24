package com.nimbalyst.app.auth

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * HTTP helper for permanent account deletion.
 *
 * Mirrors iOS `AuthManager.deleteAccount` (packages/ios/.../Auth/AuthManager.swift):
 * `POST {server}/api/account/delete` with the session JWT as a bearer token. The
 * server purges the user's server-side rooms/data; the caller clears local state
 * on success.
 */
object AccountDeletionClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Build the account-deletion endpoint URL from a raw server URL.
     *
     * Normalizes [serverUrl] the same way [MagicLinkClient] does:
     * `wss://` → `https://`, `ws://` → `http://`, trailing `/` trimmed.
     *
     * Pure function with no I/O — unit-testable without a network call.
     */
    fun buildUrl(serverUrl: String): String {
        val base = serverUrl
            .replace("wss://", "https://")
            .replace("ws://", "http://")
            .trimEnd('/')
        return "$base/api/account/delete"
    }

    /**
     * Request permanent account deletion.
     *
     * Runs on [Dispatchers.IO]. Returns [Result.success] on HTTP 200;
     * [Result.failure] with the server `error` field (or a fallback message) on
     * any other status; [Result.failure] with the thrown exception on network/IO
     * errors. Returns failure if [jwt] is blank (not authenticated).
     */
    suspend fun deleteAccount(serverUrl: String, jwt: String?): Result<Unit> =
        withContext(Dispatchers.IO) {
            if (jwt.isNullOrBlank()) {
                return@withContext Result.failure(Exception("Not authenticated"))
            }
            runCatching {
                val url = buildUrl(serverUrl)
                val body = "{}".toRequestBody("application/json".toMediaType())
                val httpRequest = Request.Builder()
                    .url(url)
                    .header("Authorization", "Bearer $jwt")
                    .post(body)
                    .build()

                client.newCall(httpRequest).execute().use { response ->
                    if (response.code == 200) {
                        return@withContext Result.success(Unit)
                    }
                    val raw = response.body?.string() ?: ""
                    val message = runCatching {
                        org.json.JSONObject(raw).optString("error").ifBlank { null }
                    }.getOrNull() ?: "Account deletion failed (HTTP ${response.code})"
                    return@withContext Result.failure(Exception(message))
                }
            }
        }
}
