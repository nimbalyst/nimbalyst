package com.nimbalyst.app.transcript

import com.nimbalyst.app.data.MessageEntity

/** What the host currently wants on screen: one Room emission plus the session fields. */
data class TranscriptSnapshot(
    val sessionId: String,
    val metadata: TranscriptMetadata,
    val messages: List<MessageEntity>,
)

/** A `window.nimbalyst` call the host must make. [generation] is echoed back with the result. */
sealed interface TranscriptCommand {
    val generation: Int

    data class Load(
        val snapshot: TranscriptSnapshot,
        val replace: Boolean,
        override val generation: Int,
    ) : TranscriptCommand

    data class Append(
        val sessionId: String,
        val messages: List<MessageEntity>,
        override val generation: Int,
    ) : TranscriptCommand

    data class UpdateMetadata(
        val sessionId: String,
        val metadata: TranscriptMetadata,
        override val generation: Int,
    ) : TranscriptCommand
}

/** How a `loadSession` round trip ended, plus whatever must be sent next. */
data class TranscriptLoadResult(
    val activated: Boolean,
    val failureReason: String? = null,
    val next: List<TranscriptCommand> = emptyList(),
)

/**
 * Decides, for every Room emission, whether the transcript needs a full
 * `loadSession` or only `appendMessages`/`updateMetadata` deltas. Mirrors the
 * iOS coordinator (`updateUIView` + `resolveTranscriptLoad`) as a pure state
 * machine so the decision is testable without a WebView.
 *
 * Invariants:
 * - Deltas are sent only after the bridge confirmed the session with a
 *   `loadSession` that echoed its id, and only while the new message list
 *   extends what was already sent. Anything else is a full load.
 * - Every command carries a generation. A reset (page reload, rejected
 *   mutation, new load) bumps it, so results from older calls are ignored
 *   instead of triggering a second recovery.
 * - A new session with no messages is not loaded until data arrives or the
 *   host calls [allowEmptyLoad]; the screen's first frame is an empty
 *   placeholder list, and loading it would blank a cached transcript.
 */
class TranscriptSessionSync {
    var bridgeReady: Boolean = false
        private set

    /** The session the bridge confirmed is on screen, or null while (re)loading. */
    var confirmedSessionId: String? = null
        private set

    private var latest: TranscriptSnapshot? = null
    private var loadInFlight: TranscriptCommand.Load? = null
    private var sentIds: List<String> = emptyList()
    private var sentMetadata: TranscriptMetadata? = null
    private var generation = 0
    private var replaceOnNextLoad = false
    private val emptyLoadAllowed = mutableSetOf<String>()

    /** True when the session the host wants is the one on screen. */
    val isShowingLatest: Boolean
        get() = latest != null && confirmedSessionId == latest?.sessionId

    val latestSnapshot: TranscriptSnapshot? get() = latest

    fun onSnapshot(snapshot: TranscriptSnapshot): List<TranscriptCommand> {
        latest = snapshot
        return plan()
    }

    /** Let an empty session load; the host calls this after a short grace period. */
    fun allowEmptyLoad(sessionId: String): List<TranscriptCommand> {
        emptyLoadAllowed += sessionId
        return plan()
    }

    /**
     * `window.nimbalyst` exists, either from a `ready` post or a probe. A
     * `ready` after a load means the page reloaded and is empty, so everything
     * previously sent is forgotten.
     */
    fun onBridgeReady(): List<TranscriptCommand> {
        bridgeReady = true
        forgetSentState()
        return plan()
    }

    /** The page or its renderer is gone. Nothing is sent until [onBridgeReady]. */
    fun onBridgeLost() {
        bridgeReady = false
        forgetSentState()
    }

    fun onLoadResult(command: TranscriptCommand.Load, activatedSessionId: String?): TranscriptLoadResult {
        if (command.generation != generation) {
            // Superseded by a reset while in flight; its answer describes a page
            // state we have already abandoned.
            return TranscriptLoadResult(activated = false, next = plan())
        }
        loadInFlight = null
        val requestedId = command.snapshot.sessionId

        if (activatedSessionId == null) {
            return TranscriptLoadResult(
                activated = false,
                failureReason = "transcript bridge did not activate $requestedId"
            )
        }

        // A newer session was requested mid-flight. It wins regardless of this
        // load's outcome.
        val wantedId = latest?.sessionId
        if (wantedId != null && wantedId != requestedId) {
            return TranscriptLoadResult(activated = false, next = plan())
        }

        if (activatedSessionId != requestedId) {
            return TranscriptLoadResult(
                activated = false,
                failureReason = "transcript bridge activated $activatedSessionId, expected $requestedId"
            )
        }

        confirmedSessionId = requestedId
        sentIds = command.snapshot.messages.map { it.id }
        sentMetadata = command.snapshot.metadata
        // Emissions that arrived while the load was in flight go out as deltas.
        return TranscriptLoadResult(activated = true, next = plan())
    }

    /**
     * Result of an append or metadata update. A rejection means the bridge is
     * showing some other session (or lost its state), so fall back to a full,
     * replacing load of the latest snapshot.
     */
    fun onMutationResult(commandGeneration: Int, accepted: Boolean): List<TranscriptCommand> {
        if (accepted || commandGeneration != generation) return emptyList()
        forgetSentState()
        replaceOnNextLoad = true
        return plan()
    }

    private fun forgetSentState() {
        generation++
        loadInFlight = null
        confirmedSessionId = null
        sentIds = emptyList()
        sentMetadata = null
    }

    private fun plan(): List<TranscriptCommand> {
        val snapshot = latest ?: return emptyList()
        if (!bridgeReady || loadInFlight != null) return emptyList()

        if (confirmedSessionId != snapshot.sessionId) {
            if (snapshot.messages.isEmpty() && snapshot.sessionId !in emptyLoadAllowed) {
                return emptyList()
            }
            return listOf(startLoad(snapshot, replace = replaceOnNextLoad))
        }

        val ids = snapshot.messages.map { it.id }
        if (!extendsSent(ids)) {
            // A row vanished or was reordered; deltas cannot express that.
            return listOf(startLoad(snapshot, replace = true))
        }

        val commands = mutableListOf<TranscriptCommand>()
        if (ids.size > sentIds.size) {
            commands += TranscriptCommand.Append(
                sessionId = snapshot.sessionId,
                messages = snapshot.messages.subList(sentIds.size, ids.size).toList(),
                generation = generation
            )
            sentIds = ids
        }
        if (snapshot.metadata != sentMetadata) {
            commands += TranscriptCommand.UpdateMetadata(snapshot.sessionId, snapshot.metadata, generation)
            sentMetadata = snapshot.metadata
        }
        return commands
    }

    private fun startLoad(snapshot: TranscriptSnapshot, replace: Boolean): TranscriptCommand.Load {
        generation++
        replaceOnNextLoad = false
        confirmedSessionId = null
        return TranscriptCommand.Load(snapshot, replace, generation).also { loadInFlight = it }
    }

    private fun extendsSent(ids: List<String>): Boolean {
        if (ids.size < sentIds.size) return false
        for (i in sentIds.indices) {
            if (ids[i] != sentIds[i]) return false
        }
        return true
    }
}
