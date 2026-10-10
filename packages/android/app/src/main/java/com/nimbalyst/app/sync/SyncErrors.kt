package com.nimbalyst.app.sync

import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What kind of sync failure the user is being told about. Mirrors iOS `SyncError.Kind`. */
enum class SyncErrorKind {
    /** The frame never reached the socket, or the socket went away first. */
    TRANSPORT,

    /** A payload arrived but could not be read with this device's key. */
    DECRYPT,

    /** The local database refused the write. */
    STORAGE,

    /** The received computer roster could not be decoded. */
    PRESENCE,

    /** We sent a request and the desktop never answered. */
    REQUEST_TIMEOUT;

    /**
     * What the banner says once more than one operation has failed the same
     * way inside the coalescing window. Naming one of them would be arbitrary.
     */
    val coalescedMessage: String
        get() = when (this) {
            TRANSPORT -> "Some changes are saved on this device and may not have reached your desktop. " +
                "They will be sent again when the connection returns."
            DECRYPT -> "Some messages could not be read with this device's key."
            STORAGE -> "Some changes could not be saved on this device."
            PRESENCE -> "The computer list could not be read. Waiting for a new list from sync."
            REQUEST_TIMEOUT -> "Your desktop has not answered. The requests may still have been applied."
        }
}

/**
 * A sync failure worth showing. [retry] is present only where re-driving the
 * work from current local state is meaningful. [id] stays the same while a
 * banner is updated in place, and changes for a new interruption.
 */
data class SyncError(
    val kind: SyncErrorKind,
    val message: String,
    val id: String = UUID.randomUUID().toString(),
    val retry: (() -> Unit)? = null,
)

/**
 * Collapses a burst of same-kind failures into one banner. The window is
 * measured from the first failure and is not refreshed by later ones, so a
 * steady stream of errors cannot pin one stale banner open. A different kind
 * replaces immediately. Port of iOS `SyncErrorCoalescer`.
 */
internal class SyncErrorCoalescer(
    private val windowMs: Long = 2_000L,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private var current: SyncError? = null
    private var openedAt: Long = 0L

    /** Returns what the banner should show, or null to leave it exactly as it is. */
    fun accept(incoming: SyncError): SyncError? {
        val now = clock()
        val open = current
        if (open == null || open.kind != incoming.kind || now - openedAt > windowMs) {
            current = incoming
            openedAt = now
            return incoming
        }
        val message = if (open.message == incoming.message) open.message else incoming.kind.coalescedMessage
        val retry = incoming.retry ?: open.retry
        if (message == open.message && (retry == null) == (open.retry == null)) return null
        return open.copy(message = message, retry = retry).also { current = it }
    }

    fun clear() {
        current = null
        openedAt = 0L
    }
}

/**
 * The single place a user-visible sync failure is published. Every failure
 * path goes through [report] so the coalescing rule cannot be bypassed.
 */
internal class SyncErrors(clock: () -> Long = System::currentTimeMillis) {
    private val coalescer = SyncErrorCoalescer(clock = clock)
    private val _current = MutableStateFlow<SyncError?>(null)
    val current: StateFlow<SyncError?> = _current.asStateFlow()

    fun report(kind: SyncErrorKind, message: String, retry: (() -> Unit)? = null) =
        report(SyncError(kind = kind, message = message, retry = retry))

    fun report(error: SyncError) {
        synchronized(this) {
            coalescer.accept(error)?.let { _current.value = it }
        }
    }

    fun clear() {
        synchronized(this) {
            _current.value = null
            coalescer.clear()
        }
    }

    /** Clears only when the open banner is of [kind], e.g. a fresh roster ends a presence error. */
    fun clear(kind: SyncErrorKind) {
        synchronized(this) {
            if (_current.value?.kind == kind) {
                _current.value = null
                coalescer.clear()
            }
        }
    }
}
