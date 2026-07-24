package com.nimbalyst.app.transcript

import com.google.gson.Gson
import com.nimbalyst.app.data.MessageEntity

object TranscriptPayloadBuilder {
    private val gson = Gson()

    fun buildSessionPayload(
        sessionId: String,
        sessionTitle: String,
        provider: String,
        model: String,
        mode: String,
        messages: List<MessageEntity>
    ): String {
        val payload = mapOf(
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

        return gson.toJson(payload)
    }
}
