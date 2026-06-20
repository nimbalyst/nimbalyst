package com.nimbalyst.app.auth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class MagicLinkRequestTest {

    @Test
    fun `buildRequest produces correct url and body for https server`() {
        val request = MagicLinkClient.buildRequest(
            serverUrl = "https://example.com",
            email = "user@example.com"
        )

        assertEquals("https://example.com/api/auth/magic-link", request.url)

        val body = JSONObject(request.bodyJson)
        assertEquals("user@example.com", body.getString("email"))
        assertEquals("https://example.com/auth/callback", body.getString("redirect_url"))
    }

    @Test
    fun `buildRequest normalizes wss to https and trims trailing slash`() {
        val request = MagicLinkClient.buildRequest(
            serverUrl = "wss://host.example.com/",
            email = "test@example.com"
        )

        assertEquals("https://host.example.com/api/auth/magic-link", request.url)

        val body = JSONObject(request.bodyJson)
        assertEquals("test@example.com", body.getString("email"))
        assertEquals("https://host.example.com/auth/callback", body.getString("redirect_url"))
    }

    @Test
    fun `buildRequest normalizes ws to http`() {
        val request = MagicLinkClient.buildRequest(
            serverUrl = "ws://localhost:3000",
            email = "dev@example.com"
        )

        assertEquals("http://localhost:3000/api/auth/magic-link", request.url)

        val body = JSONObject(request.bodyJson)
        assertEquals("dev@example.com", body.getString("email"))
        assertEquals("http://localhost:3000/auth/callback", body.getString("redirect_url"))
    }

    @Test
    fun `buildRequest trims trailing slash without protocol change`() {
        val request = MagicLinkClient.buildRequest(
            serverUrl = "https://prod.example.com/",
            email = "prod@example.com"
        )

        assertEquals("https://prod.example.com/api/auth/magic-link", request.url)
    }

    // hasEmailAccount tests

    @Test
    fun `hasEmailAccount returns false for null`() {
        assertEquals(false, hasEmailAccount(null))
    }

    @Test
    fun `hasEmailAccount returns false for empty string`() {
        assertEquals(false, hasEmailAccount(""))
    }

    @Test
    fun `hasEmailAccount returns false for blank string`() {
        assertEquals(false, hasEmailAccount("   "))
    }

    @Test
    fun `hasEmailAccount returns false for string without at sign`() {
        assertEquals(false, hasEmailAccount("notanemail"))
    }

    @Test
    fun `hasEmailAccount returns true for valid email`() {
        assertEquals(true, hasEmailAccount("chris@thebrutus.org"))
    }
}
