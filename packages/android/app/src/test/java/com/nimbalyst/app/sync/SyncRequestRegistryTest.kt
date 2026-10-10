package com.nimbalyst.app.sync

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SyncRequestRegistryTest {
    private val scope = TestScope()
    private val errors = SyncErrors()
    private var online = true
    private val sent = mutableListOf<String>()
    private val registry = SyncRequestRegistry(scope, { _, json -> online.also { if (it) sent += json } }, errors, timeoutMs = 1_000)

    @Test
    fun `an unanswered request times out once, and a late answer changes nothing`() {
        registry.request(SyncRequestKind.CREATE_WORKTREE, "r1", "{}")
        scope.advanceTimeBy(1_001)
        scope.runCurrent()
        assertEquals(SyncErrorKind.REQUEST_TIMEOUT, errors.current.value?.kind)

        errors.clear()
        registry.resolve("r1", detail = "late refusal")
        assertNull(errors.current.value)
    }

    @Test
    fun `only writes with a rebuild are replayed, and a disconnect reports what was in flight`() = kotlinx.coroutines.runBlocking {
        online = false
        registry.send(SyncRequestKind.SESSION_CONTROL, "answer")
        registry.send(SyncRequestKind.DRAFT_PUSH, "draft-1", coalesceKey = "draft:s1", rebuild = { "draft-now" })
        registry.send(SyncRequestKind.DRAFT_PUSH, "draft-2", coalesceKey = "draft:s1", rebuild = { "draft-now" })
        assertEquals(1, registry.replayCount)

        online = true
        registry.reconnect()
        // The ping is the delivery barrier for the replayed edit.
        assertEquals(listOf("draft-now", """{"type":"ping"}"""), sent)

        registry.request(SyncRequestKind.CREATE_WORKTREE, "r2", "{}")
        errors.clear()
        registry.disconnect()
        assertEquals(SyncErrorKind.TRANSPORT, errors.current.value?.kind)
    }

    /** R2a-5: OkHttp accepting a frame is not the server receiving it. */
    @Test
    fun `an accepted edit lost with the socket is republished, until a pong proves it arrived`() = kotlinx.coroutines.runBlocking {
        registry.send(SyncRequestKind.DRAFT_PUSH, "draft-1", coalesceKey = "draft:s1", rebuild = { "draft-now" })
        registry.send(SyncRequestKind.SESSION_CONTROL, "answer")
        registry.disconnect()
        assertNull("it may well have landed; nothing to warn about", errors.current.value)

        sent.clear()
        registry.reconnect()
        assertEquals("prompt responses are never replayed", listOf("draft-now"), sent.filterNot { it.contains("ping") })

        registry.deliveryConfirmed()
        registry.disconnect()
        sent.clear()
        registry.reconnect()
        assertEquals("confirmed edits are not replayed", emptyList<String>(), sent)
    }
}
