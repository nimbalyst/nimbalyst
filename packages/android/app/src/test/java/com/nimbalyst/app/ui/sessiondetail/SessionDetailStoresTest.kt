package com.nimbalyst.app.ui.sessiondetail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.nimbalyst.app.attachments.StoredAttachment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionDetailStoresTest {

    private class Probe : ViewModel() {
        var cleared = false
        override fun onCleared() {
            cleared = true
        }
    }

    private val factory = viewModelFactory { initializer { Probe() } }

    private fun SessionDetailStores.probe(sessionId: String): Probe =
        ViewModelProvider(owner(sessionId), factory)[Probe::class.java]

    @Test
    fun `only the most recently shown sessions keep their ViewModel`() {
        val stores = SessionDetailStores(SavedStateHandle())
        val first = stores.probe("s1")
        val second = stores.probe("s2")
        stores.probe("s3")
        assertSame("returning to a recent session reuses its ViewModel", first, stores.probe("s1"))

        stores.probe("s4")

        assertEquals(listOf("s3", "s1", "s4"), stores.liveSessionIds)
        assertFalse(first.cleared)
        assertTrue("the least recent session's collectors are released", second.cleared)
        assertNotSame(second, stores.probe("s2"))
        assertEquals(SessionDetailStores.MAX_LIVE_SESSIONS, stores.liveSessionIds.size)
    }

    @Test
    fun `an evicted session keeps its draft, and an account change forgets everything`() {
        val handle = SavedStateHandle()
        val stores = SessionDetailStores(handle)
        val evicted = stores.probe("s1")
        stores.composeState("s1").edit("half-written", now = 10)
        val photo = StoredAttachment("a1", "photo.jpg", "/files/compose-attachments/s2/a1.jpg")
        stores.composeState("s2").attachments = listOf(photo)
        listOf("s2", "s3", "s4").forEach { stores.probe(it) }

        assertTrue(evicted.cleared)
        assertEquals("half-written", stores.composeState("s1").text)

        val live = stores.probe("s4")
        val orphaned = stores.clearAll()

        assertTrue(live.cleared)
        assertEquals(emptyList<String>(), stores.liveSessionIds)
        assertEquals(listOf(photo), orphaned)
        assertEquals("", SessionDetailStores(handle).composeState("s1").text)
    }

    @Test
    fun `saved compose state is bounded but never drops pending attachments`() {
        val stores = SessionDetailStores(SavedStateHandle())
        val photo = StoredAttachment("a1", "photo.jpg", "/p/a1.jpg")
        stores.composeState("keep").apply {
            edit("with photo", now = 1)
            attachments = listOf(photo)
        }
        stores.composeState("old").edit("stale draft", now = 1)
        repeat(SessionDetailStores.MAX_SAVED_COMPOSE) { stores.composeState("filler-$it") }

        assertEquals(listOf(photo), stores.composeState("keep").attachments)
        assertEquals("", stores.composeState("old").text)
    }
}
