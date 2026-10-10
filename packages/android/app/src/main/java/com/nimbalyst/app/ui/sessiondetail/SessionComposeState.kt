package com.nimbalyst.app.ui.sessiondetail

import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.SavedStateHandle
import com.nimbalyst.app.attachments.StoredAttachment
import com.nimbalyst.app.ui.shouldApplyRemoteDraft

/**
 * Per-session compose state, the Android counterpart of iOS
 * `SessionComposeState`. Everything that must survive rotation and process
 * death lives in [handle]: the text, the on-disk attachment references, the
 * draft timestamps, and an in-flight camera capture target.
 *
 * [text] is snapshot state rather than a flow so the field reads each
 * keystroke back synchronously; a collected flow lags a frame and would reset
 * the cursor or drop characters typed in between.
 */
class SessionComposeState(
    private val handle: SavedStateHandle,
    /** Namespaces the keys when one handle holds several sessions (see [SessionDetailStores]). */
    private val prefix: String = "",
) {
    private val textState = mutableStateOf(handle.get<String>(prefix + KEY_TEXT).orEmpty())
    val text: String get() = textState.value

    var attachments: List<StoredAttachment>
        get() = decodeAttachments(handle.get<ArrayList<String>>(prefix + KEY_ATTACHMENTS))
        set(value) {
            handle[prefix + KEY_ATTACHMENTS] = encodeAttachments(value)
        }

    var lastSubmitAt: Long
        get() = handle[prefix + KEY_LAST_SUBMIT] ?: 0L
        set(value) {
            handle[prefix + KEY_LAST_SUBMIT] = value
        }

    var lastLocalEditAt: Long
        get() = handle[prefix + KEY_LAST_LOCAL_EDIT] ?: 0L
        set(value) {
            handle[prefix + KEY_LAST_LOCAL_EDIT] = value
        }

    /** The file a camera capture is writing to; the camera app may outlive this process. */
    var pendingCameraPath: String?
        get() = handle[prefix + KEY_CAMERA_PATH]
        set(value) {
            handle[prefix + KEY_CAMERA_PATH] = value
        }

    /** A user edit. Returns false when the text did not change. */
    fun edit(newText: String, now: Long): Boolean {
        if (newText == text) return false
        setText(newText)
        lastLocalEditAt = now
        return true
    }

    /** Replace the text without marking a local edit (send, remote draft). */
    fun setText(newText: String) {
        textState.value = newText
        handle[prefix + KEY_TEXT] = newText
    }

    /**
     * Put a failed send back ahead of anything typed since. This is a local
     * edit: the submit already synced an empty draft, which must not win on
     * blur. The caller persists the returned text as the new draft.
     */
    fun restoreFailedSend(promptText: String, now: Long): String {
        val current = text
        val restored = if (current.isBlank()) promptText else "$promptText\n$current"
        setText(restored)
        lastLocalEditAt = now
        return restored
    }

    /**
     * Apply a synced draft under the existing [shouldApplyRemoteDraft] rules.
     * Call only while the field is unfocused; replacing focused text disrupts
     * IME composition. Returns true when the text changed.
     */
    fun applyRemoteDraft(draft: String?, updatedAt: Long?): Boolean {
        val remote = draft ?: return false
        if (!shouldApplyRemoteDraft(text, remote, updatedAt, lastSubmitAt, lastLocalEditAt)) return false
        setText(remote)
        return true
    }

    /** Forget everything saved for this session. */
    fun clear() {
        textState.value = ""
        ALL_KEYS.forEach { handle.remove<Any>(prefix + it) }
    }

    companion object {
        private const val KEY_TEXT = "compose.text"
        private const val KEY_ATTACHMENTS = "compose.attachments"
        private const val KEY_LAST_SUBMIT = "compose.lastSubmitAt"
        private const val KEY_LAST_LOCAL_EDIT = "compose.lastLocalEditAt"
        private const val KEY_CAMERA_PATH = "compose.cameraPath"
        private val ALL_KEYS = listOf(KEY_TEXT, KEY_ATTACHMENTS, KEY_LAST_SUBMIT, KEY_LAST_LOCAL_EDIT, KEY_CAMERA_PATH)
        private const val FIELD_SEPARATOR = '\u001F'

        internal fun encodeAttachments(list: List<StoredAttachment>): ArrayList<String> =
            list.mapTo(ArrayList()) { listOf(it.id, it.filename, it.path).joinToString(FIELD_SEPARATOR.toString()) }

        internal fun decodeAttachments(raw: List<String>?): List<StoredAttachment> =
            raw.orEmpty().mapNotNull { entry ->
                val parts = entry.split(FIELD_SEPARATOR)
                if (parts.size == 3) StoredAttachment(parts[0], parts[1], parts[2]) else null
            }
    }
}
