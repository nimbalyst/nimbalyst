package com.nimbalyst.app.transcript

import android.webkit.JavascriptInterface
import com.google.gson.Gson
import com.google.gson.JsonObject

class TranscriptBridge(
    private val onMessage: (TranscriptBridgeMessage) -> Unit,
) {
    private val gson = Gson()

    @JavascriptInterface
    fun postMessage(payload: String) {
        val json = runCatching {
            gson.fromJson(payload, JsonObject::class.java)
        }.getOrElse { error ->
            System.err.println("TranscriptBridge: failed to decode bridge payload: ${error.message}")
            null
        } ?: return

        val type = json.get("type")?.takeIf { !it.isJsonNull }?.asString ?: return

        onMessage(
            TranscriptBridgeMessage(
                type = type,
                text = json.get("text")?.takeIf { !it.isJsonNull }?.asString,
                action = json.get("action")?.takeIf { !it.isJsonNull }?.asString,
                promptId = json.get("promptId")?.takeIf { !it.isJsonNull }?.asString,
                requestId = json.get("requestId")?.takeIf { !it.isJsonNull }?.asString,
                questionId = json.get("questionId")?.takeIf { !it.isJsonNull }?.asString,
                proposalId = json.get("proposalId")?.takeIf { !it.isJsonNull }?.asString,
                feedback = json.get("feedback")?.takeIf { !it.isJsonNull }?.asString,
                beforeRawMessageId = json.get("beforeRawMessageId")?.takeIf { !it.isJsonNull }?.asLong,
                count = json.get("count")?.takeIf { !it.isJsonNull }?.asInt,
                raw = json
            )
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
    val beforeRawMessageId: Long? = null,
    val count: Int? = null,
    val raw: JsonObject,
)
