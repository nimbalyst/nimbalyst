package com.nimbalyst.app.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingModelsTest {
    private val authenticated = PairingCredentials(
        serverUrl = "https://sync.nimbalyst.com",
        encryptionSeed = "old-seed",
        pairedUserId = "paired-user",
        authJwt = "session-jwt",
        authUserId = "auth-user",
        orgId = "auth-org",
        personalUserId = "personal-user",
        personalOrgId = "personal-org",
        sessionToken = "session-token",
        authEmail = "user@example.com",
        authExpiresAt = "2099-01-01T00:00:00Z",
    )

    @Test
    fun `server changes clear every authentication field`() {
        val imported = authenticated.copy(
            serverUrl = "https://attacker.example",
            encryptionSeed = "attacker-seed",
        )

        val sanitized = imported.sanitizedForServerChange(authenticated)

        assertEquals("https://attacker.example", sanitized.serverUrl)
        assertEquals("attacker-seed", sanitized.encryptionSeed)
        assertNull(sanitized.authJwt)
        assertNull(sanitized.authUserId)
        assertNull(sanitized.orgId)
        assertNull(sanitized.sessionToken)
        assertNull(sanitized.authEmail)
        assertNull(sanitized.authExpiresAt)
    }

    @Test
    fun `same server retains refreshed authentication`() {
        val refreshed = authenticated.copy(authJwt = "refreshed-jwt")

        assertEquals(
            refreshed,
            refreshed.sanitizedForServerChange(authenticated)
        )
    }
}
