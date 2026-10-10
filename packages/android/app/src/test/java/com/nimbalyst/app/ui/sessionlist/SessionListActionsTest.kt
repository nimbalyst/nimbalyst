package com.nimbalyst.app.ui.sessionlist

import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.sync.SyncedAvailableModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionListActionsTest {

    private val models = listOf(
        SyncedAvailableModel("claude-code:opus", "Opus", "claude-code"),
        SyncedAvailableModel("openai-codex:gpt", "GPT", "openai-codex"),
    )

    @Test
    fun `model choice prefers last used, then the desktop default, then the first offered`() {
        assertEquals("openai-codex:gpt", resolveModel(models, lastUsed = "openai-codex:gpt", desktopDefault = "claude-code:opus"))
        assertEquals("claude-code:opus", resolveModel(models, lastUsed = "gone:model", desktopDefault = "claude-code:opus"))
        assertEquals("claude-code:opus", resolveModel(models, lastUsed = null, desktopDefault = "gone:model"))
        assertNull(resolveModel(emptyList(), lastUsed = null, desktopDefault = "claude-code:opus"))
    }

    @Test
    fun `create options carry the kind, model provider and chosen machine`() {
        val meta = creationOptions(CreateKind.META_AGENT, "p", "claude-code:opus", targetDeviceId = "desk")
        assertEquals("meta-agent", meta.agentRole)
        assertNull(meta.sessionType)
        assertEquals("claude-code", meta.provider)
        assertEquals("desk", meta.targetDeviceId)

        val ws = creationOptions(CreateKind.WORKSTREAM, "p", null, targetDeviceId = null)
        assertEquals("workstream", ws.sessionType)
        assertNull(ws.provider)
    }

    @Test
    fun `long-press actions follow the row kind and group actions cover every member`() {
        fun s(id: String, archived: Boolean = false, worktreeId: String? = null) =
            SessionEntity(id = id, projectId = "p", isArchived = archived, worktreeId = worktreeId, createdAt = 0, updatedAt = 0)
        val filter = SessionListFilter(includeArchived = true)

        val standalone = SessionListGrouping.buildGroups(listOf(s("a", archived = true)), filter).single()
        assertEquals(
            listOf(RowAction.START_WORKSTREAM, RowAction.UNARCHIVE, RowAction.DELETE),
            rowActions(standalone, hasWorkstreams = false)
        )

        val worktree = SessionListGrouping.buildGroups(listOf(s("w1", worktreeId = "wt"), s("w2", worktreeId = "wt")), filter).single()
        assertEquals(listOf(RowAction.ARCHIVE, RowAction.DELETE), rowActions(worktree, hasWorkstreams = true))
        assertEquals(setOf("w1", "w2"), actionTargets(worktree).toSet())
    }
}
