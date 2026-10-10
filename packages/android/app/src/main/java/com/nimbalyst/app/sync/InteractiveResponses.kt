package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject

/**
 * Maps a transcript widget action (AskUserQuestion, request user input, tool
 * permission, plan approval, git commit) onto the `prompt_response` session control message
 * and, where the desktop expects one, the tool result appended to the room.
 */
internal class InteractiveResponses(
    private val gson: Gson,
    private val sendControl: (sessionId: String, messageType: String, payload: JsonObject?) -> Result<Unit>,
    private val appendToolResult: (sessionId: String, toolResultId: String, content: String) -> Result<Unit>,
) {
    fun respond(sessionId: String, action: String, promptId: String, body: JsonObject) {
        fun promptResponse(promptType: String, response: JsonObject) = sendControl(
            sessionId,
            "prompt_response",
            jsonObject(
                "promptType" to promptType,
                "promptId" to promptId,
                "response" to response
            )
        ).getOrThrow()

        when (action) {
            "askUserQuestionSubmit" -> {
                val answers = body.getAsJsonObject("answers") ?: JsonObject()
                val response = JsonObject().apply { add("answers", answers.deepCopy()) }
                promptResponse("ask_user_question", response)
                appendToolResult(sessionId, promptId, gson.toJson(response)).getOrThrow()
            }

            "requestUserInputSubmit" -> {
                val answers = body.getAsJsonObject("answers") ?: JsonObject()
                val response = jsonObject("answers" to answers, "cancelled" to false)
                promptResponse("request_user_input", response)
                appendToolResult(sessionId, promptId, gson.toJson(response)).getOrThrow()
            }

            "requestUserInputCancel" -> {
                promptResponse("request_user_input", jsonObject("answers" to JsonObject(), "cancelled" to true))
                appendToolResult(sessionId, promptId, gson.toJson(jsonObject("cancelled" to true))).getOrThrow()
            }

            "toolPermissionSubmit" -> {
                val response = body.getAsJsonObject("response") ?: JsonObject()
                promptResponse("tool_permission", response)
                appendToolResult(sessionId, promptId, gson.toJson(response)).getOrThrow()
            }

            "exitPlanModeApprove" -> promptResponse("exit_plan_mode", jsonObject("approved" to true))

            "exitPlanModeDeny" -> {
                val response = jsonObject("approved" to false)
                body.get("feedback")?.takeIf { !it.isJsonNull }?.asString?.let {
                    response.addProperty("feedback", it)
                }
                promptResponse("exit_plan_mode", response)
            }

            "gitCommit" -> promptResponse(
                "git_commit",
                jsonObject(
                    "action" to "committed",
                    "files" to body.getAsJsonArray("files"),
                    "message" to body.get("message")?.takeIf { !it.isJsonNull }?.asString.orEmpty()
                )
            )

            "gitCommitCancel" -> {
                val response = jsonObject("action" to "cancelled")
                promptResponse("git_commit", response)
                appendToolResult(sessionId, promptId, gson.toJson(response)).getOrThrow()
            }

            else -> throw IllegalArgumentException("Unsupported interactive action: $action")
        }
    }

    private fun jsonObject(vararg entries: Pair<String, Any?>): JsonObject {
        return JsonObject().apply {
            entries.forEach { (key, value) ->
                when (value) {
                    null -> add(key, JsonNull.INSTANCE)
                    is String -> addProperty(key, value)
                    is Boolean -> addProperty(key, value)
                    is Number -> addProperty(key, value)
                    is JsonObject -> add(key, value.deepCopy())
                    is JsonArray -> add(key, value.deepCopy())
                    is JsonElement -> add(key, value.deepCopy())
                    else -> add(key, gson.toJsonTree(value))
                }
            }
        }
    }
}
