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
        isExecuting: Boolean = false,
        agentStatusKind: String? = null,
        agentStatusLabel: String? = null,
        agentStatusDetail: String? = null,
        messages: List<MessageEntity>,
        viewMessagesJson: String? = null,
        historyPageJson: String? = null
    ): String {
        val metadata = mutableMapOf<String, Any?>(
            "title" to sessionTitle,
            "provider" to provider,
            "model" to model,
            "mode" to mode,
            "isExecuting" to isExecuting
        )
        if (!agentStatusKind.isNullOrBlank() ||
            !agentStatusLabel.isNullOrBlank() ||
            !agentStatusDetail.isNullOrBlank()
        ) {
            metadata["agentStatus"] = mapOf(
                "kind" to agentStatusKind,
                "label" to agentStatusLabel,
                "detail" to agentStatusDetail
            )
        }

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
            "metadata" to metadata
        )

        // Oversized sessions ship a pre-projected tail; pass it through as a raw
        // JSON array so the renderer skips raw-message projection.
        if (!viewMessagesJson.isNullOrBlank()) {
            runCatching { JsonParser.parseString(viewMessagesJson) }
                .getOrNull()
                ?.takeIf { it.isJsonArray }
                ?.let { payload["viewMessages"] = it }
        }

        if (!historyPageJson.isNullOrBlank()) {
            runCatching { JsonParser.parseString(historyPageJson) }
                .getOrNull()
                ?.takeIf { it.isJsonObject }
                ?.let { payload["historyPage"] = it }
        }

        return gson.toJson(payload)
    }
}
