package com.nimbalyst.app.transcript

import com.google.gson.Gson
import com.nimbalyst.app.data.MessageEntity

/** Session-level fields the transcript renders; compared to decide on `updateMetadata`. */
data class TranscriptMetadata(
    val title: String,
    val provider: String,
    val model: String,
    val mode: String,
    val isExecuting: Boolean,
)

/**
 * Builds the JSON arguments for `window.nimbalyst.*` calls. Every value is a
 * JSON document, which is also a valid JS expression, so callers splice it
 * straight into the script.
 */
object TranscriptPayloadBuilder {
    private val gson = Gson()

    fun buildSessionPayload(
        sessionId: String,
        sessionTitle: String,
        provider: String,
        model: String,
        mode: String,
        messages: List<MessageEntity>,
        isExecuting: Boolean = false,
        replace: Boolean = false,
    ): String = buildSessionPayload(
        sessionId = sessionId,
        metadata = TranscriptMetadata(sessionTitle, provider, model, mode, isExecuting),
        messages = messages,
        replace = replace,
    )

    fun buildSessionPayload(
        sessionId: String,
        metadata: TranscriptMetadata,
        messages: List<MessageEntity>,
        replace: Boolean = false,
    ): String {
        val payload = mutableMapOf(
            "sessionId" to sessionId,
            "messages" to messages.map(::messageMap),
            "metadata" to metadataMap(metadata),
        )
        if (replace) payload["replace"] = true
        return gson.toJson(payload)
    }

    fun buildMessagesJson(messages: List<MessageEntity>): String = gson.toJson(messages.map(::messageMap))

    fun buildMetadataJson(metadata: TranscriptMetadata): String = gson.toJson(metadataMap(metadata))

    /** A JSON string literal, for passing ids as JS arguments. */
    fun jsString(value: String): String = gson.toJson(value)

    private fun messageMap(message: MessageEntity): Map<String, Any?> = mapOf(
        "id" to message.id,
        "sessionId" to message.sessionId,
        "sequence" to message.sequence,
        "source" to message.source,
        "direction" to message.direction,
        "contentDecrypted" to message.contentDecrypted,
        "metadataJson" to message.metadataJson,
        "createdAt" to message.createdAt
    )

    private fun metadataMap(metadata: TranscriptMetadata): Map<String, Any> = mapOf(
        "title" to metadata.title,
        "provider" to metadata.provider,
        "model" to metadata.model,
        "mode" to metadata.mode,
        "isExecuting" to metadata.isExecuting
    )
}
