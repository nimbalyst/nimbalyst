package com.nimbalyst.app.auth

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

/**
 * Parses `nimbalyst://auth/callback`. Stateless: the caller decides where a failure is
 * shown (MainActivity hands it to the sign-in screen through the navigation state).
 */
object AuthCallbackParser {
    fun parse(
        deepLink: String,
        pairedUserId: String?
    ): AuthCallbackParseResult = parseCallback(deepLink, pairedUserId)

    /**
     * Error text for a callback that carries `error` / `error_description`, or
     * null when it is not an error. The collab worker redirects here with those
     * parameters when sign-in fails server-side. Mirrors iOS
     * `AuthManager.authErrorMessage(fromCallbackParams:)`.
     */
    internal fun serverErrorMessage(params: Map<String, String>): String? {
        params["error_description"]?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
        val code = params["error"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        // A bare code is not a sentence; wrap it so the UI reads as a message.
        return "Sign-in failed ($code)."
    }

    private fun parseCallback(
        deepLink: String,
        pairedUserId: String?
    ): AuthCallbackParseResult {
        val uri = runCatching { URI(deepLink) }.getOrNull()
            ?: return AuthCallbackParseResult.Failure("Invalid auth callback URL.")

        if (uri.scheme != "nimbalyst" || uri.host != "auth" || uri.path != "/callback") {
            return AuthCallbackParseResult.Failure("Unsupported auth callback URL.")
        }

        val params = parseQuery(uri.rawQuery)
        serverErrorMessage(params)?.let { return AuthCallbackParseResult.Failure(it) }

        val sessionToken = params["session_token"]
        val sessionJwt = params["session_jwt"]
        val userId = params["user_id"]
        val orgId = params["org_id"]
        val email = params["email"]

        if (sessionToken.isNullOrBlank() || sessionJwt.isNullOrBlank() || userId.isNullOrBlank() || orgId.isNullOrBlank()) {
            return AuthCallbackParseResult.Failure("Missing required auth parameters.")
        }

        if (!pairedUserId.isNullOrBlank() &&
            pairedUserId.contains("@") &&
            !email.isNullOrBlank() &&
            !email.equals(pairedUserId, ignoreCase = true)
        ) {
            return AuthCallbackParseResult.Failure("Wrong account. Sign in with $pairedUserId to match desktop pairing.")
        }

        return AuthCallbackParseResult.Success(
            AuthCallbackData(
                sessionToken = sessionToken,
                sessionJwt = sessionJwt,
                userId = userId,
                email = email,
                expiresAt = params["expires_at"],
                orgId = orgId
            )
        )
    }

    private fun parseQuery(rawQuery: String?): Map<String, String> {
        if (rawQuery.isNullOrBlank()) {
            return emptyMap()
        }

        return rawQuery.split("&")
            .mapNotNull { part ->
                val pieces = part.split("=", limit = 2)
                if (pieces.size != 2) {
                    null
                } else {
                    URLDecoder.decode(pieces[0], StandardCharsets.UTF_8) to
                        URLDecoder.decode(pieces[1], StandardCharsets.UTF_8)
                }
            }
            .toMap()
    }
}
