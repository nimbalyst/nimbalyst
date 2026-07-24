package com.nimbalyst.app.crypto

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class CryptoManagerTest {
    @Test
    fun `deriveKey matches existing javascript test vector`() {
        val keyBytes = CryptoManager.deriveKey(
            passphrase = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw==",
            salt = "nimbalyst:user-test-12345"
        )

        assertEquals(
            "cVkuSqOYHOm1+QB5kTWOvRCHFzqKzjtsU+7XVBvX8fg=",
            Base64.getEncoder().encodeToString(keyBytes)
        )
    }

    @Test
    fun `decrypt matches ios compatibility vector`() {
        val crypto = CryptoManager.fromSeed(
            seed = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw==",
            userId = "user-test-12345"
        )

        val plaintext = crypto.decrypt(
            encryptedBase64 = "07DfjrYjG0f1/3swnwWVpq6LsGZnw02+Kx4vzmu78YPm",
            ivBase64 = "AQIDBAUGBwgJCgsM"
        )

        assertEquals("Hello, Nimbalyst!", plaintext)
    }

    @Test
    fun `encryptProjectId matches deterministic ios output`() {
        val crypto = CryptoManager.fromSeed(
            seed = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw==",
            userId = "user-test-12345"
        )

        assertEquals(
            "H1T7Lpn6jiQaYXIFnwfeUGC5RmzhJP2NN1XvmexO3MDcJqIRur7fEhX0gu/nFZclT4WlhA==",
            crypto.encryptProjectId("/Users/ghinkle/sources/stravu-editor")
        )
    }

    @Test
    fun `decryptOrNull returns null for invalid payload`() {
        val crypto = CryptoManager.fromSeed(
            seed = "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw==",
            userId = "user-test-12345"
        )

        assertNull(crypto.decryptOrNull("nope", "still-nope"))
        assertThrows(CryptoException::class.java) {
            crypto.decrypt("nope", "still-nope")
        }
    }
}
