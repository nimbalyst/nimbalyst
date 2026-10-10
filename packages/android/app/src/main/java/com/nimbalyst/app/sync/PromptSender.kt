package com.nimbalyst.app.sync

import com.nimbalyst.app.attachments.ImageCompressor.CompressedImage
import com.nimbalyst.app.attachments.ImageCompressor
import com.nimbalyst.app.attachments.PendingAttachment
import com.nimbalyst.app.crypto.CryptoManager
import com.nimbalyst.app.data.NimbalystRepository
import com.nimbalyst.app.data.QueuedPromptEntity
import java.util.UUID
import kotlinx.coroutines.CancellationException

/**
 * Queues a prompt for the desktop: encrypts the text and attachments,
 * publishes it on the index, and records it locally only once the room has
 * confirmed receipt. Never replayed: a prompt resent after reconnect could run
 * twice, so a send that is not confirmed fails and the caller hands the text
 * back to the user.
 */
internal class PromptSender(
    private val repository: NimbalystRepository,
    private val indexUpdates: SessionIndexUpdates,
    private val crypto: () -> CryptoManager?,
    private val isIndexConnected: () -> Boolean,
    /** Returns once the room confirmed the frame, false if it may not have arrived. */
    private val sendIndex: suspend (String) -> Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    private val compress: (PendingAttachment) -> CompressedImage? = { ImageCompressor.compress(it.bitmap) },
) {
    /** Returns the queued prompt's id on success. Cancellation propagates; it is never reported as a failed send. */
    suspend fun send(sessionId: String, text: String, attachments: List<PendingAttachment>): Result<String> {
        val promptText = text.trim()
        if (promptText.isBlank() && attachments.isEmpty()) {
            return Result.failure(IllegalArgumentException("Prompt cannot be empty."))
        }
        val crypto = crypto() ?: return Result.failure(IllegalStateException("Sync is not ready."))
        if (!isIndexConnected()) return Result.failure(IllegalStateException("Index room is not connected."))

        return try {
            val session = repository.getSession(sessionId) ?: error("Session not found.")
            val now = clock()
            val promptId = UUID.randomUUID().toString()
            val encryptedPrompt = crypto.encrypt(promptText)
            val queuedPrompt = EncryptedQueuedPrompt(
                id = promptId,
                encryptedPrompt = encryptedPrompt.encrypted,
                iv = encryptedPrompt.iv,
                timestamp = now,
                source = "keyboard"
            ).also { prompt ->
                prompt.encryptedAttachments = attachments.map { attachment ->
                    // Sending without an image the user attached would be a different prompt.
                    val compressed = compress(attachment) ?: error("An image could not be prepared for sending.")
                    val encrypted = crypto.encryptData(compressed.data)
                    WireEncryptedAttachment(
                        id = attachment.id,
                        filename = attachment.filename,
                        mimeType = "image/jpeg",
                        encryptedData = encrypted.encrypted,
                        iv = encrypted.iv,
                        size = compressed.data.size,
                        width = compressed.width,
                        height = compressed.height
                    )
                }.takeIf { it.isNotEmpty() }
            }

            val update = indexUpdates.prompt(session, queuedPrompt, crypto)
            check(sendIndex(update)) { "The desktop did not confirm your prompt. Check the session before sending it again." }

            repository.upsertQueuedPrompt(
                QueuedPromptEntity(
                    id = promptId,
                    sessionId = sessionId,
                    promptTextEncrypted = encryptedPrompt.encrypted,
                    iv = encryptedPrompt.iv,
                    createdAt = now,
                    sentAt = now,
                    promptTextDecrypted = promptText,
                    source = null
                )
            )
            repository.upsertSession(session.copy(hasQueuedPrompts = true, updatedAt = now, lastMessageAt = now))
            Result.success(promptId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Result.failure(error)
        }
    }
}
