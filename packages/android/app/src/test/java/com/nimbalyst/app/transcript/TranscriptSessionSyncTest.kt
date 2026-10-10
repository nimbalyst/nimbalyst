package com.nimbalyst.app.transcript

import com.nimbalyst.app.data.MessageEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptSessionSyncTest {
    private val meta = TranscriptMetadata("Title", "claude-code", "sonnet", "agent", isExecuting = false)

    private fun msg(id: String, sessionId: String = "s1") =
        MessageEntity(id = id, sessionId = sessionId, sequence = 0, source = "user", direction = "input", createdAt = 0L)

    private fun snap(vararg ids: String, sessionId: String = "s1", metadata: TranscriptMetadata = meta) =
        TranscriptSnapshot(sessionId, metadata, ids.map { msg(it, sessionId) })

    /** A sync whose bridge confirmed [initial] as loaded. */
    private fun loaded(initial: TranscriptSnapshot): TranscriptSessionSync {
        val sync = TranscriptSessionSync()
        sync.onSnapshot(initial)
        val load = sync.onBridgeReady().single() as TranscriptCommand.Load
        assertTrue(sync.onLoadResult(load, initial.sessionId).activated)
        return sync
    }

    @Test
    fun `room emissions after the first load send only the new messages`() {
        val sync = loaded(snap("a", "b"))

        val commands = sync.onSnapshot(snap("a", "b", "c", "d"))

        val append = commands.single() as TranscriptCommand.Append
        assertEquals(listOf("c", "d"), append.messages.map { it.id })
        // Re-emitting the same list (Room does this on unrelated writes) sends nothing.
        assertEquals(emptyList<TranscriptCommand>(), sync.onSnapshot(snap("a", "b", "c", "d")))
    }

    @Test
    fun `a metadata change alone sends updateMetadata, including isExecuting`() {
        val sync = loaded(snap("a"))

        val update = sync.onSnapshot(snap("a", metadata = meta.copy(isExecuting = true))).single()

        assertEquals(true, (update as TranscriptCommand.UpdateMetadata).metadata.isExecuting)
    }

    @Test
    fun `nothing is sent before the bridge is ready or while a load is in flight`() {
        val sync = TranscriptSessionSync()
        assertEquals(emptyList<TranscriptCommand>(), sync.onSnapshot(snap("a")))

        val load = sync.onBridgeReady().single() as TranscriptCommand.Load
        // Emissions while the load is in flight are held, then sent as a delta.
        assertEquals(emptyList<TranscriptCommand>(), sync.onSnapshot(snap("a", "b")))

        val result = sync.onLoadResult(load, "s1")
        assertEquals(listOf("b"), (result.next.single() as TranscriptCommand.Append).messages.map { it.id })
    }

    @Test
    fun `a list that no longer extends what was sent forces a replacing full load`() {
        val sync = loaded(snap("a", "b", "c"))

        val load = sync.onSnapshot(snap("a", "x", "c", "d")).single() as TranscriptCommand.Load

        assertTrue(load.replace)
        assertEquals(listOf("a", "x", "c", "d"), load.snapshot.messages.map { it.id })
    }

    @Test
    fun `a rejected append falls back to a full load, and stale rejections are ignored`() {
        val sync = loaded(snap("a"))
        val first = sync.onSnapshot(snap("a", "b")).single() as TranscriptCommand.Append
        val second = sync.onSnapshot(snap("a", "b", "c")).single() as TranscriptCommand.Append

        val reload = sync.onMutationResult(first.generation, accepted = false).single() as TranscriptCommand.Load
        assertTrue(reload.replace)
        assertEquals(3, reload.snapshot.messages.size)
        // The second append was issued against the abandoned state; its
        // rejection must not start another load.
        assertEquals(emptyList<TranscriptCommand>(), sync.onMutationResult(second.generation, accepted = false))
    }

    @Test
    fun `a load that the bridge did not answer or answered for another session fails`() {
        val sync = TranscriptSessionSync()
        sync.onSnapshot(snap("a"))
        val load = sync.onBridgeReady().single() as TranscriptCommand.Load
        val noAnswer = sync.onLoadResult(load, null)
        assertEquals(false, noAnswer.activated)
        assertTrue(noAnswer.failureReason!!.contains("did not activate"))

        val retry = sync.onSnapshot(snap("a")).single() as TranscriptCommand.Load
        val wrong = sync.onLoadResult(retry, "other")
        assertTrue(wrong.failureReason!!.contains("activated other"))
        assertEquals(null, sync.confirmedSessionId)
    }

    @Test
    fun `switching sessions mid-load loads the newer session instead`() {
        val sync = TranscriptSessionSync()
        sync.onSnapshot(snap("a"))
        val load = sync.onBridgeReady().single() as TranscriptCommand.Load
        sync.onSnapshot(snap("z", sessionId = "s2"))

        val next = sync.onLoadResult(load, "s1").next.single() as TranscriptCommand.Load

        assertEquals("s2", next.snapshot.sessionId)
    }

    @Test
    fun `a page reload forgets what was sent and reloads everything`() {
        val sync = loaded(snap("a", "b"))

        val reload = sync.onBridgeReady().single() as TranscriptCommand.Load

        assertEquals(listOf("a", "b"), reload.snapshot.messages.map { it.id })
        sync.onBridgeLost()
        assertEquals(emptyList<TranscriptCommand>(), sync.onSnapshot(snap("a", "b", "c")))
    }

    @Test
    fun `an empty first frame is held until the host allows an empty load`() {
        val sync = TranscriptSessionSync()
        sync.onBridgeReady()
        assertEquals(emptyList<TranscriptCommand>(), sync.onSnapshot(snap()))

        assertTrue(sync.allowEmptyLoad("s1").single() is TranscriptCommand.Load)
    }
}
