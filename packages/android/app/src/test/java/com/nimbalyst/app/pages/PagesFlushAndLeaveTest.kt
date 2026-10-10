package com.nimbalyst.app.pages

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Flush on stop and the lost-edits notice, and the leave guard every
 * document-replacing navigation goes through. Mirrors iOS
 * `PagesFlushCoordinatorTests` and the leave cases of `PagesWebViewTests`.
 */
class PagesFlushAndLeaveTest {
    private val acknowledged = ConsoleFlushResult(ConsoleFlushResult.Status.ACKNOWLEDGED)
    private val timedOut = ConsoleFlushResult(ConsoleFlushResult.Status.TIMED_OUT)

    private class FakeBridge(var answer: suspend () -> ConsoleFlushResult?) : ConsoleFlushing {
        var calls = 0
        override suspend fun flushPending(timeoutMs: Int): ConsoleFlushResult? {
            calls += 1
            return answer()
        }
    }

    @Test
    fun `stop flushes once and records the outcome`() = runTest {
        val coordinator = PagesFlushCoordinator(MemoryConsoleStore())
        val bridge = FakeBridge { acknowledged }
        coordinator.bridge = bridge
        assertEquals(PagesFlushOutcome.Acknowledged, coordinator.appDidStop())
        assertEquals(1, bridge.calls)
        assertEquals(0, coordinator.recordedFailures)

        bridge.answer = { ConsoleFlushResult(ConsoleFlushResult.Status.FAILED, "socket closed") }
        assertEquals(PagesFlushOutcome.Failed("socket closed"), coordinator.appDidStop())
        bridge.answer = { timedOut }
        assertEquals(PagesFlushOutcome.TimedOut, coordinator.appDidStop())
        assertEquals("a failure or timeout is recorded, not swallowed", 2, coordinator.recordedFailures)
    }

    @Test
    fun `native timeout ends the wait when the console never answers`() = runTest {
        val store = MemoryConsoleStore()
        val coordinator = PagesFlushCoordinator(store, nativeTimeoutMs = 100)
        coordinator.bridge = FakeBridge { awaitCancellation() }
        assertEquals(PagesFlushOutcome.TimedOut, coordinator.appDidStop())
        assertEquals(1, coordinator.recordedFailures)
        assertEquals("TimedOut", store.getString(PagesFlushCoordinator.LAST_OUTCOME_KEY))
    }

    @Test
    fun `no bridge flushes nothing, and a second stop during a flush does not start another`() = runTest {
        val coordinator = PagesFlushCoordinator(MemoryConsoleStore())
        assertEquals(PagesFlushOutcome.NoBridge, coordinator.appDidStop())

        val release = CompletableDeferred<ConsoleFlushResult?>()
        val bridge = FakeBridge { release.await() }
        coordinator.bridge = bridge
        val first = async { coordinator.appDidStop() }
        runCurrent()
        assertEquals(PagesFlushOutcome.NotRequired, coordinator.appDidStop())
        release.complete(acknowledged)
        assertEquals(PagesFlushOutcome.Acknowledged, first.await())
        assertEquals(1, bridge.calls)
    }

    @Test
    fun `a render process kill with unsynced edits shows the notice once`() {
        val coordinator = PagesFlushCoordinator(MemoryConsoleStore())
        coordinator.editStateChanged(editing = true, unsynced = true)
        coordinator.contentProcessTerminated()
        assertFalse(coordinator.unsynced)
        assertTrue(coordinator.consumeLostEditsNotice())
        assertFalse(coordinator.consumeLostEditsNotice())

        // Synced edits leave nothing to report.
        coordinator.editStateChanged(editing = true, unsynced = false)
        coordinator.contentProcessTerminated()
        assertFalse(coordinator.consumeLostEditsNotice())
    }

    @Test
    fun `an app kill with unsynced edits shows the notice on next launch`() {
        val disk = MemoryConsoleStore()
        PagesFlushCoordinator(disk).editStateChanged(editing = true, unsynced = true)
        // The process dies here. Next launch:
        val relaunched = PagesFlushCoordinator(disk)
        assertTrue(relaunched.consumeLostEditsNotice())
        assertFalse(PagesFlushCoordinator(disk).consumeLostEditsNotice())
    }

    /** A document whose flush answer each test controls. */
    private class FakeDocument(
        override var unsynced: Boolean,
        var flushAnswer: suspend () -> ConsoleFlushResult?,
    ) : PagesDocument {
        override var isTornDown = false
        override var currentRoute: ConsoleRoute? = ConsoleRoute.parse("/org/organization-a/project/p1/wiki")
        val performed = mutableListOf<PagesLeaveIntent>()
        var discarded = 0

        override suspend fun flushPending(timeoutMs: Int): ConsoleFlushResult? = flushAnswer()
        override suspend fun discardUnsynced(): Int {
            discarded += 1
            unsynced = false
            return 2
        }
        override fun performApproved(intent: PagesLeaveIntent): Boolean {
            performed += intent
            unsynced = false
            return intent == PagesLeaveIntent.LeaveScreen
        }
    }

