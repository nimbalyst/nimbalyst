package com.nimbalyst.app.sync

import android.util.Log
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** What an outbound sync message is for, and what the user loses when it fails. */
internal enum class SyncRequestKind(val failureDescription: String, val isUserVisible: Boolean = true) {
    DRAFT_PUSH("Your draft is saved on this device and may not have reached your desktop. It will be sent again when the connection returns."),
    READ_RECEIPT("Read state is saved on this device and may not have reached your desktop. It will be sent again when the connection returns."),
    SESSION_CONTROL("The desktop may not have received your response. Check the session before answering again."),
    ARCHIVE("The archive change is saved on this device and may not have reached your desktop. It will be sent again when the connection returns."),
    REPARENT("The move is saved on this device and may not have reached your desktop. It will be sent again when the connection returns."),
    TOOL_RESULT("Your response is saved on this device but may be missing from the transcript elsewhere."),
    CREATE_WORKTREE("The desktop did not confirm the new worktree. It may still appear; check the session list before trying again."),
    /** The composer shows its own error and gets the text back. */
    PROMPT("The desktop did not confirm your prompt. Check the session before sending it again.", isUserVisible = false),
    PUSH_TOKEN("Notifications may not reach this device until it reconnects.", isUserVisible = false),
}

internal enum class SyncChannel { INDEX, SESSION }

/** The terminal result of one registered send. [error] is null when it landed (and, for a request, was answered). */
internal data class SyncRequestOutcome(val requestId: String, val kind: SyncRequestKind, val error: SyncError?)

/**
 * The single owner of outbound sync messages that are not fire-and-forget.
 * Port of iOS `SyncRequestRegistry`. Every send produces exactly one terminal
 * outcome:
 *  - [send]: the desktop never answers. Terminal when the socket accepts the
 *    frame or refuses it.
 *  - [request]: the desktop answers by requestId. Terminal on [resolve], a
 *    refused send, [disconnect], or timeout.
 *
 * An optimistic local write passes a `rebuild` that re-creates the message
 * from current local state. On failure it is parked under its coalesce key and
 * replayed by [reconnect] from what the row says then, so three offline edits
 * publish once. Anything without a rebuild (prompt responses, prompts) is
 * never replayed: by reconnect the desktop has moved on.
 *
 * OkHttp reports only whether a frame was queued, and a queued frame can die
 * with the socket. So an accepted index edit with a rebuild, or a
 * [sendConfirmed] prompt, stays unconfirmed
 * until the server answers a `ping` sent after it: the room handles one
 * socket's messages in order, so the `pong` proves every earlier frame
 * arrived. A disconnect parks whatever is still unconfirmed for [reconnect],
 * silently, since it may well have landed and republishing current row
 * state is idempotent.
 */
