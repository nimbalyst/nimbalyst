package com.nimbalyst.app.auth

import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

object AuthCallbackParser {
    fun parse(
        deepLink: String,
        pairedUserId: String?
    ): AuthCallbackParseResult {
        val uri = runCatching { URI(deepLink) }.getOrNull()
            ?: return AuthCallbackParseResult.Failure("Invalid auth callback URL.")

        if (uri.scheme != "nimbalyst" || uri.host != "auth" || uri.path != "/callback") {
            return AuthCallbackParseResult.Failure("Unsupported auth callback URL.")
        }

        val params = parseQuery(uri.rawQuery)
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
