package com.nimbalyst.app.pages

import android.util.Log
import kotlinx.coroutines.withTimeoutOrNull

/** Calls the console's `flushPending`. The Pages WebView controller implements it. */
interface ConsoleFlushing {
    /** Null when the console bridge is not installed (nothing to flush). */
    suspend fun flushPending(timeoutMs: Int): ConsoleFlushResult?
}

/** What one background flush came to. Recorded, never swallowed. */
sealed interface PagesFlushOutcome {
    data object Acknowledged : PagesFlushOutcome
    data object NotRequired : PagesFlushOutcome
    /** The console's own timeout, or native gave up waiting. */
    data object TimedOut : PagesFlushOutcome
    data class Failed(val detail: String?) : PagesFlushOutcome
    data object NoBridge : PagesFlushOutcome
}

/**
 * Flush-on-stop and the "your last edits may not have saved" notice.
 *
 * The console keeps document Y.Docs in memory only, and Android may kill a
 * stopped app's process at any time. When the app leaves the foreground
 * (`ON_STOP`) this asks the console to flush and waits for the first of its
 * answer or native's own timeout. If the page had unsynced edits and its render
 * process (or the app) dies, the next load shows a one-line notice instead of
 * silently reloading over the gap.
 */
class PagesFlushCoordinator(
    private val store: ConsoleKeyValueStore,
    private val nativeTimeoutMs: Long = FLUSH_TIMEOUT_MS + 1_000L,
) {
    var bridge: ConsoleFlushing? = null

    var editing = false
        private set
    var unsynced = false
        private set
    var lastOutcome: PagesFlushOutcome? = null
        private set
    var recordedFailures = 0
        private set

    // Set by the previous process while it held unsynced edits; still being
    // here means it never saw them reach the server.
    private var lostEditsPending: Boolean = store.getString(UNSYNCED_MARKER_KEY) == "true"
    private var flushInFlight = false

    init {
        store.putString(UNSYNCED_MARKER_KEY, null)
    }

    /** `editState` from the console. */
    fun editStateChanged(editing: Boolean, unsynced: Boolean) {
        this.editing = editing
        this.unsynced = unsynced
        store.putString(UNSYNCED_MARKER_KEY, if (unsynced) "true" else null)
    }

    /** The render process died. Unsynced edits in it are gone. */
    fun contentProcessTerminated() {
        if (unsynced) {
            Log.w(TAG, "Console render process terminated with unsynced edits")
            lostEditsPending = true
        }
        editStateChanged(editing = false, unsynced = false)
    }

    /** True once after a process kill that held unsynced edits; the caller shows the notice. */
    fun consumeLostEditsNotice(): Boolean = lostEditsPending.also { lostEditsPending = false }

    /** The app left the foreground. Returns once the console answered or native gave up. */
    suspend fun appDidStop(): PagesFlushOutcome {
        val bridge = bridge ?: return record(PagesFlushOutcome.NoBridge)
        if (flushInFlight) return PagesFlushOutcome.NotRequired
        flushInFlight = true
        try {
            // Wrapped so "no bridge" (a null answer) and "no answer in time" stay distinct.
            val answer = withTimeoutOrNull(nativeTimeoutMs) { Answer(bridge.flushPending(FLUSH_TIMEOUT_MS)) }
            return record(answer?.let { outcome(it.result) } ?: PagesFlushOutcome.TimedOut)
        } finally {
            flushInFlight = false
        }
    }

    private class Answer(val result: ConsoleFlushResult?)

    private fun record(outcome: PagesFlushOutcome): PagesFlushOutcome {
        lastOutcome = outcome
        store.putString(LAST_OUTCOME_KEY, outcome.toString())
        when (outcome) {
            PagesFlushOutcome.Acknowledged, PagesFlushOutcome.NotRequired, PagesFlushOutcome.NoBridge ->
                Log.i(TAG, "Background flush: $outcome")
            PagesFlushOutcome.TimedOut, is PagesFlushOutcome.Failed -> {
                recordedFailures += 1
                Log.e(TAG, "Background flush did not reach the server: $outcome")
            }
        }
        return outcome
    }

    companion object {
        private const val TAG = "ConsolePages"
        const val FLUSH_TIMEOUT_MS = 5_000
        const val UNSYNCED_MARKER_KEY = "consolePages.unsyncedAtBackground"
        const val LAST_OUTCOME_KEY = "consolePages.lastBackgroundFlush"

        fun outcome(result: ConsoleFlushResult?): PagesFlushOutcome = when (result?.status) {
            null -> PagesFlushOutcome.NoBridge
            ConsoleFlushResult.Status.ACKNOWLEDGED -> PagesFlushOutcome.Acknowledged
            ConsoleFlushResult.Status.NOT_REQUIRED -> PagesFlushOutcome.NotRequired
            ConsoleFlushResult.Status.TIMED_OUT -> PagesFlushOutcome.TimedOut
            ConsoleFlushResult.Status.FAILED -> PagesFlushOutcome.Failed(result.detail)
        }
    }
}
