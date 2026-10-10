package com.nimbalyst.app.ui.navigation

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.nimbalyst.app.sync.DeviceInfo
import com.nimbalyst.app.sync.SessionCreationOutcome
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Where the user is in the app, owned above the layout so rotation or a width change
 * never loses it. Mirrors iOS `WorkspaceNavigationState`: one project, one selected
 * session, one chosen computer. The Activity holds this, and deep links write to it.
 */
class WorkspaceNavigation(private val saved: SavedStateHandle) : ViewModel() {

    data class State(
        val projectId: String? = null,
        /** At most one of [sessionId] and [documentPath] is set (iOS `WorkspaceSelection`). */
        val sessionId: String? = null,
        /** A project file open in the detail pane, relative to the project root. */
        val documentPath: String? = null,
        /** The machine whose sessions the list shows; null until one is known. */
        val hostDeviceId: String? = null,
        val showSettings: Boolean = false,
        /** An external `nimbalyst://pair` link asked for the in-app scanner. */
        val scannerRequested: Boolean = false,
        /** Why the last `nimbalyst://auth/callback` failed, shown on the sign-in screen. */
        val authCallbackFailure: String? = null,
        /** Create requests this device is still waiting on; the "+" button shows progress. */
        val pendingCreations: Set<String> = emptySet(),
        /** Why the last create failed, shown as an alert until dismissed. */
        val creationFailure: String? = null,
        /** Outlives the live roster, which is empty from foreground until the socket reconnects. */
        val knownDesktopIds: Set<String> = emptySet(),
    ) {
        val hasSelection: Boolean get() = sessionId != null || documentPath != null

        /** Desktop-created sessions carry no host and are listed under a desktop. */
        val includesUnattributedSessions: Boolean get() = hostDeviceId != null && hostDeviceId in knownDesktopIds
    }

    private val _state = MutableStateFlow(
        State(
            projectId = saved[KEY_PROJECT],
            sessionId = saved[KEY_SESSION],
            documentPath = saved[KEY_DOCUMENT],
            hostDeviceId = saved[KEY_HOST],
            showSettings = saved[KEY_SETTINGS] ?: false,
            knownDesktopIds = saved.get<ArrayList<String>>(KEY_DESKTOPS)?.toSet() ?: emptySet(),
        )
    )
    val state: StateFlow<State> = _state.asStateFlow()

    fun chooseProject(projectId: String?) = mutate { it.copy(projectId = projectId, sessionId = null, documentPath = null) }

    fun select(sessionId: String?) = mutate { it.copy(sessionId = sessionId, documentPath = null) }

    fun openDocument(relativePath: String) = mutate { it.copy(documentPath = relativePath, sessionId = null) }

    /** Drop whatever the detail pane shows (e.g. switching between Sessions and Files). */
    fun clearSelection() = mutate { it.copy(sessionId = null, documentPath = null) }

    /**
     * Open a session named by a notification or a newly created session. The session may
     * not have synced yet; the detail pane waits for it (see [PendingSessionScreen]).
     */
    fun openSession(sessionId: String) = mutate { it.copy(sessionId = sessionId, documentPath = null, showSettings = false) }

    /** A session resolved after [openSession]: align the sidebar with it unless the user moved on. */
    fun adoptResolvedSession(sessionId: String, projectId: String) = mutate {
        if (it.sessionId == sessionId && it.projectId != projectId) it.copy(projectId = projectId) else it
    }

    fun chooseHost(hostDeviceId: String?) = mutate { it.copy(hostDeviceId = hostDeviceId, sessionId = null, documentPath = null) }

    /** Record which hosts are desktops; an empty roster is not evidence that one went away. */
    fun rememberHosts(devices: List<DeviceInfo>) {
        val current = _state.value.knownDesktopIds
        val next = current + devices.filter { it.type == "desktop" }.map { it.deviceId } -
            devices.filter { it.type != "desktop" }.map { it.deviceId }.toSet()
        if (next != current) mutate { it.copy(knownDesktopIds = next) }
    }

    /** Adopt a default computer once, without overriding the user's choice. */
    fun adoptDefaultHost(deviceId: String?) {
        if (_state.value.hostDeviceId != null || deviceId == null) return
        mutate { it.copy(hostDeviceId = deviceId) }
    }

    /**
     * Wait for a create request here rather than in the list, so leaving the list or
     * rotating does not drop the result. [Created] runs [onCreated] and, when
     * [navigate] is set, opens the new session; [Failed] raises the alert. Never retries.
     */
    fun trackCreation(
        requestId: String,
        navigate: Boolean = true,
        await: suspend (String) -> SessionCreationOutcome,
        onCreated: suspend (sessionId: String) -> Unit = {},
    ) {
        _state.update { it.copy(pendingCreations = it.pendingCreations + requestId) }
        viewModelScope.launch {
            val outcome = await(requestId)
            _state.update { it.copy(pendingCreations = it.pendingCreations - requestId) }
            when (outcome) {
                is SessionCreationOutcome.Created -> {
                    onCreated(outcome.sessionId)
                    if (navigate) openSession(outcome.sessionId)
                }
                is SessionCreationOutcome.Failed -> reportCreationFailure(outcome.message)
            }
        }
    }

    fun reportCreationFailure(message: String?) = _state.update { it.copy(creationFailure = message) }

    fun showSettings(show: Boolean) = mutate { it.copy(showSettings = show) }

    fun requestScanner() = mutate { it.copy(scannerRequested = true, showSettings = false) }

    fun consumeScannerRequest() = mutate { it.copy(scannerRequested = false) }

    fun reportAuthCallbackFailure(reason: String?) = mutate { it.copy(authCallbackFailure = reason) }

    /** Account changed (sign-out, unpair, deletion): nothing selected belongs to it any more. */
    fun clearAccount() = mutate { State(authCallbackFailure = it.authCallbackFailure) }

    /**
     * Back from the phone layout: detail -> list -> projects. Returns false when there is
     * nothing left to pop so the system can finish the activity.
     */
    fun navigateBack(isWide: Boolean): Boolean {
        val current = _state.value
        when {
            current.showSettings -> showSettings(false)
            current.hasSelection && !isWide -> clearSelection()
            current.projectId != null -> chooseProject(null)
            else -> return false
        }
        return true
    }

    private inline fun mutate(transform: (State) -> State) {
        _state.update(transform)
        val next = _state.value
        saved[KEY_PROJECT] = next.projectId
        saved[KEY_SESSION] = next.sessionId
        saved[KEY_DOCUMENT] = next.documentPath
        saved[KEY_HOST] = next.hostDeviceId
        saved[KEY_SETTINGS] = next.showSettings
        saved[KEY_DESKTOPS] = ArrayList(next.knownDesktopIds)
    }

    private companion object {
        const val KEY_PROJECT = "projectId"
        const val KEY_SESSION = "sessionId"
        const val KEY_DOCUMENT = "documentPath"
        const val KEY_HOST = "hostDeviceId"
        const val KEY_SETTINGS = "showSettings"
        const val KEY_DESKTOPS = "knownDesktopIds"
    }
}

/** Width at which the list and the session sit side by side, matching iOS. */
const val WIDE_LAYOUT_MIN_WIDTH_DP = 700
