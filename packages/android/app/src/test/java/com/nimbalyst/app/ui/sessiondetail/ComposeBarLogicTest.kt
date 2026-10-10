package com.nimbalyst.app.ui.sessiondetail

import com.nimbalyst.app.data.SessionEntity
import com.nimbalyst.app.sync.SyncedActionPrompt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComposeBarLogicTest {
    private val commands = listOf(
        SlashCommand("review", "Review a change", "user"),
        SlashCommand("commit", "Commit", "project"),
        SlashCommand("precommit", null, "project"),
        SlashCommand("compact", null, "builtin"),
        SlashCommand("mystery", null, "unknown-source"),
    )

    @Test
    fun `slash query is the text after a leading slash until whitespace`() {
        assertEquals("", SlashCommandFilter.slashQuery("/"))
        assertEquals("com", SlashCommandFilter.slashQuery("  /com"))
        assertNull(SlashCommandFilter.slashQuery("/commit now"))
        assertNull(SlashCommandFilter.slashQuery("hello /commit"))
    }

    @Test
    fun `prefix matches rank above substring matches, grouped project-builtin-user-plugin`() {
        val groups = SlashCommandFilter.filter(commands, "COM")
        assertEquals(listOf("project", "builtin"), groups.map { it.source })
        assertEquals(listOf("commit", "precommit"), groups[0].commands.map { it.name })
        assertEquals(listOf("compact"), groups[1].commands.map { it.name })
    }

    @Test
    fun `empty query lists every command, unknown sources after the known groups`() {
        val groups = SlashCommandFilter.filter(commands, "")
        assertEquals(listOf("project", "builtin", "user", "unknown-source"), groups.map { it.source })
        assertEquals(5, groups.sumOf { it.commands.size })
    }

    @Test
    fun `project config decoding drops malformed entries and worktree launchers`() {
        val decoded = ProjectConfig.commands(
            """[{"name":"commit","source":"project"},{"description":"no name"},{"name":"bare"}]"""
        )
        assertEquals(listOf("commit", "bare"), decoded.map { it.name })
        assertEquals("", decoded[1].source)
        assertEquals(emptyList<SlashCommand>(), ProjectConfig.commands("not json"))

        val actions = ProjectConfig.mobileActions(
            """[{"id":"a","label":"Review","body":"Review it"},
                {"id":"b","label":"Worktree","body":"x","launch":"new-session","worktree":true},
                {"id":"c","label":"No body"}]"""
        )
        assertEquals(listOf("a"), actions.map { it.id })
    }

    @Test
    fun `launcher action becomes a sibling session on the same host, held as a draft when not auto-submitted`() {
        val session = SessionEntity(
            id = "s1", projectId = "/p", parentSessionId = "ws", hostDeviceId = "mac-1", createdAt = 0, updatedAt = 0
        )
        val action = SyncedActionPrompt(
            id = "a", label = "Plan", body = "Write a plan", launch = "new-session", model = "claude-code:opus", autoSubmit = false
        )

        val options = ProjectConfig.launchOptions(action, session)

        assertEquals("/p", options.projectId)
        assertEquals("ws", options.parentSessionId)
        assertEquals("mac-1", options.targetDeviceId)
        assertEquals("claude-code", options.provider)
        assertNull(options.initialPrompt)
        assertEquals("Write a plan", options.initialDraft)
        assertEquals("Write a plan", ProjectConfig.launchOptions(action.copy(autoSubmit = null), session).initialPrompt)
    }

    @Test
    fun `picking a command leaves room for arguments`() {
        assertEquals("/commit ", SlashCommandFilter.completion(commands[1]))
    }

    @Test
    fun `trailing button is Send when idle, Queue with text while running, Stop when empty`() {
        assertEquals(ComposeAction.Send, composeAction(isExecuting = false, canSend = false))
        assertEquals(ComposeAction.Send, composeAction(isExecuting = false, canSend = true))
        assertEquals(ComposeAction.Queue, composeAction(isExecuting = true, canSend = true))
        assertEquals(ComposeAction.Stop, composeAction(isExecuting = true, canSend = false))
    }
}
