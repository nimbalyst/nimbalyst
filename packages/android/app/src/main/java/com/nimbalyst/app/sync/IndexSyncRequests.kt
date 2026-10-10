package com.nimbalyst.app.sync

import com.google.gson.Gson

/**
 * Outbound index sync requests, and the one-in-flight rule for lookups. The
 * legacy protocol cannot ask for a single row, so a lookup for a session that
 * has not synced yet is a full index sync. A navigation poller must not
 * restart the whole index on every tick, so a lookup while a sync is already
 * in flight is folded into it.
 */
internal class IndexSyncRequests(
    private val gson: Gson,
    private val send: (String) -> Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    @Volatile private var inFlightSince: Long? = null

    /** Sends a full index sync request. Returns false when the socket refused it. */
    fun requestFull(): Boolean {
        inFlightSince = clock()
        return send(gson.toJson(IndexSyncRequest())).also { sent -> if (!sent) inFlightSince = null }
    }

    /** Asks for [sessionId]'s row. Returns true when a request is (or already was) on its way. */
    @Suppress("UNUSED_PARAMETER")
    fun lookup(sessionId: String): Boolean {
        val since = inFlightSince
        if (since != null && clock() - since < STALE_AFTER_MS) return true
        return requestFull()
    }

    fun responseReceived() {
        inFlightSince = null
    }

    fun reset() {
        inFlightSince = null
    }

    private companion object {
        /** A request this old lost its response (e.g. the socket dropped); send again. */
        const val STALE_AFTER_MS = 30_000L
    }
}