internal class SyncRequestRegistry(
    private val scope: CoroutineScope,
    private val sender: (SyncChannel, String) -> Boolean,
    private val errors: SyncErrors,
    private val timeoutMs: Long = TIMEOUT_MS,
) {
    private class Pending(
        val kind: SyncRequestKind,
        val channel: SyncChannel,
        val coalesceKey: String?,
        val rebuild: (suspend () -> String?)?,
        var timeout: Job? = null,
        /** Set by [sendConfirmed]: completed true on the covering pong, false when the socket drops first. */
        val delivered: CompletableDeferred<Boolean>? = null,
    )

    private val pending = ConcurrentHashMap<String, Pending>()
    private val replay = ConcurrentHashMap<String, Pending>()

    /** Accepted by the index socket, not yet proven received; keyed like [replay]. Guarded by [barrierLock]. */
    private val unconfirmed = LinkedHashMap<String, Pending>()
    private val barrierLock = Any()
    /** Entries at the head of [unconfirmed] that the outstanding ping covers, or null when none is outstanding. */
    private var pingCovers: Set<String>? = null

    /** Fires once per terminal outcome. */
    var onOutcome: ((SyncRequestOutcome) -> Unit)? = null

    val replayCount: Int get() = replay.size

    /** Sends [json]. Returns whether the socket accepted it. */
    fun send(
        kind: SyncRequestKind,
        json: String,
        channel: SyncChannel = SyncChannel.INDEX,
        coalesceKey: String? = null,
        rebuild: (suspend () -> String?)? = null,
    ): Boolean {
        val id = UUID.randomUUID().toString()
        // A newer write for the same thing supersedes a parked one.
        coalesceKey?.let(replay::remove)
        pending[id] = Pending(kind, channel, coalesceKey, rebuild)
        return dispatch(id, json, expectsResponse = false)
    }

    /**
     * Sends [json], which is never replayed, and returns only once the room
     * has proven receipt with a `pong`. False when the socket refused the
     * frame, dropped before the pong, or no pong came within the timeout: the
     * caller gets its content back to retry by hand.
     */
    suspend fun sendConfirmed(kind: SyncRequestKind, json: String): Boolean {
        val id = UUID.randomUUID().toString()
        val delivered = CompletableDeferred<Boolean>()
        pending[id] = Pending(kind, SyncChannel.INDEX, coalesceKey = null, rebuild = null, delivered = delivered)
        if (!dispatch(id, json, expectsResponse = false)) return false
        return withTimeoutOrNull(timeoutMs) { delivered.await() } ?: false
    }

    /** Sends [json] and waits for [resolve] with [requestId]. Returns whether the socket accepted it. */
    fun request(kind: SyncRequestKind, requestId: String, json: String, channel: SyncChannel = SyncChannel.INDEX): Boolean {
        val entry = Pending(kind, channel, coalesceKey = null, rebuild = null)
        pending[requestId] = entry
        entry.timeout = scope.launch {
            delay(timeoutMs)
            fail(requestId, SyncErrorKind.REQUEST_TIMEOUT, "no response within ${timeoutMs}ms")
        }
        return dispatch(requestId, json, expectsResponse = true)
    }

    /**
     * Records the desktop's answer. A [detail] marks it failed and is shown
     * as-is. Unknown ids belong to another device, or already timed out.
     */
    fun resolve(requestId: String, detail: String? = null) {
        if (detail != null) {
            fail(requestId, SyncErrorKind.TRANSPORT, detail, userMessage = detail)
        } else {
            succeed(requestId)
        }
    }

    /** Fails everything in flight. Optimistic writes are parked; requests are reported, as they may have landed. */
    fun disconnect() {
        pending.keys.toList().forEach { fail(it, SyncErrorKind.TRANSPORT, "disconnected before the send was confirmed") }
        synchronized(barrierLock) {
            // The newest parked write for a key wins; an unconfirmed one never
            // replaces a newer failure already waiting. A confirmed send is
            // never replayed; its caller hears it may not have landed.
            unconfirmed.forEach { (key, entry) ->
                entry.delivered?.complete(false)
                if (entry.rebuild != null) replay.putIfAbsent(key, entry)
            }
            unconfirmed.clear()
            pingCovers = null
        }
    }

    /**
     * The index room answered our `ping`: every edit sent before it arrived.
     * Call from the index message path on `pong`.
     */
    fun deliveryConfirmed() {
        val more = synchronized(barrierLock) {
            val covered = pingCovers ?: return
            covered.forEach { unconfirmed.remove(it)?.delivered?.complete(true) }
            pingCovers = null
            unconfirmed.isNotEmpty()
        }
        if (more) sendBarrier()
    }

    /** Re-publishes parked writes from current local state. Call after the channel reconnects. */
    suspend fun reconnect() {
        val parked = replay.values.toList()
        replay.clear()
        for (entry in parked) {
            val json = entry.rebuild?.invoke() ?: continue // The row is gone; nothing left to publish.
            val id = UUID.randomUUID().toString()
            pending[id] = entry
            dispatch(id, json, expectsResponse = false)
        }
    }

    /** Drops everything without reporting: the account changed and these belong to another identity. */
    fun cancel() {
        pending.values.forEach { it.timeout?.cancel(); it.delivered?.complete(false) }
        pending.clear()
        replay.clear()
        synchronized(barrierLock) {
            unconfirmed.values.forEach { it.delivered?.complete(false) }
            unconfirmed.clear()
            pingCovers = null
        }
    }

    private fun dispatch(id: String, json: String, expectsResponse: Boolean): Boolean {
        val entry = pending[id] ?: return false
        val accepted = sender(entry.channel, json)
        when {
            !accepted -> fail(id, SyncErrorKind.TRANSPORT, "the socket refused the frame")
            !expectsResponse -> {
                val proven = entry.rebuild != null || entry.delivered != null
                if (proven && entry.channel == SyncChannel.INDEX) awaitDelivery(id, entry)
                succeed(id)
            }
        }
        return accepted
    }

    private fun awaitDelivery(id: String, entry: Pending) {
        val key = entry.coalesceKey ?: id
        val needsPing = synchronized(barrierLock) {
            // Re-inserted at the tail: a newer send for the key is not covered
            // by a ping that went out before it.
            unconfirmed.remove(key)
            unconfirmed[key] = entry
            pingCovers?.let { pingCovers = it - key }
            pingCovers == null
        }
        if (needsPing) sendBarrier()
    }

    /** One ping at a time; its pong confirms what was unconfirmed when it left. */
    private fun sendBarrier() {
        val covers = synchronized(barrierLock) {
            if (pingCovers != null || unconfirmed.isEmpty()) return
            unconfirmed.keys.toSet().also { pingCovers = it }
        }
        if (!sender(SyncChannel.INDEX, PING)) {
            // The socket is going away; disconnect() parks what it covered.
            synchronized(barrierLock) { if (pingCovers === covers) pingCovers = null }
        }
    }

    private fun succeed(id: String) {
        val entry = finish(id) ?: return
        onOutcome?.invoke(SyncRequestOutcome(id, entry.kind, null))
    }

    private fun fail(id: String, kind: SyncErrorKind, detail: String, userMessage: String? = null) {
        val entry = finish(id) ?: return
        Log.w(TAG, "${entry.kind} failed ($kind): $detail")
        val retry: (() -> Unit)? = if (entry.rebuild != null) {
            // Without a key every offline edit would replay separately; keyed, the last one wins.
            replay[entry.coalesceKey ?: UUID.randomUUID().toString()] = entry
            { scope.launch { reconnect() } }
        } else {
            null
        }
        val error = SyncError(kind = kind, message = userMessage ?: entry.kind.failureDescription, retry = retry)
        if (entry.kind.isUserVisible) errors.report(error)
        onOutcome?.invoke(SyncRequestOutcome(id, entry.kind, error))
    }

    private fun finish(id: String): Pending? = pending.remove(id)?.also { it.timeout?.cancel() }

    companion object {
        const val TIMEOUT_MS = 30_000L
        private const val PING = """{"type":"ping"}"""
        private const val TAG = "SyncRequests"
    }
}
