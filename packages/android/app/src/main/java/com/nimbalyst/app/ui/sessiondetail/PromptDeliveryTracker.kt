package com.nimbalyst.app.ui.sessiondetail

import com.nimbalyst.app.data.MessageEntity
import com.nimbalyst.app.data.PendingExecution
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Port of iOS `PromptDeliveryTracker`. Tracks evidence of desktop activity, not
 * a durable per-prompt receipt, so a timeout reports uncertainty and never
 * triggers a resend.
 *
 * Timing is owned by the caller: when [sent] returns true, schedule [expire]
 * after the timeout. Every signal is read from the observed session row, never
 * from a value captured when the prompt was sent.
 */
class PromptDeliveryTracker {
    private data class Pending(
        val id: String,
        val sessionId: String,
        val startedAt: Long,
        val existingMessageIds: Set<String>,
        val confirmed: Boolean,
        /** The row's pendingExecution at send time; only a different one is new evidence. */
        val baselinePending: PendingExecution?,
        /** True once the row has shown this device's queued prompt. */
        val sawQueued: Boolean = false,
    )

    private var pending: Pending? = null
    private val _warning = MutableStateFlow(false)
    val warning: StateFlow<Boolean> = _warning.asStateFlow()

    /**
     * Start tracking a submission. A prompt queued behind a running turn is
     * confirmed from the start: it cannot produce a new idle -> running
     * transition within the timeout.
     */
    fun begin(
        sessionId: String,
        isExecuting: Boolean,
        messages: List<MessageEntity>,
        now: Long,
        pendingExecution: PendingExecution? = null,
    ): String {
        cancel()
        val id = UUID.randomUUID().toString()
        pending = Pending(
            id = id,
            sessionId = sessionId,
            startedAt = now,
            existingMessageIds = messages.mapTo(HashSet()) { it.id },
            confirmed = isExecuting,
            baselinePending = pendingExecution
        )
        return id
    }

    /** The send succeeded. Returns true when the caller should schedule [expire]. */
    fun sent(id: String): Boolean {
        val current = pending ?: return false
        return current.id == id && !current.confirmed
    }

    /**
     * Feed every observed session row and execution transition. Running, a
     * new pendingExecution (the desktop accepted a prompt it has not started),
     * or a queued prompt that disappears after this device saw it, is evidence
     * the desktop picked the prompt up. [hasQueuedPrompts] is null for a
     * transition, which does not carry it.
     */
    fun observeSession(
        sessionId: String,
        isExecuting: Boolean,
        hasQueuedPrompts: Boolean?,
        pendingExecution: PendingExecution? = null,
    ) {
        val current = pending ?: return
        if (current.sessionId != sessionId || current.confirmed) return
        val newlyAccepted = pendingExecution != null && pendingExecution != current.baselinePending
        when {
            isExecuting || newlyAccepted -> confirmActivity()
            hasQueuedPrompts == null -> Unit
            hasQueuedPrompts -> pending = current.copy(sawQueued = true)
            current.sawQueued -> confirmActivity()
        }
    }

    fun observeMessages(messages: List<MessageEntity>) {
        val current = pending ?: return
        if (current.confirmed) return
        // Local optimistic user messages and old history loaded after sending
        // are not evidence the desktop processed this submission.
        val hasNewOutput = messages.any {
            it.sessionId == current.sessionId &&
                it.direction == "output" &&
                it.source != "system" &&
                it.createdAt >= current.startedAt &&
                it.id !in current.existingMessageIds
        }
        if (hasNewOutput) confirmActivity()
    }

    fun expire(id: String) {
        val current = pending ?: return
        if (current.id != id || current.confirmed) return
        _warning.value = true
    }

    /** The send failed. Returns true when [id] is still current, so the caller restores the draft. */
    fun failed(id: String): Boolean {
        if (pending?.id != id) return false
        cancel()
        return true
    }

    fun dismissWarning() {
        _warning.value = false
    }

    fun cancel() {
        pending = null
        _warning.value = false
    }

    private fun confirmActivity() {
        pending = pending?.copy(confirmed = true)
        _warning.value = false
    }
}
