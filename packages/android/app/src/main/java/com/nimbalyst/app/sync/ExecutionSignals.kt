package com.nimbalyst.app.sync

import com.nimbalyst.app.data.PendingExecution
import com.nimbalyst.app.data.SessionEntity
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * A change in whether the desktop is running, or about to run, a session's
 * turn. Emitted after the row is committed. This is evidence of desktop
 * activity for a prompt-delivery tracker, not a per-prompt receipt.
 */
data class SessionExecutionTransition(
    val sessionId: String,
    val isExecuting: Boolean,
    val wasExecuting: Boolean,
    /** The prompt the desktop accepted but has not started, if any. */
    val pendingExecution: PendingExecution?,
    val previousPendingExecution: PendingExecution?,
)

internal class ExecutionSignals {
    private val _transitions = MutableSharedFlow<SessionExecutionTransition>(extraBufferCapacity = 64)
    val transitions: SharedFlow<SessionExecutionTransition> = _transitions.asSharedFlow()

    /** Call after [after] is committed; emits only when execution state changed. */
    fun committed(before: SessionEntity?, after: SessionEntity) {
        val wasExecuting = before?.isExecuting ?: false
        val previousPending = before?.pendingExecution
        if (wasExecuting == after.isExecuting && previousPending == after.pendingExecution) return
        _transitions.tryEmit(
            SessionExecutionTransition(
                sessionId = after.id,
                isExecuting = after.isExecuting,
                wasExecuting = wasExecuting,
                pendingExecution = after.pendingExecution,
                previousPendingExecution = previousPending
            )
        )
    }
}
