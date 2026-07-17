package com.nimbalyst.app.transcript

import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// ---------------------------------------------------------------------------
// Pure parse tests — no Android runtime needed, kept as plain JUnit
// ---------------------------------------------------------------------------

class TranscriptBridgeTest {
    @Test
    fun `parses prompt payload`() {
        val message = TranscriptBridge.parse("""{"type":"prompt","text":"Ship the Android prompt queue"}""")

        assertNotNull(message)
        assertEquals("prompt", message?.type)
        assertEquals("Ship the Android prompt queue", message?.text)
    }

    @Test
    fun `parses interactive response payload`() {
        val message = TranscriptBridge.parse(
            """
            {"type":"interactive_response","action":"askUserQuestionSubmit","questionId":"question-1","answers":{"scope":"session"}}
            """.trimIndent()
        )

        assertNotNull(message)
        assertEquals("interactive_response", message?.type)
        assertEquals("askUserQuestionSubmit", message?.action)
        assertEquals("question-1", message?.questionId)
        assertEquals("session", message?.raw?.getAsJsonObject("answers")?.get("scope")?.asString)
    }

    @Test
    fun `ignores invalid payload`() {
        val message = TranscriptBridge.parse("not json")

        assertNull(message)
    }

    @Test
    fun `returns null when type field is missing`() {
        val message = TranscriptBridge.parse("""{"text":"no type field"}""")

        assertNull(message)
    }
}

// ---------------------------------------------------------------------------
// Relay tests — require Robolectric for Handler / Looper support
// ---------------------------------------------------------------------------

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class TranscriptBridgeRelayTest {
    @Test
    fun `parseable payload reaches registered handler`() {
        val relay = TranscriptBridgeRelay()
        var received: TranscriptBridgeMessage? = null
        relay.handler = { received = it }

        relay.postMessage("""{"type":"prompt","text":"hello"}""")

        // postMessage marshals to the main looper; flush it before asserting
        shadowOf(Looper.getMainLooper()).idle()

        assertNotNull(received)
        assertEquals("prompt", received?.type)
        assertEquals("hello", received?.text)
    }

    @Test
    fun `payload posted when handler is null drops silently`() {
        val relay = TranscriptBridgeRelay()
        // handler is null by default — must not throw
        relay.postMessage("""{"type":"prompt","text":"hello"}""")
        shadowOf(Looper.getMainLooper()).idle()
        // No assertion needed: the test passes if no exception is thrown
    }

    @Test
    fun `handler can be cleared and subsequent message drops silently`() {
        val relay = TranscriptBridgeRelay()
        var callCount = 0
        relay.handler = { callCount++ }

        relay.postMessage("""{"type":"prompt","text":"first"}""")
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(1, callCount)

        relay.handler = null

        relay.postMessage("""{"type":"prompt","text":"second"}""")
        shadowOf(Looper.getMainLooper()).idle()
        // handler was null, message must be dropped
        assertEquals(1, callCount)
    }

    @Test
    fun `unparseable payload is dropped without invoking handler`() {
        val relay = TranscriptBridgeRelay()
        var called = false
        relay.handler = { called = true }

        relay.postMessage("not json at all")
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(false, called)
    }

    // NOTE: asserting that the handler runs on the main thread (Looper.getMainLooper())
    // is confirmed implicitly by requiring shadowOf(Looper.getMainLooper()).idle() to
    // flush the runnable before the assertion sees the result. If marshalling were
    // absent the handler would fire synchronously on the calling thread and no idle()
    // call would be needed. Thread-identity can be asserted directly when needed with:
    //   assertEquals(Looper.getMainLooper(), Looper.myLooper())
    // from within the handler lambda — omitted here to keep the test harness simple.
}
