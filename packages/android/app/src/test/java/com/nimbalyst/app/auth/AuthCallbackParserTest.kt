package com.nimbalyst.app.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthCallbackParserTest {
    @Test
    fun `parse valid auth callback`() {
        val result = AuthCallbackParser.parse(
            deepLink = "nimbalyst://auth/callback?session_token=tok-1&session_jwt=jwt-1&user_id=user-1&org_id=org-1&email=user%40example.com",
            pairedUserId = "user@example.com"
        )

        assertTrue(result is AuthCallbackParseResult.Success)
        val data = (result as AuthCallbackParseResult.Success).data
        assertEquals("tok-1", data.sessionToken)
        assertEquals("jwt-1", data.sessionJwt)
        assertEquals("user-1", data.userId)
        assertEquals("org-1", data.orgId)
        assertEquals("user@example.com", data.email)
    }

    @Test
    fun `reject email mismatch`() {
        val result = AuthCallbackParser.parse(
            deepLink = "nimbalyst://auth/callback?session_token=tok-1&session_jwt=jwt-1&user_id=user-1&org_id=org-1&email=wrong%40example.com",
            pairedUserId = "user@example.com"
        )

        assertTrue(result is AuthCallbackParseResult.Failure)
    }

    @Test
    fun `reject missing parameters`() {
        val result = AuthCallbackParser.parse(
            deepLink = "nimbalyst://auth/callback?session_token=tok-1",
            pairedUserId = null
        )

        assertTrue(result is AuthCallbackParseResult.Failure)
    }
}
