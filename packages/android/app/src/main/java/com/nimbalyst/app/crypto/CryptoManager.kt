package com.nimbalyst.app.crypto

import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

class CryptoManager private constructor(
    private val key: SecretKeySpec
) {
    companion object {
        const val projectIdIvBase64 = "cHJvamVjdF9pZF9p"

        fun deriveKey(passphrase: String, salt: String): ByteArray {
            val keySpec = PBEKeySpec(passphrase.toCharArray(), salt.toByteArray(StandardCharsets.UTF_8), 100_000, 256)
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(keySpec).encoded
        }

        fun fromSeed(seed: String, userId: String): CryptoManager {
            val keyBytes = deriveKey(seed, "nimbalyst:$userId")
            return CryptoManager(SecretKeySpec(keyBytes, "AES"))
        }
    }

    fun decrypt(encryptedBase64: String, ivBase64: String): String {
        val encryptedBytes = try {
            Base64.getDecoder().decode(encryptedBase64)
        } catch (error: IllegalArgumentException) {
            throw CryptoException("Invalid encrypted payload base64", error)
        }
        val ivBytes = try {
            Base64.getDecoder().decode(ivBase64)
        } catch (error: IllegalArgumentException) {
            throw CryptoException("Invalid IV base64", error)
        }

        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, ivBytes))
            String(cipher.doFinal(encryptedBytes), StandardCharsets.UTF_8)
        } catch (error: GeneralSecurityException) {
            throw CryptoException("Failed to decrypt payload", error)
        }
    }

    fun decryptOrNull(encryptedBase64: String?, ivBase64: String?): String? {
        if (encryptedBase64.isNullOrBlank() || ivBase64.isNullOrBlank()) {
            return null
        }
        return runCatching { decrypt(encryptedBase64, ivBase64) }.getOrNull()
    }

    fun encrypt(plaintext: String): EncryptedPayload {
        val ivBytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return encryptInternal(plaintext.toByteArray(StandardCharsets.UTF_8), ivBytes)
    }

    fun encryptData(data: ByteArray): EncryptedPayload {
        val ivBytes = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return encryptInternal(data, ivBytes)
    }

    fun encryptProjectId(projectId: String): String {
        val ivBytes = Base64.getDecoder().decode(projectIdIvBase64)
        return encryptInternal(projectId.toByteArray(StandardCharsets.UTF_8), ivBytes).encrypted
    }

    private fun encryptInternal(data: ByteArray, ivBytes: ByteArray): EncryptedPayload {
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, ivBytes))
            val encrypted = cipher.doFinal(data)
            EncryptedPayload(
                encrypted = Base64.getEncoder().encodeToString(encrypted),
                iv = Base64.getEncoder().encodeToString(ivBytes)
            )
        } catch (error: GeneralSecurityException) {
            throw CryptoException("Failed to encrypt payload", error)
        }
    }
}

data class EncryptedPayload(
    val encrypted: String,
    val iv: String
)

class CryptoException(
    message: String,
    cause: Throwable? = null
) : IllegalStateException(message, cause)
