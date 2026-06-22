package com.nimbalyst.app.auth

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Holds the computed URL and JSON body for a magic-link request. */
data class MagicLinkRequest(
    val url: String,
    val bodyJson: String,
)

/**
 * Returns true when [pairedEmail] looks like a valid email address that can
 * receive a magic link. Pure function — no I/O.
 */
fun hasEmailAccount(pairedEmail: String?): Boolean =
    !pairedEmail.isNullOrBlank() && pairedEmail.contains("@")

/**
 * HTTP helper for the Stytch magic-link sign-in path.
 *
 * Mirrors iOS `AuthManager.sendMagicLink` (packages/ios/.../Auth/AuthManager.swift).
 */
object MagicLinkClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Build a [MagicLinkRequest] from a raw server URL and email address.
     *
     * Normalizes [serverUrl] the same way [LoginScreen] does for OAuth:
     * `wss://` → `https://`, `ws://` → `http://`, trailing `/` trimmed.
     *
     * This is a pure function with no I/O — unit-testable without a network call.
     */
    fun buildRequest(serverUrl: String, email: String): MagicLinkRequest {
        val base = serverUrl
            .replace("wss://", "https://")
            .replace("ws://", "http://")
            .trimEnd('/')

        val url = "$base/api/auth/magic-link"
        val bodyJson = JSONObject().apply {
            put("email", email)
            put("redirect_url", "$base/auth/callback")
        }.toString()

        return MagicLinkRequest(url = url, bodyJson = bodyJson)
    }

    /**
     * Send a magic-link request to the server.
     *
     * Runs on [Dispatchers.IO]. Returns [Result.success] on HTTP 200;
     * [Result.failure] with the server `error` field (or a fallback message)
     * on any other status; [Result.failure] with the thrown exception on
     * network/IO errors.
     */
    suspend fun sendMagicLink(serverUrl: String, email: String): Result<Unit> =
        withContext(Dispatchers.IO) {
            runCatching {
                val req = buildRequest(serverUrl, email)
                val body = req.bodyJson.toRequestBody("application/json".toMediaType())
                val httpRequest = Request.Builder()
                    .url(req.url)
                    .post(body)
                    .build()

                client.newCall(httpRequest).execute().use { response ->
                    if (response.code == 200) {
                        return@withContext Result.success(Unit)
                    }
                    val raw = response.body?.string() ?: ""
                    val message = runCatching {
                        JSONObject(raw).optString("error").ifBlank { null }
                    }.getOrNull() ?: "Failed to send magic link"
                    return@withContext Result.failure(Exception(message))
                }
            }
        }
}
