package com.nimbalyst.app.transcript

import com.google.gson.JsonParser
import com.nimbalyst.app.data.MessageEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptPayloadBuilderTest {
    @Test
    fun `buildSessionPayload includes metadata and ordered messages`() {
        val payload = TranscriptPayloadBuilder.buildSessionPayload(
            sessionId = "session-1",
            sessionTitle = "Android native scaffold",
            provider = "claude-code",
            model = "claude-sonnet-4",
            mode = "agent",
            messages = listOf(
                MessageEntity(
                    id = "msg-1",
                    sessionId = "session-1",
                    sequence = 1,
                    source = "user",
                    direction = "input",
                    contentDecrypted = """{"content":"{\"prompt\":\"Hello\"}"}""",
                    createdAt = 1000L
                ),
                MessageEntity(
                    id = "msg-2",
                    sessionId = "session-1",
                    sequence = 2,
                    source = "assistant",
                    direction = "output",
                    contentDecrypted = """{"content":"{\"type\":\"text\",\"content\":\"World\"}"}""",
                    createdAt = 2000L
                )
            )
        )

        val json = JsonParser.parseString(payload).asJsonObject
        val messages = json.getAsJsonArray("messages")
        val metadata = json.getAsJsonObject("metadata")

        assertEquals("session-1", json.get("sessionId").asString)
        assertEquals(2, messages.size())
        assertEquals("msg-1", messages[0].asJsonObject.get("id").asString)
        assertEquals("msg-2", messages[1].asJsonObject.get("id").asString)
        assertEquals("Android native scaffold", metadata.get("title").asString)
        assertEquals("claude-code", metadata.get("provider").asString)
        assertEquals("claude-sonnet-4", metadata.get("model").asString)
        assertEquals("agent", metadata.get("mode").asString)
        assertFalse(metadata.get("isExecuting").asBoolean)
    }

    @Test
    fun `buildSessionPayload preserves JSON-like message content`() {
        val rawEnvelope = """{"content":"{\"type\":\"text\",\"content\":\"Use /compact if the session gets too large.\"}","metadata":null,"hidden":false}"""

        val payload = TranscriptPayloadBuilder.buildSessionPayload(
            sessionId = "session-2",
            sessionTitle = "Payload escaping",
            provider = "claude-code",
            model = "claude-sonnet-4",
            mode = "agent",
            messages = listOf(
                MessageEntity(
                    id = "msg-escape",
                    sessionId = "session-2",
                    sequence = 1,
                    source = "assistant",
                    direction = "output",
                    contentDecrypted = rawEnvelope,
                    createdAt = 3000L
                )
            )
        )

        val json = JsonParser.parseString(payload).asJsonObject
        val content = json.getAsJsonArray("messages")[0]
            .asJsonObject
            .get("contentDecrypted")
            .asString

        assertEquals(rawEnvelope, content)
    }
}
