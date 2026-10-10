package com.nimbalyst.app.pages

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Anything that takes the reader off the page they are editing. */
sealed interface PagesLeaveIntent {
    /** Native Back while the WebView has history. */
    data object WebBack : PagesLeaveIntent
    /** Native Back at the root: leave the Pages screen. */
    data object LeaveScreen : PagesLeaveIntent
    /** Another Team tab row, link or push asked for a different page. */
    data class ReplaceRoute(val route: ConsoleRoute) : PagesLeaveIntent
    /**
     * Any other document-replacing load: a `nimbalyst://console/...` rewrite, a full
     * navigation the page started, re-auth.
     */
    data class LoadUrl(val url: String) : PagesLeaveIntent
}

/** The console side the guard talks to. */
interface PagesUnsyncedEdits : ConsoleFlushing {
    /**
     * `editState.unsynced`: counts every unacknowledged edit, including pages
     * already navigated away from (contract r2), until acknowledged or discarded.
     */
    val unsynced: Boolean
    suspend fun discardUnsynced(): Int?
}

/** One path for every way of leaving: flush first; if edits are still not on the server, ask. */
class PagesLeaveGuard(private val flushTimeoutMs: Int = PagesFlushCoordinator.FLUSH_TIMEOUT_MS) {
    /** The intent waiting on the reader's answer. */
    var pending: PagesLeaveIntent? = null
        private set

    /**
     * True when leaving is safe now: nothing unsynced, or a flush the server
     * acknowledged. Touches no state, so a request that went stale during the
     * flush cannot overwrite a newer one; the caller decides, then [hold]s.
     */
    suspend fun mayProceed(edits: PagesUnsyncedEdits): Boolean {
        if (!edits.unsynced) return true
        val result = edits.flushPending(flushTimeoutMs)
        // `flushPending` covers every unacknowledged edit, so either answer means none is left.
        return result?.status == ConsoleFlushResult.Status.ACKNOWLEDGED || result?.status == ConsoleFlushResult.Status.NOT_REQUIRED
    }

    fun hold(intent: PagesLeaveIntent) {
        pending = intent
    }

    /** "Leave": hand back the intent to perform. The caller discards the console's unsynced edits first. */
    fun take(): PagesLeaveIntent? = pending.also { pending = null }

    /** "Keep Editing": drop the intent and hand it back so the caller can undo what started it. */
    fun cancel(): PagesLeaveIntent? = pending.also { pending = null }
}

/** The document a [PagesNavigator] guards. The Pages WebView controller implements it. */
interface PagesDocument : PagesUnsyncedEdits {
    val isTornDown: Boolean
    /** The page native opened (a Team tab row, link or push). */
    val currentRoute: ConsoleRoute?
    /**
     * Do an approved [intent]. The edits are acknowledged or discarded, so nothing
     * unsynced stays counted for the document being replaced. Returns true when
     * the caller should leave the screen.
     */
    fun performApproved(intent: PagesLeaveIntent): Boolean
}

/**
 * Every document-replacing navigation goes through here. Each request takes a
 * new generation, and only the latest one may act after a suspension, so a stale
 * request whose flush returns late never loads or asks over a newer one.
 */
class PagesNavigator(
    private val document: PagesDocument,
    private val guard: PagesLeaveGuard = PagesLeaveGuard(),
) {
    private val _pendingLeave = MutableStateFlow<PagesLeaveIntent?>(null)
    /** A leave waiting on "Leave without saving?". */
    val pendingLeave: StateFlow<PagesLeaveIntent?> = _pendingLeave.asStateFlow()

    private var generation = 0L

    /** Returns true when the caller should leave the screen. */
    suspend fun requestLeave(intent: PagesLeaveIntent): Boolean {
        val mine = ++generation
        if (_pendingLeave.value != null) {
            _pendingLeave.value = null
            guard.cancel()
        }
        val proceed = guard.mayProceed(document)
        if (mine != generation || document.isTornDown) return false
        if (proceed) return document.performApproved(intent)
        guard.hold(intent)
        _pendingLeave.value = intent
        return false
    }

    /**
     * "Leave": take the intent now (synchronously, so a dialog dismissal that
     * follows the button cannot cancel it first), then discard unsynced edits and
     * do what was asked. Null when nothing was pending. The returned block
     * returns true when the caller should leave the screen.
     */
    fun confirmPendingLeave(): (suspend () -> Boolean)? {
        _pendingLeave.value = null
        val intent = guard.take() ?: return null
        val mine = ++generation
        return {
            if (document.isTornDown) {
                false
            } else {
                document.discardUnsynced()
                if (mine != generation || document.isTornDown) false else document.performApproved(intent)
            }
        }
    }

    /** "Keep Editing". Returns the route still on screen when a replacement was refused, so the caller can re-select it. */
    fun cancelPendingLeave(): ConsoleRoute? {
        _pendingLeave.value = null
        generation++
        return if (guard.cancel() is PagesLeaveIntent.ReplaceRoute) document.currentRoute else null
    }
}
