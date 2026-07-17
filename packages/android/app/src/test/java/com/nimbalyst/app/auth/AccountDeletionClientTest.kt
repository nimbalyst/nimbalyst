package com.nimbalyst.app.auth

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountDeletionClientTest {

    @Test
    fun `buildUrl produces correct endpoint for https server`() {
        assertEquals(
            "https://example.com/api/account/delete",
            AccountDeletionClient.buildUrl("https://example.com")
        )
    }

    @Test
    fun `buildUrl normalizes wss to https and trims trailing slash`() {
        assertEquals(
            "https://host.example.com/api/account/delete",
            AccountDeletionClient.buildUrl("wss://host.example.com/")
        )
    }

    @Test
    fun `buildUrl normalizes ws to http`() {
        assertEquals(
            "http://localhost:3000/api/account/delete",
            AccountDeletionClient.buildUrl("ws://localhost:3000")
        )
    }

    @Test
    fun `deleteAccount fails fast when jwt is null`() = runBlocking {
        val result = AccountDeletionClient.deleteAccount("wss://example.com", null)
        assertTrue(result.isFailure)
        assertEquals("Not authenticated", result.exceptionOrNull()?.message)
    }

    @Test
    fun `deleteAccount fails fast when jwt is blank`() = runBlocking {
        val result = AccountDeletionClient.deleteAccount("wss://example.com", "   ")
        assertTrue(result.isFailure)
        assertEquals("Not authenticated", result.exceptionOrNull()?.message)
    }
}
