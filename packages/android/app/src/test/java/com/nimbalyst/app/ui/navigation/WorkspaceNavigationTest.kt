package com.nimbalyst.app.ui.navigation

import androidx.lifecycle.SavedStateHandle
import com.nimbalyst.app.notifications.shouldSuppressNotification
import com.nimbalyst.app.pairing.PairingCredentials
import com.nimbalyst.app.pairing.QRPairingData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import com.nimbalyst.app.sync.DeviceInfo
import com.nimbalyst.app.sync.SessionCreationOutcome
import com.nimbalyst.app.sync.SyncErrorKind
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain

class WorkspaceNavigationTest {

    @Test
    fun `selection survives recreation from saved state`() {
        val saved = SavedStateHandle()
        WorkspaceNavigation(saved).apply {
            chooseProject("p1")
            select("s1")
        }
        val restored = WorkspaceNavigation(saved).state.value
        assertEquals("p1", restored.projectId)
        assertEquals("s1", restored.sessionId)
    }

    @Test
    fun `back pops detail on a phone but goes straight to projects when side by side`() {
        val phone = WorkspaceNavigation(SavedStateHandle()).apply { chooseProject("p"); select("s") }
        assertTrue(phone.navigateBack(isWide = false))
        assertEquals("p", phone.state.value.projectId)
        assertNull(phone.state.value.sessionId)
        assertTrue(phone.navigateBack(isWide = false))
        assertFalse(phone.navigateBack(isWide = false))

        val tablet = WorkspaceNavigation(SavedStateHandle()).apply { chooseProject("p"); select("s") }
        assertTrue(tablet.navigateBack(isWide = true))
        assertNull(tablet.state.value.projectId)
        assertNull(tablet.state.value.sessionId)
    }

    @Test
    fun `a late-resolving notification session moves the sidebar only if still selected`() {
        val nav = WorkspaceNavigation(SavedStateHandle())
        nav.openSession("pushed")
        nav.adoptResolvedSession("pushed", "project-a")
        assertEquals("project-a", nav.state.value.projectId)

        nav.select("other")
        nav.adoptResolvedSession("pushed", "project-b")
        assertEquals("project-a", nav.state.value.projectId)
    }

    @Test
    fun `desktop history stays listed while the roster is empty or the process restarts`() {
        fun device(id: String, type: String) =
            DeviceInfo(deviceId = id, name = id, type = type, platform = "test", connectedAt = 0, lastActiveAt = 0)
        val saved = SavedStateHandle()
        val nav = WorkspaceNavigation(saved).apply {
            rememberHosts(listOf(device("mac", "desktop"), device("vm", "headless")))
            adoptDefaultHost("mac")
        }
        assertTrue(nav.state.value.includesUnattributedSessions)
        // Reconnecting after foreground reports no devices until the roster arrives.
        nav.rememberHosts(emptyList())
        assertTrue(nav.state.value.includesUnattributedSessions)
        assertTrue(WorkspaceNavigation(saved).state.value.includesUnattributedSessions)

        nav.chooseHost("vm")
        assertFalse("headless hosts own only their own sessions", nav.state.value.includesUnattributedSessions)
        nav.clearAccount()
        nav.chooseHost("mac")
        assertFalse("another account's roster does not carry over", nav.state.value.includesUnattributedSessions)
    }

    @Test
    fun `clearing the account keeps a pending sign-in error`() {
        val nav = WorkspaceNavigation(SavedStateHandle()).apply {
            chooseProject("p")
            reportAuthCallbackFailure("Wrong account.")
            clearAccount()
        }
        assertNull(nav.state.value.projectId)
        assertEquals("Wrong account.", nav.state.value.authCallbackFailure)
    }

    @Test
    fun `scanned pairing keeps the sign-in only for the same account`() {
        val existing = PairingCredentials(
            serverUrl = "wss://sync", encryptionSeed = "old", pairedUserId = "me@x.com",
            authJwt = "jwt", authUserId = "u1"
        )
        val same = credentialsForScannedPairing(existing, QRPairingData(seed = "new", serverUrl = "wss://sync", userId = "me@x.com"))
        assertEquals("new", same.encryptionSeed)
        assertEquals("jwt", same.authJwt)

        val other = credentialsForScannedPairing(existing, QRPairingData(seed = "s", serverUrl = "wss://sync", userId = "you@x.com"))
        assertNull(other.authJwt)
        assertEquals("you@x.com", other.pairedUserId)
    }

    @Test
    fun `a push is dropped only for the session on screen in a resumed app`() {
        assertTrue(shouldSuppressNotification("s1", visibleSessionId = "s1", activityResumed = true))
        assertFalse(shouldSuppressNotification("s1", visibleSessionId = "s1", activityResumed = false))
        assertFalse(shouldSuppressNotification("s2", visibleSessionId = "s1", activityResumed = true))
        assertFalse(shouldSuppressNotification(null, visibleSessionId = null, activityResumed = true))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun `a create request opens the new session, or raises the alert when it fails`() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        try {
            val nav = WorkspaceNavigation(SavedStateHandle())
            val answer = CompletableDeferred<SessionCreationOutcome>()
            var created: String? = null
            nav.trackCreation("r1", await = { answer.await() }, onCreated = { created = it })
            assertEquals(setOf("r1"), nav.state.value.pendingCreations)

            answer.complete(SessionCreationOutcome.Created("r1", "new-session"))
            assertTrue(nav.state.value.pendingCreations.isEmpty())
            assertEquals("new-session", nav.state.value.sessionId)
            assertEquals("new-session", created)

            nav.trackCreation("r2", navigate = false, await = { SessionCreationOutcome.Failed("r2", "Desktop refused.") })
            assertEquals("Desktop refused.", nav.state.value.creationFailure)
            assertEquals("new-session", nav.state.value.sessionId)
        } finally {
            Dispatchers.resetMain()
        }
    }

    @Test
    fun `only failures that may have landed are shown as caution`() {
        assertEquals(SyncErrorSeverity.CAUTION, syncErrorSeverity(SyncErrorKind.TRANSPORT))
        assertEquals(SyncErrorSeverity.CAUTION, syncErrorSeverity(SyncErrorKind.REQUEST_TIMEOUT))
        assertEquals(SyncErrorSeverity.FAILURE, syncErrorSeverity(SyncErrorKind.STORAGE))
    }

    @Test
    fun `a document and a session never share the detail pane, and back closes either`() {
        val saved = SavedStateHandle()
        val nav = WorkspaceNavigation(saved).apply { chooseProject("p"); select("s") }
        nav.openDocument("docs/plan.md")
        assertNull(nav.state.value.sessionId)
        assertEquals("docs/plan.md", WorkspaceNavigation(saved).state.value.documentPath)

        nav.openSession("s2")
        assertNull(nav.state.value.documentPath)

        nav.openDocument("readme.md")
        assertTrue(nav.navigateBack(isWide = false))
        assertEquals("p", nav.state.value.projectId)
        assertTrue(!nav.state.value.hasSelection)
    }

    @Test
    fun `the app-level save banner stands down while any document surface is on screen`() {
        // Wide layout: the file list and the editor are on screen together.
        DocumentSurfaces.enter()
        DocumentSurfaces.enter()
        DocumentSurfaces.exit()
        assertTrue("the list is still showing its own banner", DocumentSurfaces.isVisible)
        DocumentSurfaces.exit()
        DocumentSurfaces.exit()
        assertFalse(DocumentSurfaces.isVisible)
        assertTrue("the shell keeps watching after the surfaces close", DocumentSurfaces.everShown)
    }
}
