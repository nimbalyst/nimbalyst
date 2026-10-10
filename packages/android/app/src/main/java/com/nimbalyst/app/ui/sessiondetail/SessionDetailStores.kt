package com.nimbalyst.app.ui.sessiondetail

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import com.nimbalyst.app.attachments.StoredAttachment

/**
 * Activity-scoped owner of per-session state, split by weight:
 *
 * - Each session's [SessionDetailViewModel] (Room collectors, delivery
 *   observers, decoded attachment bitmaps) lives in its own [ViewModelStore].
 *   Only the [MAX_LIVE_SESSIONS] most recently shown are kept, so going back
 *   to a session just left, or a send still in flight, survives; older ones
 *   are cleared.
 * - Compose state (text, attachment file references, draft timestamps) is a
 *   few strings per session in this holder's [SavedStateHandle], so it outlives
 *   the ViewModel and process death. Entries without attachments are pruned
 *   past [MAX_SAVED_COMPOSE]; the text is also synced as the session draft.
 *
 * [clearAll] drops both on an account change.
 */
class SessionDetailStores(private val saved: SavedStateHandle) : ViewModel() {
    private val stores = LinkedHashMap<String, ViewModelStore>(8, 0.75f, true)

    /** The store for [sessionId], marking it most recently shown and clearing any past the bound. */
    fun owner(sessionId: String): ViewModelStoreOwner {
        val store = stores.getOrPut(sessionId) { ViewModelStore() }
        while (stores.size > MAX_LIVE_SESSIONS) {
            val eldest = stores.entries.first()
            stores.remove(eldest.key)
            eldest.value.clear()
        }
        return object : ViewModelStoreOwner {
            override val viewModelStore: ViewModelStore = store
        }
    }

    /** Session ids whose ViewModel is still alive, least recent first. */
    val liveSessionIds: List<String> get() = stores.keys.toList()

    fun composeState(sessionId: String): SessionComposeState {
        val order = savedSessions().apply {
            remove(sessionId)
            add(sessionId)
        }
        var excess = order.size - MAX_SAVED_COMPOSE
        val iterator = order.iterator()
        while (excess > 0 && iterator.hasNext()) {
            val candidate = iterator.next()
            if (candidate == sessionId || candidate in stores) continue
            val state = SessionComposeState(saved, prefix(candidate))
            if (state.attachments.isNotEmpty()) continue
            state.clear()
            iterator.remove()
            excess--
        }
        saved[KEY_SESSIONS] = order
        return SessionComposeState(saved, prefix(sessionId))
    }

    /**
     * Account changed: clear every live ViewModel and forget every draft.
     * Returns the attachment references that were pending so the caller can
     * delete their files.
     */
    fun clearAll(): List<StoredAttachment> {
        stores.values.forEach(ViewModelStore::clear)
        stores.clear()
        val sessions = savedSessions()
        val attachments = sessions.flatMap { id ->
            SessionComposeState(saved, prefix(id)).let { state -> state.attachments.also { state.clear() } }
        }
        saved[KEY_SESSIONS] = ArrayList<String>()
        return attachments
    }

    override fun onCleared() {
        stores.values.forEach(ViewModelStore::clear)
        stores.clear()
    }

    private fun savedSessions(): ArrayList<String> = ArrayList(saved.get<ArrayList<String>>(KEY_SESSIONS).orEmpty())

    private fun prefix(sessionId: String) = "session:$sessionId:"

    companion object {
        const val MAX_LIVE_SESSIONS = 3
        const val MAX_SAVED_COMPOSE = 20
        private const val KEY_SESSIONS = "sessionDetail.sessions"
    }
}
