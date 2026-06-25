package com.nimbalyst.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class ProviderBrandTest {
    @Test
    fun resolvesOpenAiFromProviderAndModelNames() {
        assertEquals(ProviderFamily.OpenAI, resolveProviderFamily("openai-codex-acp", null))
        assertEquals(ProviderFamily.OpenAI, resolveProviderFamily(null, "gpt-4o"))
        assertEquals(ProviderFamily.OpenAI, resolveProviderFamily(null, "o3"))
    }

    @Test
    fun resolvesAnthropicFromProviderAndModelNames() {
        assertEquals(ProviderFamily.Anthropic, resolveProviderFamily("anthropic", null))
        assertEquals(ProviderFamily.Anthropic, resolveProviderFamily(null, "claude-opus-4"))
    }

    @Test
    fun formatsProviderAndModelLabels() {
        assertEquals("OpenAI - gpt-4o", providerModelLabel("openai", "gpt_4o"))
        assertEquals("Anthropic - claude-opus-4", providerModelLabel("anthropic", "claude-opus-4"))
        assertEquals("Local Llm", providerModelLabel("local-llm", null))
    }
}
