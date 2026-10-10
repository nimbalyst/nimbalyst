package com.nimbalyst.app.sync

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InteractiveResponsesTest {
    private data class Control(val sessionId: String, val type: String, val payload: JsonObject?)
    private data class ToolResult(val sessionId: String, val id: String, val content: String)

    private val controls = mutableListOf<Control>()
    private val toolResults = mutableListOf<ToolResult>()
    private val responses = InteractiveResponses(
        Gson(),
        sendControl = { sessionId, type, payload -> controls += Control(sessionId, type, payload); Result.success(Unit) },
        appendToolResult = { sessionId, id, content -> toolResults += ToolResult(sessionId, id, content); Result.success(Unit) }
    )

    @Test
    fun `request user input submit answers the prompt and records the tool result`() {
        val body = JsonParser.parseString("""{"answers":{"name":"Ada","count":2}}""").asJsonObject

        responses.respond("s1", "requestUserInputSubmit", "p1", body)

        val control = controls.single()
        assertEquals("prompt_response", control.type)
        assertEquals("request_user_input", control.payload!!.get("promptType").asString)
        assertEquals("p1", control.payload.get("promptId").asString)
        val response = control.payload.getAsJsonObject("response")
        assertEquals("Ada", response.getAsJsonObject("answers").get("name").asString)
        assertFalse(response.get("cancelled").asBoolean)
        val result = toolResults.single()
        assertEquals("p1", result.id)
        assertEquals(response, JsonParser.parseString(result.content))
    }

    @Test
    fun `request user input cancel answers the prompt as cancelled`() {
        responses.respond("s1", "requestUserInputCancel", "p1", JsonObject())

        val response = controls.single().payload!!.getAsJsonObject("response")
        assertTrue(response.get("cancelled").asBoolean)
        assertEquals(0, response.getAsJsonObject("answers").size())
        assertEquals(JsonParser.parseString("""{"cancelled":true}"""), JsonParser.parseString(toolResults.single().content))
    }
}
