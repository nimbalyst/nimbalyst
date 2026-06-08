package com.nimbalyst.app.transcript

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.nimbalyst.app.data.MessageEntity

object TranscriptPayloadBuilder {
    private val gson = Gson()

    fun buildSessionPayload(
        sessionId: String,
        sessionTitle: String,
        provider: String,
        model: String,
        mode: String,
        messages: List<MessageEntity>,
        viewMessagesJson: String? = null
    ): String {
        val payload = mutableMapOf<String, Any?>(
            "sessionId" to sessionId,
            "messages" to messages.map { message ->
                mapOf(
                    "id" to message.id,
                    "sessionId" to message.sessionId,
                    "sequence" to message.sequence,
                    "source" to message.source,
                    "direction" to message.direction,
                    "contentDecrypted" to message.contentDecrypted,
                    "metadataJson" to message.metadataJson,
                    "createdAt" to message.createdAt
                )
            },
            "metadata" to mapOf(
                "title" to sessionTitle,
                "provider" to provider,
                "model" to model,
                "mode" to mode,
                "isExecuting" to false
            )
        )

        // Oversized sessions ship a pre-projected tail; pass it through as a raw
        // JSON array so the renderer skips raw-message projection.
        if (!viewMessagesJson.isNullOrBlank()) {
            runCatching { JsonParser.parseString(viewMessagesJson) }
                .getOrNull()
                ?.takeIf { it.isJsonArray }
                ?.let { payload["viewMessages"] = it }
        }

        return gson.toJson(payload)
    }
}
