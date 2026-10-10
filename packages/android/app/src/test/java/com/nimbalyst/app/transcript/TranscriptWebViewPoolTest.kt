package com.nimbalyst.app.transcript

import android.webkit.WebView
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class TranscriptWebViewPoolTest {
    private val context get() = RuntimeEnvironment.getApplication()

    @Before
    fun setUp() = TranscriptWebViewPool.resetForAccountChange(context, rewarm = false)

    @After
    fun tearDown() {
        TranscriptWebViewPool.newWebView = { WebView(it) }
        TranscriptWebViewPool.resetForAccountChange(context, rewarm = false)
    }

    @Test
    fun `a missing WebView provider leaves the pool empty instead of crashing`() {
        TranscriptWebViewPool.newWebView = { throw RuntimeException("No WebView provider") }

        TranscriptWebViewPool.warmup(context)

        assertNull(TranscriptWebViewPool.take(context))
        assertNull(TranscriptWebViewPool.create(context))
    }

    @Test
    fun `leaving a session returns the same WebView next time with its session cache intact`() {
        TranscriptWebViewPool.warmup(context)
        val first = TranscriptWebViewPool.take(context)!!

        TranscriptWebViewPool.recycle(first)

        // A -> list -> B -> A: the view that holds A in its LRU is handed out again.
        assertSame(first, TranscriptWebViewPool.take(context))
        assertFalse(
            "recycling must not wipe the bundle's session cache",
            shadowOf(first).lastEvaluatedJavascript.orEmpty().contains("clearSession")
        )
    }

    @Test
    fun `transcript WebViews cannot read files or content providers`() {
        val settings = TranscriptWebViewPool.take(context)!!.settings

        assertFalse(settings.allowFileAccess)
        assertFalse(settings.allowContentAccess)
        assertFalse(settings.allowFileAccessFromFileURLs)
        assertFalse(settings.allowUniversalAccessFromFileURLs)
    }

    @Test
    fun `an account change retires every view, including one in use`() {
        TranscriptWebViewPool.warmup(context)
        val inUse: WebView = TranscriptWebViewPool.take(context)!!

        TranscriptWebViewPool.resetForAccountChange(context, rewarm = false)
        TranscriptWebViewPool.recycle(inUse)

        // The in-use view held the previous account's decrypted transcript.
        assertNotSame(inUse, TranscriptWebViewPool.take(context))
    }
}
