package com.nimbalyst.app.notifications

/**
 * The session the user is looking at right now, read by the FCM service to drop a
 * push for that session (iOS suppresses the banner the same way). Process-wide because
 * the messaging service has no path to the Compose tree; the UI writes it, nothing else.
 */
object VisibleSession {
    @Volatile
    var sessionId: String? = null
        private set

    @Volatile
    private var activityResumed: Boolean = false

    fun show(sessionId: String) {
        this.sessionId = sessionId
    }

    /** Clears only if [sessionId] is still the visible one, so a late dispose can't erase a newer screen. */
    fun hide(sessionId: String) {
        if (this.sessionId == sessionId) this.sessionId = null
    }

    fun setActivityResumed(resumed: Boolean) {
        activityResumed = resumed
    }

    fun shouldSuppress(messageSessionId: String?): Boolean =
        shouldSuppressNotification(messageSessionId, sessionId, activityResumed)
}

/**
 * A push is redundant only when its session is on screen in a resumed activity. A
 * backgrounded app, a different session, or a push with no session all still notify.
 */
internal fun shouldSuppressNotification(
    messageSessionId: String?,
    visibleSessionId: String?,
    activityResumed: Boolean,
): Boolean = activityResumed && messageSessionId != null && messageSessionId == visibleSessionId
