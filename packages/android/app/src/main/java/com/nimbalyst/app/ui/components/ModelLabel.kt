package com.nimbalyst.app.ui.components

/**
 * Short-form display labels for AI model identifiers. Port of iOS `ModelLabel.swift`,
 * which mirrors `packages/runtime/src/ai/modelConstants.ts` and the short-name logic in
 * `packages/electron/src/renderer/utils/modelUtils.ts`. Keep the tables in sync.
 *
 * Returns null when the provider can't be recognized; the caller hides the badge
 * rather than inventing a wrong label.
 */
object ModelLabel {

    /** Examples: "Opus 4.7", "Sonnet 4.6", "GPT-5.4", "Codex GPT-5.4". */
    fun shortLabel(provider: String?, model: String?): String? {
        val id = model?.lowercase()
        return when (provider?.lowercase() ?: "") {
            "claude-code" -> claudeCodeLabel(id, "Claude Agent")
            "claude-code-cli" -> claudeCodeLabel(id, "Claude Code CLI")
            "claude" -> claudeApiLabel(id)
            "openai" -> openAILabel(id)
            "openai-codex" -> codexLabel(id)
            "lmstudio", "lm-studio" -> "Local"
            else -> null
        }
    }

    // Claude Code: mirrors CLAUDE_CODE_VARIANT_VERSIONS in modelConstants.ts.
    private val claudeCodeVariantVersions = mapOf(
        "fable" to "5.1",
        "fable-5" to "5",
        "opus" to "5.5",
        "opus-5-5" to "5.5",
        "opus-5" to "5",
        "sonnet" to "5.5",
        "sonnet-5" to "5",
        "haiku" to "5.5",
        "opus-4-8" to "4.8",
        "opus-4-7" to "4.7",
        "opus-4-6" to "4.6",
        "sonnet-4-6" to "4.6",
        "haiku-4-5" to "4.5",
    )

    private val contextSuffix = Regex("-(?:1m|200k)$")
    private val versionPair = Regex("-(\\d)-(\\d)(?!\\d)")

    private fun claudeCodeLabel(modelId: String?, providerFallback: String): String {
        // No model field: we still know the provider, so show the provider label.
        if (modelId.isNullOrEmpty()) return providerFallback
        val bare = stripPrefix(modelId).replace(contextSuffix, "")
        val family = claudeFamily(bare) ?: return providerFallback

        extractVersion(bare)?.let { return "$family $it" }
        claudeCodeVariantVersions[canonicalVariantKey(bare)]?.let { return "$family $it" }
        return family
    }

    /** "opus-1m" -> "opus"; keeps pinned variants ("opus-4-6") intact. */
    private fun canonicalVariantKey(variant: String): String {
        val key = variant
            .replace(Regex("^claude-"), "")
            .replace(Regex("-(?:1m|200k|[0-9]{8})$"), "")
        if (claudeCodeVariantVersions.containsKey(key)) return key
        return key.split("-").firstOrNull() ?: key
    }

    /** First "-N-M" pair, e.g. "claude-opus-4-7" -> "4.7". */
    private fun extractVersion(id: String): String? =
        versionPair.find(id)?.let { "${it.groupValues[1]}.${it.groupValues[2]}" }

    private fun claudeFamily(bare: String): String? = when {
        "fable" in bare -> "Fable"
        "opus" in bare -> "Opus"
        "sonnet" in bare -> "Sonnet"
        "haiku" in bare -> "Haiku"
        else -> null
    }

    // Claude API: mirrors CLAUDE_MODELS[*].shortName in modelConstants.ts.
    private val claudeApiShortNames = mapOf(
        "claude-fable-5" to "Fable 5",
        "claude-sonnet-5-5" to "Sonnet 5.5",
        "claude-sonnet-5" to "Sonnet 5",
        "claude-haiku-5-5" to "Haiku 5.5",
        "claude-opus-5" to "Opus 5",
        "claude-opus-4-8" to "Opus 4.8",
        "claude-opus-4-7" to "Opus 4.7",
        "claude-opus-4-6" to "Opus 4.6",
        "claude-sonnet-4-6" to "Sonnet 4.6",
        "claude-opus-4-5-20251101" to "Opus 4.5",
        "claude-opus-4-1-20250805" to "Opus 4.1",
        "claude-opus-4-20250514" to "Opus 4",
        "claude-sonnet-4-5-20250929" to "Sonnet 4.5",
        "claude-sonnet-4-20250514" to "Sonnet 4",
        "claude-3-7-sonnet-20250219" to "Sonnet 3.7",
    )

    private fun claudeApiLabel(modelId: String?): String {
        if (modelId.isNullOrEmpty()) return "Claude"
        val bare = stripPrefix(modelId)
        claudeApiShortNames[bare]?.let { return it }
        val family = claudeFamily(bare) ?: return "Claude"
        return extractVersion(bare)?.let { "$family $it" } ?: family
    }

    // OpenAI / Codex: mirrors OPENAI_MODELS[*].shortName, as standalone labels.
    private val openAIShortNames = mapOf(
        "gpt-6-sol" to "GPT-6 Sol",
        "gpt-6-luna" to "GPT-6 Luna",
        "gpt-5.6-sol" to "GPT-5.6 Sol",
        "gpt-5.6-terra" to "GPT-5.6 Terra",
        "gpt-5.6-luna" to "GPT-5.6 Luna",
        "gpt-5.5" to "GPT-5.5",
        "gpt-5.4" to "GPT-5.4",
        "gpt-5.3-chat-latest" to "GPT-5.3",
        "gpt-5.2" to "GPT-5.2",
        "gpt-5.1" to "GPT-5.1",
        "gpt-5" to "GPT-5",
        "gpt-5-mini" to "GPT-5 Mini",
        "gpt-5-nano" to "GPT-5 Nano",
        "gpt-4.1" to "GPT-4.1",
        "gpt-4.1-mini" to "GPT-4.1 Mini",
    )

    private fun openAILabel(modelId: String?): String {
        if (modelId.isNullOrEmpty()) return "OpenAI"
        val bare = stripPrefix(modelId)
        openAIShortNames[bare]?.let { return it }
        if (bare.startsWith("gpt-")) return prettifyGPT(bare)
        return "OpenAI"
    }

    private fun codexLabel(modelId: String?): String {
        if (modelId.isNullOrEmpty()) return "Codex"
        val bare = stripPrefix(modelId)
        openAIShortNames[bare]?.let { return "Codex $it" }
        if (bare.startsWith("gpt-")) return "Codex ${prettifyGPT(bare)}"
        return "Codex"
    }

    /** "gpt-5-mini" -> "GPT-5 Mini". */
    private fun prettifyGPT(id: String): String {
        val tail = id.removePrefix("gpt-")
            .split("-")
            .filter { it.isNotEmpty() }
            .joinToString(" ") { token ->
                if (token.toDoubleOrNull() != null) token else token.replaceFirstChar { it.uppercase() }
            }
        return if (tail.isEmpty()) "GPT" else "GPT-$tail"
    }

    /** Strips a "provider:" prefix such as "claude-code:opus". */
    private fun stripPrefix(raw: String): String = raw.split(":", limit = 2).last()
}
