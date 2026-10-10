package com.nimbalyst.app.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BadgeLogicTest {
    @Test
    fun `model labels match the iOS ModelLabel tables`() {
        val cases = listOf(
            Triple("claude-code", "claude-code:opus-1m", "Opus 5.5"),
            Triple("claude-code", "claude-opus-4-7", "Opus 4.7"),
            Triple("claude-code", "opus-4-6", "Opus 4.6"),
            Triple("claude-code", "claude-opus-5", "Opus 5"),
            Triple("claude-code", null, "Claude Agent"),
            Triple("claude-code", "mystery", "Claude Agent"),
            Triple("claude-code-cli", "sonnet", "Sonnet 5.5"),
            Triple("claude-code-cli", null, "Claude Code CLI"),
            Triple("claude", "claude-sonnet-4-5-20250929", "Sonnet 4.5"),
            Triple("claude", "claude-haiku-4-5", "Haiku 4.5"),
            Triple("claude", "claude-haiku-5-5", "Haiku 5.5"),
            Triple("claude-code", "haiku", "Haiku 5.5"),
            Triple("claude-code", "haiku-4-5", "Haiku 4.5"),
            Triple("claude", "something-else", "Claude"),
            Triple("openai", "openai:gpt-5.4", "GPT-5.4"),
            Triple("openai", "gpt-5-turbo", "GPT-5 Turbo"),
            Triple("openai", "o3", "OpenAI"),
            Triple("openai-codex", "gpt-5.6-sol", "Codex GPT-5.6 Sol"),
            Triple("openai-codex", "", "Codex"),
            Triple("LM-Studio", "whatever", "Local"),
        )
        for ((provider, model, expected) in cases) {
            assertEquals("$provider / $model", expected, ModelLabel.shortLabel(provider, model))
        }
        assertNull(ModelLabel.shortLabel("unknown-provider", "opus"))
        assertNull(ModelLabel.shortLabel(null, null))
    }

    @Test
    fun `context usage thresholds are 70 warning and 90 critical`() {
        assertEquals(ContextUsageLevel.NORMAL, ContextUsageLevel.forPercent(69))
        assertEquals(ContextUsageLevel.WARNING, ContextUsageLevel.forPercent(70))
        assertEquals(ContextUsageLevel.WARNING, ContextUsageLevel.forPercent(89))
        assertEquals(ContextUsageLevel.CRITICAL, ContextUsageLevel.forPercent(90))
        assertEquals(1f, contextUsageFraction(140))
        assertEquals(0f, contextUsageFraction(-5))
    }
}
