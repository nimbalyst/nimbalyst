package com.nimbalyst.app.ui.sessiondetail

import com.nimbalyst.app.data.MessageEntity
import com.nimbalyst.app.data.PendingExecution
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PromptDeliveryTrackerTest {
    private val sessionId = "s1"

    private fun message(id: String, direction: String, createdAt: Long, source: String = "claude-code") =
        MessageEntity(id = id, sessionId = sessionId, sequence = 0, source = source, direction = direction, createdAt = createdAt)

    @Test
    fun `idle desktop that never reacts produces a warning`() {
        val tracker = PromptDeliveryTracker()
        val id = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 1_000)
        assertTrue(tracker.sent(id))
        tracker.expire(id)
        assertTrue(tracker.warning.value)
    }

    @Test
    fun `prompt queued behind a running turn never warns`() {
        val tracker = PromptDeliveryTracker()
        val id = tracker.begin(sessionId, isExecuting = true, messages = emptyList(), now = 1_000)
        assertFalse("no timer is needed", tracker.sent(id))
        tracker.expire(id)
        assertFalse(tracker.warning.value)
    }

    @Test
    fun `execution observed from the session row confirms and clears a warning`() {
        val tracker = PromptDeliveryTracker()
        val id = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 1_000)
        tracker.sent(id)
        tracker.expire(id)
        tracker.observeSession(sessionId, isExecuting = true, hasQueuedPrompts = false)
        assertFalse(tracker.warning.value)
        tracker.expire(id)
        assertFalse(tracker.warning.value)
    }

    @Test
    fun `queued prompt drained without an observed running row confirms`() {
        val tracker = PromptDeliveryTracker()
        val id = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 1_000)
        tracker.sent(id)
        // A row that never showed the queue is not evidence of consumption.
        tracker.observeSession(sessionId, isExecuting = false, hasQueuedPrompts = false)
        tracker.observeSession(sessionId, isExecuting = false, hasQueuedPrompts = true)
        tracker.observeSession(sessionId, isExecuting = false, hasQueuedPrompts = false)
        tracker.expire(id)
        assertFalse(tracker.warning.value)
    }

    @Test
    fun `a new pendingExecution confirms, the one present at send time does not`() {
        val tracker = PromptDeliveryTracker()
        val stale = PendingExecution(messageId = "m0", sentAt = 500, sentBy = "desktop")
        val id = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 1_000, pendingExecution = stale)
        tracker.sent(id)
        tracker.observeSession(sessionId, isExecuting = false, hasQueuedPrompts = true, pendingExecution = stale)
        tracker.expire(id)
        assertTrue(tracker.warning.value)

        val accepted = PendingExecution(messageId = "m1", sentAt = 1_050, sentBy = "mobile")
        tracker.observeSession(sessionId, isExecuting = false, hasQueuedPrompts = null, pendingExecution = accepted)
        assertFalse(tracker.warning.value)
    }

    @Test
    fun `a transition without queue state neither confirms nor arms the drained-queue rule`() {
        val tracker = PromptDeliveryTracker()
        val id = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 1_000)
        tracker.sent(id)
        tracker.observeSession(sessionId, isExecuting = false, hasQueuedPrompts = null)
        tracker.observeSession(sessionId, isExecuting = false, hasQueuedPrompts = false)
        tracker.expire(id)
        assertTrue(tracker.warning.value)
    }

    @Test
    fun `only new desktop output counts as message evidence`() {
        val tracker = PromptDeliveryTracker()
        val old = message("old", "output", createdAt = 500)
        val id = tracker.begin(sessionId, isExecuting = false, messages = listOf(old), now = 1_000)
        tracker.sent(id)
        tracker.observeMessages(
            listOf(
                old,
                message("echo", "input", createdAt = 1_100),
                message("sys", "output", createdAt = 1_100, source = "system"),
                message("history", "output", createdAt = 900)
            )
        )
        tracker.expire(id)
        assertTrue(tracker.warning.value)

        tracker.observeMessages(listOf(message("reply", "output", createdAt = 1_200)))
        assertFalse(tracker.warning.value)
    }

    @Test
    fun `a failed send is reported once and a stale timer is ignored`() {
        val tracker = PromptDeliveryTracker()
        val first = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 1_000)
        assertTrue(tracker.failed(first))
        assertFalse(tracker.failed(first))

        val second = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 2_000)
        tracker.sent(second)
        tracker.expire(first)
        assertFalse(tracker.warning.value)
    }

    @Test
    fun `rows for another session are ignored`() {
        val tracker = PromptDeliveryTracker()
        val id = tracker.begin(sessionId, isExecuting = false, messages = emptyList(), now = 1_000)
        tracker.sent(id)
        tracker.observeSession("other", isExecuting = true, hasQueuedPrompts = false)
        tracker.expire(id)
        assertTrue(tracker.warning.value)
    }
}
