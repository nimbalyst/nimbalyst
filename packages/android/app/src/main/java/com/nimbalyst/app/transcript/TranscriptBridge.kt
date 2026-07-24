package com.nimbalyst.app.transcript

import com.google.gson.Gson
import com.google.gson.JsonObject

object TranscriptBridge {
    private val gson = Gson()

    fun parse(payload: String): TranscriptBridgeMessage? {
        val json = runCatching {
            gson.fromJson(payload, JsonObject::class.java)
        }.getOrElse { error ->
            System.err.println("TranscriptBridge: failed to decode bridge payload: ${error.message}")
            null
        } ?: return null

        val type = json.get("type")?.takeIf { !it.isJsonNull }?.asString ?: return null

        return TranscriptBridgeMessage(
            type = type,
            text = json.get("text")?.takeIf { !it.isJsonNull }?.asString,
            action = json.get("action")?.takeIf { !it.isJsonNull }?.asString,
            promptId = json.get("promptId")?.takeIf { !it.isJsonNull }?.asString,
            requestId = json.get("requestId")?.takeIf { !it.isJsonNull }?.asString,
            questionId = json.get("questionId")?.takeIf { !it.isJsonNull }?.asString,
            proposalId = json.get("proposalId")?.takeIf { !it.isJsonNull }?.asString,
            feedback = json.get("feedback")?.takeIf { !it.isJsonNull }?.asString,
            raw = json
        )
    }
}

data class TranscriptBridgeMessage(
    val type: String,
    val text: String? = null,
    val action: String? = null,
    val promptId: String? = null,
    val requestId: String? = null,
    val questionId: String? = null,
    val proposalId: String? = null,
    val feedback: String? = null,
    val raw: JsonObject,
)
