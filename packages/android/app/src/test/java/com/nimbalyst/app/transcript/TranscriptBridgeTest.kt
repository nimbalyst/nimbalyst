package com.nimbalyst.app.transcript

import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    fun `parses the ready handshake the transcript posts once window nimbalyst exists`() {
        val message = TranscriptBridge.parse("""{"type":"ready"}""")

        assertNotNull(message)
        // TranscriptWebView re-pushes the session payload on this message; a cold
        // start can install the bridge after the timed retries have all fired.
        assertEquals("ready", message?.type)
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

    @Test
    fun `parses requestUserInput, open_url, open_file, haptic and js_error posts`() {
        val input = TranscriptBridge.parse(
            """{"type":"interactive_response","action":"requestUserInputCancel","promptId":"p-1"}"""
        )
        assertEquals("requestUserInputCancel", input?.action)
        assertEquals("p-1", input?.promptId)

        assertEquals("https://example.com/a?b=1", TranscriptBridge.parse("""{"type":"open_url","url":"https://example.com/a?b=1"}""")?.url)
        assertEquals("src/App.tsx", TranscriptBridge.parse("""{"type":"open_file","filePath":"src/App.tsx"}""")?.filePath)
        assertEquals("light", TranscriptBridge.parse("""{"type":"haptic","style":"light"}""")?.hapticStyle)
        assertEquals("medium", TranscriptBridge.parse("""{"type":"haptic"}""")?.hapticStyle)

        val error = TranscriptBridge.parse("""{"type":"js_error","message":"[window.error] boom","url":"t.js","line":12}""")
        assertEquals("[window.error] boom at t.js:12", error?.errorDescription)
        assertEquals(false, error?.isBenignJsError)
        val benign = TranscriptBridge.parse(
            """{"type":"js_error","message":"[window.error] ResizeObserver loop completed with undelivered notifications."}"""
        )
        assertEquals(true, benign?.isBenignJsError)
    }

    @Test
    fun `actionable messages must name the session on screen`() {
        fun msg(json: String) = TranscriptBridge.parse(json)!!
        val compactA = msg("""{"type":"prompt","text":"/compact","sessionId":"A"}""")
        assertTrue(compactA.isForSession("A"))
        assertFalse(compactA.isForSession("B"))
        assertFalse(compactA.isForSession(null))
        assertFalse(msg("""{"type":"prompt","text":"/compact"}""").isForSession("A"))
        assertFalse(msg("""{"type":"interactive_response","action":"gitCommit","sessionId":"A"}""").isForSession("B"))
        assertFalse(msg("""{"type":"open_file","filePath":"a.md","sessionId":"A"}""").isForSession("B"))
        // Lifecycle and diagnostics posts are not tied to a session.
        assertTrue(msg("""{"type":"ready"}""").isForSession(null))
        assertTrue(msg("""{"type":"haptic"}""").isForSession("B"))
    }

    @Test
    fun `decodes evaluateJavascript results for load and mutation calls`() {
        assertEquals("session-1", TranscriptBridge.activatedSessionId("\"session-1\""))
        // window.nimbalyst missing: the script returns null, never a success.
        assertNull(TranscriptBridge.activatedSessionId("null"))
        assertNull(TranscriptBridge.activatedSessionId(null))

        assertTrue(TranscriptBridge.mutationAccepted("true"))
        assertFalse(TranscriptBridge.mutationAccepted("false"))
        assertFalse(TranscriptBridge.mutationAccepted("null"))
        assertFalse(TranscriptBridge.mutationAccepted("\"true\""))
    }

    @Test
    fun `parses the double-encoded prompt list`() {
        val inner = """[{"id":"4","text":"Fix the build","createdAt":1000},{"id":"x","text":"bad index"},{"id":"9","text":"Ship it"}]"""
        val encoded = com.google.gson.Gson().toJson(inner)

        val prompts = TranscriptBridge.parsePromptList(encoded)

        assertEquals(listOf(4, 9), prompts.map { it.index })
        assertEquals("Fix the build", prompts[0].text)
        assertEquals(1000L, prompts[0].createdAt)
        assertEquals(emptyList<TranscriptPrompt>(), TranscriptBridge.parsePromptList("null"))
    }

    @Test
    fun `only the bundled transcript directory may load inside the WebView`() {
        val allowed = TranscriptLinkAction.ALLOW_IN_WEBVIEW
        assertEquals(allowed, TranscriptExternalLinks.classify("file:///android_asset/transcript-dist/transcript.html#top"))
        assertEquals(allowed, TranscriptExternalLinks.classify("file:///android_asset/transcript-dist/assets/transcript-B5nn.js"))

        // AndroidBridge stays attached to whatever page loads, so none of these may.
        listOf(
            "file:///sdcard/Download/evil.html",
            "file:///data/data/com.nimbalyst.app/databases/nimbalyst.db",
            "file:///android_asset/other.html",
            "file:///android_asset/transcript-dist-evil/x.html",
            "file:///android_asset/transcript-dist/../../data/x.html",
            "file:///android_asset/transcript-dist/./../x.html",
            "file:///android_asset/transcript-dist/%2e%2e/%2e%2e/sdcard/x.html",
            "file:///android_asset/transcript-dist/..%2F..%2Fsdcard%2Fx.html",
            "file:///android_asset/transcript-dist/..\\..\\x.html",
            // Scheme-relative links resolve against file:, giving a host.
            "file://attacker.example/android_asset/transcript-dist/transcript.html",
            "FILE:///sdcard/x.html",
            "file:",
        ).forEach { url ->
            assertEquals(url, TranscriptLinkAction.BLOCK, TranscriptExternalLinks.classify(url))
        }
    }

    @Test
    fun `classifies transcript navigations`() {
        assertEquals(TranscriptLinkAction.OPEN_CUSTOM_TAB, TranscriptExternalLinks.classify("https://nimbalyst.com"))
        assertEquals(TranscriptLinkAction.OPEN_CUSTOM_TAB, TranscriptExternalLinks.classify("HTTP://example.com"))
        assertEquals(TranscriptLinkAction.OPEN_VIEW_INTENT, TranscriptExternalLinks.classify("mailto:team@example.com"))
        assertEquals(TranscriptLinkAction.BLOCK, TranscriptExternalLinks.classify("javascript:alert(1)"))
        assertEquals(TranscriptLinkAction.BLOCK, TranscriptExternalLinks.classify(null))
        // Arbitrary intents and other app-launching schemes never leave the WebView.
        assertEquals(
            TranscriptLinkAction.BLOCK,
            TranscriptExternalLinks.classify("intent://scan/#Intent;scheme=zxing;package=com.evil;S.browser_fallback_url=https%3A%2F%2Fx;end")
        )
        assertEquals(TranscriptLinkAction.BLOCK, TranscriptExternalLinks.classify("content://com.nimbalyst.app.provider/secret"))
        assertEquals(TranscriptLinkAction.BLOCK, TranscriptExternalLinks.classify("tel:5551234"))
        assertEquals(TranscriptLinkAction.BLOCK, TranscriptExternalLinks.classify("market://details?id=com.evil"))
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
    fun `a message queued before the view is re-attached never reaches the next host`() {
        val relay = TranscriptBridgeRelay()
        var sessionA = 0
        var sessionB = 0
        relay.handler = { sessionA++ }

        // Posted on the JS thread while A still owns the view; runs after B attached.
        relay.postMessage("""{"type":"prompt","text":"/compact"}""")
        relay.handler = null
        relay.handler = { sessionB++ }
        shadowOf(Looper.getMainLooper()).idle()

        assertEquals(0, sessionB)
        assertEquals(0, sessionA)
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

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class TranscriptExternalLinksOpenTest {
    @Test
    fun `a link no installed app can open returns false instead of crashing`() {
        val app = org.robolectric.RuntimeEnvironment.getApplication()
        shadowOf(app).checkActivities(true)

        assertFalse(TranscriptExternalLinks.open(app, "https://nimbalyst.com/privacy-policy"))
        assertFalse(TranscriptExternalLinks.open(app, "mailto:a@b.c"))
    }
}
