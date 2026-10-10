package com.nimbalyst.app.documents

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE)
class DocumentEditorBridgeTest {
    @Test
    fun theEditorWebViewCannotReachFilesOrContentProviders() {
        val settings = createDocumentEditorWebView(ApplicationProvider.getApplicationContext(), EditorBridgeRelay()) {}!!.settings
        assertFalse(settings.allowFileAccess)
        assertFalse(settings.allowContentAccess)
        @Suppress("DEPRECATION")
        assertFalse(settings.allowFileAccessFromFileURLs)
        @Suppress("DEPRECATION")
        assertFalse(settings.allowUniversalAccessFromFileURLs)
    }

    @Test
    fun aMissingWebViewProviderReportsAFailureInsteadOfCrashing() {
        var failure: String? = null
        val view = createDocumentEditorWebView(
            ApplicationProvider.getApplicationContext(),
            EditorBridgeRelay(),
            newWebView = { throw RuntimeException("No WebView installed") },
        ) { failure = it }
        assertNull(view)
        assertTrue(failure != null)
    }

    /**
     * R3 (R1-A1): every save is the bundle's, answered by revision. A read-only
     * page or a failed push answers false, so the bundle keeps the body dirty.
     */
    @Test
    fun bundleSavesCarryARevisionAndAreAnsweredByIt() {
        assertEquals(
            EditorBridgeMessage.ContentChanged("# Hi", 3),
            EditorBridgeMessage.parse("""{"type":"contentChanged","content":"# Hi","revision":3}"""),
        )
        assertNull("A save without a revision cannot be answered", EditorBridgeMessage.parse("""{"type":"contentChanged","content":"# Hi"}"""))
        assertEquals("window.nimbalystEditor && window.nimbalystEditor.saveResult(3, false)", EditorCommands.saveResult(3, ok = false))
        assertEquals("window.nimbalystEditor && window.nimbalystEditor.saveResult(4, true)", EditorCommands.saveResult(4, ok = true))
    }

    /** R3-4: a teardown never re-saves a body native already persisted, so a later remote save survives. */
    @Test
    fun teardownSkipsTheBodyNativeAlreadyPersisted() {
        val guard = TeardownSaveGuard()
        guard.onLoaded("A")
        guard.onPersisted("AB") // ack not yet seen by the bundle; a remote R lands after
        assertFalse(guard.shouldSave("AB"))
        assertTrue("Genuinely unsaved text still saves", guard.shouldSave("ABC"))
        guard.onLoaded("R")
        assertTrue(guard.shouldSave("AB"))
    }

    /** R3-5: the bundle's null, not native's lagging dirty flag, decides whether there is anything to save. */
    @Test
    fun teardownSavesWhateverTheBundleReportsUnsaved() {
        val guard = TeardownSaveGuard()
        guard.onLoaded("A")
        assertFalse(guard.shouldSave(null))
        assertTrue("Native may still think the editor is clean", guard.shouldSave("AB"))
        assertEquals("The background flush asks an editable bundle whatever native's dirty flag says", EditorCommands.FLUSH, EditorCommands.flushFor(canWrite = true))
        assertNull(EditorCommands.flushFor(canWrite = false))
        assertFalse("The loaded body is not re-saved", guard.shouldSave("A"))
    }

    /**
     * R1-3 / R1-A3: a remote save into a dirty editor is deferred (frontmatter now,
     * body if the edits are undone; `pendingSave` tests cover the bundle side).
     */
    @Test
    fun aRemoteSaveIntoUnsavedEditsIsDeferredNotLoaded() {
        assertTrue(EditorCommands.remoteUpdate("---\nid: x\n---\nB", dirty = true).contains("deferRemote("))
        assertTrue(EditorCommands.remoteUpdate("B", dirty = false).contains("loadMarkdown("))
    }

    @Test
    fun onlyTheBundledEditorLoadsInTheWebView() {
        assertEquals(EditorLinkAction.ALLOW_IN_WEBVIEW, DocumentEditorLinks.classify(DocumentEditorLinks.EDITOR_URL))
        assertEquals(EditorLinkAction.ALLOW_IN_WEBVIEW, DocumentEditorLinks.classify("file:///android_asset/editor-dist/assets/editor.js"))
        for (blocked in listOf(
            "file:///android_asset/editor-dist/../transcript-dist/transcript.html",
            "file:///android_asset/editor-dist/%2e%2e/x",
            "file:///data/data/com.nimbalyst.app/databases/documents.db",
            "file://host/android_asset/editor-dist/editor.html",
            "content://com.example/file",
            "javascript:alert(1)",
            "intent://x#Intent;end",
            null,
        )) {
            assertEquals(blocked, EditorLinkAction.BLOCK, DocumentEditorLinks.classify(blocked))
        }
        assertEquals(EditorLinkAction.OPEN_EXTERNALLY, DocumentEditorLinks.classify("https://example.com"))
        assertEquals(EditorLinkAction.OPEN_EXTERNALLY, DocumentEditorLinks.classify("mailto:a@b.c"))
    }

    @Test
    fun bridgeMessagesParseAndBenignErrorsAreDropped() {
        assertEquals(EditorBridgeMessage.EditorReady, EditorBridgeMessage.parse("""{"type":"editorReady"}"""))
        assertEquals(EditorBridgeMessage.ContentChanged("# Hi", 1), EditorBridgeMessage.parse("""{"type":"contentChanged","content":"# Hi","revision":1}"""))
        assertEquals(EditorBridgeMessage.Dirty(true), EditorBridgeMessage.parse("""{"type":"dirty","isDirty":true}"""))
        assertEquals(EditorBridgeMessage.Error("boom"), EditorBridgeMessage.parse("""{"type":"error","message":"boom"}"""))
        assertNull(EditorBridgeMessage.parse("""{"type":"error","message":"window.onerror: ResizeObserver loop completed with undelivered notifications."}"""))
        assertNull(EditorBridgeMessage.parse("""{"type":"contentChanged"}"""))
        assertEquals(
            EditorBridgeMessage.LinkClicked("../Home.md", "id=01J"),
            EditorBridgeMessage.parse("""{"type":"linkClicked","href":"../Home.md","title":"id=01J"}"""),
        )
        assertEquals(EditorBridgeMessage.LinkClicked("a.md", null), EditorBridgeMessage.parse("""{"type":"linkClicked","href":"a.md","title":null}"""))
        assertNull(EditorBridgeMessage.parse("not json"))
    }

    @Test
    fun markdownIsPassedToJavascriptAsAStringLiteral() {
        val markdown = "a \"quote\" \\ back\nline </script>  "
        val js = EditorCommands.loadMarkdown(markdown)
        val literal = js.substringAfter("loadMarkdown(").removeSuffix(")")
        assertEquals(markdown, EditorCommands.decodeContent(literal))
        assertEquals(false, "</script>" in js)
        assertNull(EditorCommands.decodeContent("null"))
    }

    @Test
    fun openFilePathsResolveOnlyInsideTheProject() {
        assertEquals("docs/a.md", relativePathInProject("/Users/me/ws", "/Users/me/ws/docs/a.md"))
        assertEquals("docs/a.md", relativePathInProject("/Users/me/ws/", "/Users/me/ws/docs/a.md"))
        assertNull(relativePathInProject("/Users/me/ws", "/Users/me/ws-other/a.md"))
        assertNull(relativePathInProject("/Users/me/ws", "/Users/me/ws/"))
    }
}
