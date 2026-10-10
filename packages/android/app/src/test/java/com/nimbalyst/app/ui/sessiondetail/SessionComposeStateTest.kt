package com.nimbalyst.app.ui.sessiondetail

import androidx.lifecycle.SavedStateHandle
import com.nimbalyst.app.attachments.StoredAttachment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionComposeStateTest {

    /** Simulates process death: only what the handle saved reaches the new instance. */
    private fun recreate(handle: SavedStateHandle): SessionComposeState {
        val saved = handle.keys().associateWith { handle.get<Any?>(it) }
        return SessionComposeState(SavedStateHandle(saved))
    }

    @Test
    fun `text, attachments, draft timestamps and camera target survive recreation`() {
        val handle = SavedStateHandle()
        val state = SessionComposeState(handle)
        val attachments = listOf(
            StoredAttachment("a1", "photo.jpg", "/files/compose-attachments/s1/a1.jpg"),
            StoredAttachment("a2", "camera.jpg", "/files/compose-attachments/s1/a2.jpg")
        )
        state.edit("draft in progress", now = 500)
        state.attachments = attachments
        state.lastSubmitAt = 400
        state.pendingCameraPath = "/cache/camera/x.jpg"

        val restored = recreate(handle)

        assertEquals("draft in progress", restored.text)
        assertEquals(attachments, restored.attachments)
        assertEquals(500L, restored.lastLocalEditAt)
        assertEquals(400L, restored.lastSubmitAt)
        assertEquals("/cache/camera/x.jpg", restored.pendingCameraPath)
    }

    @Test
    fun `restored local edit still rejects an older remote draft`() {
        val handle = SavedStateHandle()
        SessionComposeState(handle).edit("typed locally", now = 2_000)

        val restored = recreate(handle)

        assertFalse(restored.applyRemoteDraft("older remote", updatedAt = 1_000))
        assertEquals("typed locally", restored.text)
        assertTrue(restored.applyRemoteDraft("newer remote", updatedAt = 3_000))
        assertEquals("newer remote", restored.text)
    }

    @Test
    fun `fresh state seeds from the synced draft and a null draft is ignored`() {
        val state = SessionComposeState(SavedStateHandle())
        assertFalse(state.applyRemoteDraft(null, updatedAt = null))
        assertTrue(state.applyRemoteDraft("from desktop", updatedAt = 10))
        assertEquals("from desktop", state.text)
        assertEquals("a remote draft is not a local edit", 0L, state.lastLocalEditAt)
    }

    @Test
    fun `text restored after a failed send survives the empty draft the submit persisted`() {
        val handle = SavedStateHandle()
        val state = SessionComposeState(handle)
        state.edit("ship it", now = 900)
        // submit: clear the field and persist an empty draft stamped after the submit
        state.lastSubmitAt = 1_000
        state.setText("")
        val emptyDraftAt = 1_001L

        state.restoreFailedSend("ship it", now = 1_002)
        assertEquals("ship it", state.text)

        // blur reconciles against the synced row, which still holds the empty draft
        assertFalse(state.applyRemoteDraft("", updatedAt = emptyDraftAt))
        assertEquals("ship it", state.text)
        val restored = recreate(handle)
        assertFalse(restored.applyRemoteDraft("", updatedAt = emptyDraftAt))
        assertEquals("ship it", restored.text)
    }

    @Test
    fun `a failed send is restored ahead of text typed while it was in flight`() {
        val state = SessionComposeState(SavedStateHandle())
        state.edit("follow-up", now = 5)
        assertEquals("first\nfollow-up", state.restoreFailedSend("first", now = 6))
        assertEquals(6L, state.lastLocalEditAt)
    }

    @Test
    fun `unchanged text is not a local edit`() {
        val state = SessionComposeState(SavedStateHandle())
        assertTrue(state.edit("a", now = 1))
        assertFalse(state.edit("a", now = 2))
        assertEquals(1L, state.lastLocalEditAt)
        assertNull(state.pendingCameraPath)
    }
}
