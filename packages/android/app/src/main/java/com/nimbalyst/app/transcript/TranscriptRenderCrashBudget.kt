package com.nimbalyst.app.transcript

/**
 * Bounds automatic transcript reloads after renderer deaths: at most
 * [maxReloads] within any [windowMs]. iOS resets its count on each successful
 * load, but the bundle acknowledges `loadSession` before projection and render,
 * so a transcript that crashes the renderer while rendering would ack, crash,
 * and reload forever. A sliding window stops that loop and still lets an
 * occasional background reclaim, minutes apart, reload silently.
 */
class TranscriptRenderCrashBudget(
    private val maxReloads: Int = 2,
    private val windowMs: Long = 120_000L,
) {
    private val crashes = ArrayDeque<Long>()

    /** Crashes inside the current window, for diagnostics. */
    val recentCrashes: Int get() = crashes.size

    /** Record a renderer death at [nowMs]. Returns whether to reload automatically. */
    fun recordCrash(nowMs: Long): Boolean {
        while (crashes.isNotEmpty() && nowMs - crashes.first() >= windowMs) {
            crashes.removeFirst()
        }
        crashes.addLast(nowMs)
        return crashes.size <= maxReloads
    }

    /** The user pressed Retry; they get a fresh budget. */
    fun reset() {
        crashes.clear()
    }
}
