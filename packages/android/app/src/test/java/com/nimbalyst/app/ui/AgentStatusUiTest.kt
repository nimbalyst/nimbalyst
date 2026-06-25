package com.nimbalyst.app.ui

import com.nimbalyst.app.data.SessionEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentStatusUiTest {
    @Test
    fun freshThinkingStatusIsDisplayed() {
        val session = session(
            isExecuting = true,
            agentStatusKind = "thinking",
            agentStatusLabel = "Thinking...",
            agentStatusUpdatedAt = 2_000L,
            updatedAt = 2_000L
        )

        assertTrue(session.effectiveIsExecuting(now = 3_000L))
        assertEquals("Thinking...", session.agentStatusDisplayLabel(now = 3_000L))
    }

    @Test
    fun staleThinkingStatusIsHidden() {
        val session = session(
            isExecuting = true,
            agentStatusKind = "thinking",
            agentStatusLabel = "Thinking...",
            agentStatusUpdatedAt = 1_000L,
            updatedAt = 1_000L
        )
        val now = 1_000L + 6L * 60L * 1_000L

        assertFalse(session.effectiveIsExecuting(now = now))
        assertNull(session.agentStatusDisplayLabel(now = now))
    }

    @Test
    fun queuedPromptDisplaySurvivesStatusExpiry() {
        val session = session(
            isExecuting = false,
            agentStatusKind = null,
            hasQueuedPrompts = true,
            updatedAt = 1_000L
        )

        assertEquals("Prompt queued on desktop", session.agentStatusDisplayLabel(now = 99_000L))
    }

    private fun session(
        isExecuting: Boolean = false,
        agentStatusKind: String? = null,
        agentStatusLabel: String? = null,
        agentStatusDetail: String? = null,
        agentStatusUpdatedAt: Long? = null,
        hasQueuedPrompts: Boolean = false,
        updatedAt: Long = 1_000L
    ) = SessionEntity(
        id = "session-1",
        projectId = "/tmp/project",
        isExecuting = isExecuting,
        agentStatusKind = agentStatusKind,
        agentStatusLabel = agentStatusLabel,
        agentStatusDetail = agentStatusDetail,
        agentStatusUpdatedAt = agentStatusUpdatedAt,
        hasQueuedPrompts = hasQueuedPrompts,
        createdAt = 1_000L,
        updatedAt = updatedAt
    )
}
