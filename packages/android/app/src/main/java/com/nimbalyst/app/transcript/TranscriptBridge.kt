package com.nimbalyst.app.transcript

import com.google.gson.Gson
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser

object TranscriptBridge {
    private val gson = Gson()

    fun parse(payload: String): TranscriptBridgeMessage? {
        val json = runCatching {
            gson.fromJson(payload, JsonObject::class.java)
        }.getOrElse { error ->
            System.err.println("TranscriptBridge: failed to decode bridge payload: ${error.message}")
            null
        } ?: return null

        val type = json.string("type") ?: return null

        return TranscriptBridgeMessage(
            type = type,
            text = json.string("text"),
            action = json.string("action"),
            promptId = json.string("promptId"),
            requestId = json.string("requestId"),
            questionId = json.string("questionId"),
            proposalId = json.string("proposalId"),
            feedback = json.string("feedback"),
            raw = json
        )
    }

    /**
     * Decode an `evaluateJavascript` result, which arrives JSON-encoded: `"null"`
     * for null/undefined, `"true"`, or a quoted string.
     */
    fun parseJsResult(result: String?): JsonElement? {
        if (result == null) return null
        return runCatching { JsonParser.parseString(result) }.getOrNull()?.takeIf { !it.isJsonNull }
    }

    /** The session id `loadSession` reports it activated, or null when the bridge did not answer. */
    fun activatedSessionId(result: String?): String? =
        parseJsResult(result)?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString

    /**
     * Whether an append/updateMetadata call was applied. Anything but `true`
     * (false, undefined because `window.nimbalyst` is gone, or garbage) means
     * native and the bridge disagree about which session is on screen.
     */
    fun mutationAccepted(result: String?): Boolean {
        val element = parseJsResult(result) ?: return false
        return element.isJsonPrimitive && element.asJsonPrimitive.isBoolean && element.asBoolean
    }

    /** Parse `JSON.stringify(window.nimbalyst.getPromptList())`, delivered double-encoded by evaluateJavascript. */
    fun parsePromptList(result: String?): List<TranscriptPrompt> {
        val outer = parseJsResult(result) ?: return emptyList()
        val array = runCatching {
            if (outer.isJsonPrimitive && outer.asJsonPrimitive.isString) {
                JsonParser.parseString(outer.asString)
            } else {
                outer
            }
        }.getOrNull()?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()

        return array.mapNotNull { element ->
            val obj = element.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
            val index = obj.string("id")?.toIntOrNull() ?: return@mapNotNull null
            TranscriptPrompt(
                index = index,
                text = obj.string("text").orEmpty(),
                createdAt = obj.get("createdAt")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L
            )
        }
    }

    private fun JsonObject.string(key: String): String? =
        get(key)?.takeIf { it.isJsonPrimitive }?.asString
}

/** One user prompt in the rendered transcript. [index] is the UI row to pass to `scrollToMessage`. */
data class TranscriptPrompt(
    val index: Int,
    val text: String,
    val createdAt: Long,
)

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
) {
    /**
     * Whether this message may act on [activeSessionId]. Posts that send,
     * answer, or open something carry the session the bundle rendered them
     * for; one without it, or for another cached session, is dropped.
     */
    fun isForSession(activeSessionId: String?): Boolean {
        if (type !in SESSION_SCOPED_TYPES) return true
        val origin = raw.get("sessionId")?.takeIf { it.isJsonPrimitive }?.asString
        return origin != null && origin == activeSessionId
    }

    private companion object {
        val SESSION_SCOPED_TYPES = setOf("prompt", "interactive_response", "open_file")
    }

    /** `open_url` target. */
    val url: String? get() = raw.get("url")?.takeIf { it.isJsonPrimitive }?.asString

    /** `open_file` path. */
    val filePath: String? get() = raw.get("filePath")?.takeIf { it.isJsonPrimitive }?.asString

    /** `haptic` style: light, medium, or heavy. */
    val hapticStyle: String get() = raw.get("style")?.takeIf { it.isJsonPrimitive }?.asString ?: "medium"

    /** `js_error` text, with its source location when the page supplied one. */
    val errorDescription: String
        get() {
            val message = raw.get("message")?.takeIf { it.isJsonPrimitive }?.asString ?: "unknown"
            val url = raw.get("url")?.takeIf { it.isJsonPrimitive }?.asString.orEmpty()
            val line = raw.get("line")?.takeIf { it.isJsonPrimitive }?.asString ?: "0"
            return "$message at $url:$line"
        }

    /** Same filter as the bundle: this browser warning is noise, not a failure. */
    val isBenignJsError: Boolean
        get() = raw.get("message")?.takeIf { it.isJsonPrimitive }?.asString
            ?.contains("ResizeObserver loop completed with undelivered notifications.") == true
}