    private val otherRoute = ConsoleRoute.parse("/org/organization-a/project/p1/trackers")!!

    @Test
    fun `nothing unsynced, or a flush the server acknowledged, proceeds without asking`() = runTest {
        val clean = FakeDocument(unsynced = false) { error("no flush needed") }
        assertTrue(PagesNavigator(clean).requestLeave(PagesLeaveIntent.LeaveScreen))

        val flushed = FakeDocument(unsynced = true) { acknowledged }
        val navigator = PagesNavigator(flushed)
        assertFalse(navigator.requestLeave(PagesLeaveIntent.ReplaceRoute(otherRoute)))
        assertEquals(listOf<PagesLeaveIntent>(PagesLeaveIntent.ReplaceRoute(otherRoute)), flushed.performed)
        assertNull(navigator.pendingLeave.value)
        assertEquals(0, flushed.discarded)
    }

    @Test
    fun `a flush timeout asks, and keep editing hands back the page still on screen`() = runTest {
        val document = FakeDocument(unsynced = true) { timedOut }
        val navigator = PagesNavigator(document)
        assertFalse(navigator.requestLeave(PagesLeaveIntent.ReplaceRoute(otherRoute)))
        assertEquals(PagesLeaveIntent.ReplaceRoute(otherRoute), navigator.pendingLeave.value)
        assertTrue(document.performed.isEmpty())

        assertEquals(document.currentRoute, navigator.cancelPendingLeave())
        assertNull(navigator.pendingLeave.value)
        assertTrue(document.performed.isEmpty())
        assertEquals(0, document.discarded)
        assertNull("nothing left to confirm", navigator.confirmPendingLeave())
    }

    @Test
    fun `leave discards the unsynced edits, then does what was asked`() = runTest {
        val document = FakeDocument(unsynced = true) { null }
        val navigator = PagesNavigator(document)
        assertFalse(navigator.requestLeave(PagesLeaveIntent.LeaveScreen))
        val leave = navigator.confirmPendingLeave()!!
        assertNull("taken synchronously, so a dialog dismissal cannot cancel it", navigator.pendingLeave.value)
        assertTrue(leave())
        assertEquals(1, document.discarded)
        assertEquals(listOf<PagesLeaveIntent>(PagesLeaveIntent.LeaveScreen), document.performed)
        assertNull("keep editing after the fact undoes nothing", navigator.cancelPendingLeave())
    }

    @Test
    fun `retry over a live document with unsynced edits asks before reloading`() = runTest {
        // A failed session refresh leaves the page alive; its edits cannot reach the server.
        val document = FakeDocument(unsynced = true) { ConsoleFlushResult(ConsoleFlushResult.Status.FAILED, "no session") }
        val navigator = PagesNavigator(document)
        val reload = PagesLeaveIntent.LoadUrl("https://console.nimbalyst.com/org/organization-a/project/p1/wiki")
        assertFalse(navigator.requestLeave(reload))
        assertEquals(reload, navigator.pendingLeave.value)
        assertTrue("the reload waits on the reader", document.performed.isEmpty())
        assertEquals(0, document.discarded)
    }

    @Test
    fun `a stale leave request never acts after a newer one`() = runTest {
        val slowFlush = CompletableDeferred<ConsoleFlushResult?>()
        var flushes = 0
        val document = FakeDocument(unsynced = true) {
            flushes += 1
            if (flushes == 1) slowFlush.await() else timedOut
        }
        val navigator = PagesNavigator(document)
        val stale = async { navigator.requestLeave(PagesLeaveIntent.LoadUrl("https://console.nimbalyst.com/org/organization-a/project/p1/marks")) }
        runCurrent()
        // The reader asks for another page while the first flush is still out.
        assertFalse(navigator.requestLeave(PagesLeaveIntent.ReplaceRoute(otherRoute)))
        assertEquals(PagesLeaveIntent.ReplaceRoute(otherRoute), navigator.pendingLeave.value)

        slowFlush.complete(acknowledged)
        assertFalse(stale.await())
        assertTrue("the stale request neither loads nor asks", document.performed.isEmpty())
        assertEquals(PagesLeaveIntent.ReplaceRoute(otherRoute), navigator.pendingLeave.value)
    }

    @Test
    fun `nothing acts on a torn-down document`() = runTest {
        val document = FakeDocument(unsynced = true) { timedOut }
        val navigator = PagesNavigator(document)
        navigator.requestLeave(PagesLeaveIntent.WebBack)
        val leave = navigator.confirmPendingLeave()!!
        document.isTornDown = true
        assertFalse(leave())
        assertTrue(document.performed.isEmpty())
        assertEquals(0, document.discarded)
    }
}
