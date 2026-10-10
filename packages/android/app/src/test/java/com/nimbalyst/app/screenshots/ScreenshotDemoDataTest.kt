package com.nimbalyst.app.screenshots

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import com.nimbalyst.app.ui.sessionlist.GroupKind
import com.nimbalyst.app.ui.sessionlist.SessionListFilter
import com.nimbalyst.app.ui.sessionlist.SessionListGrouping
import org.junit.Test

class ScreenshotDemoDataTest {
    private val now = 1_760_000_000_000L

    @Test
    fun `showcase session transcript uses the sync envelope the transcript expects`() {
        val messages = ScreenshotDemoData.messages(now)

        assertTrue("expected a multi-turn transcript", messages.size >= 5)
        messages.forEach { message ->
            assertEquals(ScreenshotDemoData.SHOWCASE_SESSION_ID, message.sessionId)

            val envelope = JsonParser.parseString(message.contentDecrypted).asJsonObject
            assertTrue("envelope is missing content", envelope.has("content"))
            assertTrue("envelope should carry a hidden flag", envelope.has("hidden"))

            // `content` is itself a JSON string the transcript parses a second time.
            val inner = JsonParser.parseString(envelope.get("content").asString).asJsonObject
            val isUserPrompt = inner.has("prompt")
            val isTypedBlock = inner.has("type")
            assertTrue("unrecognized transcript payload: $inner", isUserPrompt || isTypedBlock)
        }
    }

    @Test
    fun `every demo session belongs to a demo project and the showcase project is populated`() {
        val projectIds = ScreenshotDemoData.projects().map { it.id }.toSet()
        val sessions = ScreenshotDemoData.sessions(now)

        sessions.forEach { session ->
            assertTrue(
                "session ${session.id} points at unknown project ${session.projectId}",
                projectIds.contains(session.projectId)
            )
            assertNotNull("session ${session.id} needs a title", session.titleDecrypted)
        }

        val showcase = sessions.filter { it.projectId == ScreenshotDemoData.SHOWCASE_PROJECT_ID }
        assertTrue("showcase project needs a full-looking list", showcase.size >= 6)
        assertTrue(
            "at least one session should show the unread dot",
            showcase.any { it.lastReadAt == null }
        )
        assertTrue(
            "at least one session should show the running spinner",
            showcase.any { it.isExecuting }
        )
        assertTrue(
            "the transcript session must be in the list",
            showcase.any { it.id == ScreenshotDemoData.SHOWCASE_SESSION_ID }
        )
    }

    @Test
    fun `demo devices drive the green desktop-connected indicator`() {
        val devices = ScreenshotDemoData.connectedDevices(now)

        assertTrue(
            "ConnectionIndicator only goes green for a desktop/electron platform",
            devices.any { it.platform.equals("desktop", ignoreCase = true) }
        )
    }

    @Test
    fun `screen names map to targets and unknown names fall back to projects`() {
        assertEquals(ScreenshotScreen.SESSIONS, ScreenshotMode.resolveScreen("sessions"))
        assertEquals(ScreenshotScreen.DETAIL, ScreenshotMode.resolveScreen(" Detail "))
        assertEquals(ScreenshotScreen.COMPOSER, ScreenshotMode.resolveScreen("composer"))
        assertEquals(ScreenshotScreen.SETTINGS, ScreenshotMode.resolveScreen("settings"))
        assertEquals(ScreenshotScreen.PAIRING, ScreenshotMode.resolveScreen("pairing"))
        assertEquals(ScreenshotScreen.NEW_SESSION, ScreenshotMode.resolveScreen("newsession"))
        assertEquals(ScreenshotScreen.COMPUTERS, ScreenshotMode.resolveScreen("computers"))
        assertEquals(ScreenshotScreen.FILES, ScreenshotMode.resolveScreen("files"))
        assertEquals(ScreenshotScreen.DOCUMENT, ScreenshotMode.resolveScreen("document"))
        assertEquals(ScreenshotScreen.PROJECTS, ScreenshotMode.resolveScreen(null))
        assertEquals(ScreenshotScreen.PROJECTS, ScreenshotMode.resolveScreen("nope"))
    }

    @Test
    fun `the showcase list nests a meta agent, a workstream and a worktree`() {
        val groups = SessionListGrouping.buildGroups(
            ScreenshotDemoData.sessions(now).filter { it.projectId == ScreenshotDemoData.SHOWCASE_PROJECT_ID },
            SessionListFilter(metaAgentEnabled = true)
        )
        val orchestrator = groups.single { it.parent.id == ScreenshotDemoData.ORCHESTRATOR_ID }
        assertEquals(GroupKind.WORKSTREAM, orchestrator.kind)
        assertEquals(3, orchestrator.children.size)
        val workstream = groups.single { it.parent.id == ScreenshotDemoData.WORKSTREAM_ID }
        assertTrue(
            "the transcript session sits inside the workstream",
            workstream.children.any { it.id == ScreenshotDemoData.SHOWCASE_SESSION_ID }
        )
        assertEquals(2, groups.single { it.kind == GroupKind.WORKTREE }.children.size)
    }

    @Test
    fun `the expanded file tree folders and the showcase document exist`() {
        val docs = ScreenshotDemoData.documents()
        assertTrue(docs.any { it.relativePath == ScreenshotDemoData.SHOWCASE_DOCUMENT_PATH })
        assertEquals("sync ids must be unique", docs.size, docs.map { it.syncId }.toSet().size)
        // A folder with a single child would merge into "a/b" and change its expansion key.
        ScreenshotDemoData.EXPANDED_DOCUMENT_DIRS.forEach { dir ->
            assertTrue("$dir needs several files", docs.count { it.relativePath.startsWith("$dir/") } >= 2)
        }
        assertTrue(
            "the hosts give the computer picker an online and an offline machine",
            ScreenshotDemoData.connectedDevices(now).map { it.isOnline != false }.toSet().size == 2
        )
    }
}
