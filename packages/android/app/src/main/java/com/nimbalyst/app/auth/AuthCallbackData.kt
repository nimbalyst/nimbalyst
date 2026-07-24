package com.nimbalyst.app.auth

data class AuthCallbackData(
    val sessionToken: String,
    val sessionJwt: String,
    val userId: String,
    val email: String?,
    val expiresAt: String?,
    val orgId: String
)

sealed interface AuthCallbackParseResult {
    data class Success(val data: AuthCallbackData) : AuthCallbackParseResult
    data class Failure(val reason: String) : AuthCallbackParseResult
}
