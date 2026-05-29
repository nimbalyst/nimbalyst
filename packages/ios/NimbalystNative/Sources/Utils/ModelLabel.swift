import Foundation

/// Short-form display labels for AI model identifiers, mirroring the tables in
/// `packages/runtime/src/ai/modelConstants.ts` and the short-name logic in
/// `packages/electron/src/renderer/utils/modelUtils.ts`.
///
/// Returns `nil` when the model can't be recognized — the caller should hide
/// the badge rather than invent a wrong label.
public enum ModelLabel {

    /// Short badge label for a session's `(provider, model)` pair.
    /// Examples: "Opus 4.7", "Sonnet 4.6", "GPT-5.4", "Codex · 5.4".
    public static func shortLabel(provider: String?, model: String?) -> String? {
        let prov = provider?.lowercased() ?? ""
        let id = model?.lowercased()

        switch prov {
        case "claude-code":
            return claudeCodeLabel(id)
        case "claude":
            return claudeApiLabel(id)
        case "openai":
            return openAILabel(id)
        case "openai-codex":
            return codexLabel(id)
        case "lmstudio", "lm-studio":
            return "Local"
        default:
            return nil
        }
    }

    // MARK: - Claude Code

    /// Mirrors `CLAUDE_CODE_VARIANT_VERSIONS` in `modelConstants.ts`.
    private static let claudeCodeVariantVersions: [String: String] = [
        "opus": "4.7",
        "sonnet": "4.6",
        "haiku": "4.5",
        "opus-4-6": "4.6",
    ]

    private static func claudeCodeLabel(_ modelId: String?) -> String? {
        // No model field: we still know the provider, so show the provider
        // label rather than hiding the badge. Mirrors the Codex fallback.
        guard let raw = modelId, !raw.isEmpty else { return "Claude Agent" }

        // Strip "claude-code:" (or similar) prefix.
        let bare = raw.split(separator: ":", maxSplits: 1).last.map(String.init) ?? raw

        // Family from substring — handles both canonical variants ("opus",
        // "sonnet-1m") and raw SDK IDs ("claude-opus-4-7").
        let family: String
        if bare.contains("opus") { family = "Opus" }
        else if bare.contains("sonnet") { family = "Sonnet" }
        else if bare.contains("haiku") { family = "Haiku" }
        else { return "Claude Agent" }

        // Prefer an explicit version embedded in the ID (raw SDK IDs like
        // "claude-opus-4-7" or pinned variants like "opus-4-6").
        if let version = extractVersion(from: bare) {
            return "\(family) \(version)"
        }

        // Canonical variant ("opus", "opus-1m", "sonnet-1m"): look up the
        // current canonical version from the shared table.
        let variantKey = canonicalVariantKey(bare)
        if let version = claudeCodeVariantVersions[variantKey] {
            return "\(family) \(version)"
        }

        return family
    }

    /// Reduce a bare variant string like "opus-1m" or "sonnet" to the key we
    /// use in `claudeCodeVariantVersions`. Keeps pinned variants ("opus-4-6")
    /// intact, but strips context-window suffixes ("-1m").
    private static func canonicalVariantKey(_ variant: String) -> String {
        if claudeCodeVariantVersions[variant] != nil { return variant }
        // Drop trailing "-1m" / "-200k" / other context suffixes.
        let parts = variant.split(separator: "-").map(String.init)
        if let first = parts.first { return first }
        return variant
    }

    /// Pulls a version token like "4.7" / "4.6" / "4.5" out of an ID shaped
    /// like `claude-opus-4-7`, `claude-sonnet-4-5-20250929`, or `opus-4-6`.
    /// Returns nil if no such token is present.
    private static func extractVersion(from id: String) -> String? {
        // Match the first "-N-M" pair in the string.
        guard let regex = try? NSRegularExpression(pattern: "-(\\d)-(\\d)(?![\\d])", options: []) else {
            return nil
        }
        let ns = id as NSString
        guard let match = regex.firstMatch(in: id, options: [], range: NSRange(location: 0, length: ns.length)) else {
            return nil
        }
        let major = ns.substring(with: match.range(at: 1))
        let minor = ns.substring(with: match.range(at: 2))
        return "\(major).\(minor)"
    }

    // MARK: - Claude API

    /// Mirrors `CLAUDE_MODELS[*].shortName` in `modelConstants.ts`.
    private static let claudeApiShortNames: [String: String] = [
        "claude-opus-4-8": "Opus 4.8",
        "claude-opus-4-7": "Opus 4.7",
        "claude-opus-4-6": "Opus 4.6",
        "claude-sonnet-4-6": "Sonnet 4.6",
        "claude-opus-4-5-20251101": "Opus 4.5",
        "claude-opus-4-1-20250805": "Opus 4.1",
        "claude-opus-4-20250514": "Opus 4",
        "claude-sonnet-4-5-20250929": "Sonnet 4.5",
        "claude-sonnet-4-20250514": "Sonnet 4",
        "claude-3-7-sonnet-20250219": "Sonnet 3.7",
    ]

    private static func claudeApiLabel(_ modelId: String?) -> String? {
        guard let raw = modelId, !raw.isEmpty else { return "Claude" }
        let bare = raw.split(separator: ":", maxSplits: 1).last.map(String.init) ?? raw
        if let exact = claudeApiShortNames[bare] { return exact }
        // Fallback: derive from family + embedded version if present.
        let family: String?
        if bare.contains("opus") { family = "Opus" }
        else if bare.contains("sonnet") { family = "Sonnet" }
        else if bare.contains("haiku") { family = "Haiku" }
        else { family = nil }
        if let family = family {
            if let version = extractVersion(from: bare) { return "\(family) \(version)" }
            return family
        }
        // Unknown model string: fall back to provider label.
        return "Claude"
    }

    // MARK: - OpenAI / Codex

    /// Mirrors `OPENAI_MODELS[*].shortName` — adjusted to standalone labels
    /// (e.g. "GPT-5.4" rather than just "5.4") so the badge reads cleanly
    /// without relying on a neighboring provider word.
    private static let openAIShortNames: [String: String] = [
        "gpt-5.5": "GPT-5.5",
        "gpt-5.4": "GPT-5.4",
        "gpt-5.3-chat-latest": "GPT-5.3",
        "gpt-5.2": "GPT-5.2",
        "gpt-5.1": "GPT-5.1",
        "gpt-5": "GPT-5",
        "gpt-5-mini": "GPT-5 Mini",
        "gpt-5-nano": "GPT-5 Nano",
        "gpt-4.1": "GPT-4.1",
        "gpt-4.1-mini": "GPT-4.1 Mini",
    ]

    private static func openAILabel(_ modelId: String?) -> String? {
        guard let raw = modelId, !raw.isEmpty else { return "OpenAI" }
        let bare = raw.split(separator: ":", maxSplits: 1).last.map(String.init) ?? raw
        if let name = openAIShortNames[bare] { return name }
        // Generic GPT fallback: "gpt-5-turbo" -> "GPT-5 Turbo"
        if bare.hasPrefix("gpt-") { return prettifyGPT(bare) }
        // Unknown model: fall back to provider label rather than guess.
        return "OpenAI"
    }

    /// Codex wraps an OpenAI model ID; label it as "Codex <model>" when the
    /// underlying model is recognizable, otherwise fall back to plain
    /// "Codex" rather than appending a mystery string.
    private static func codexLabel(_ modelId: String?) -> String? {
        guard let raw = modelId, !raw.isEmpty else { return "Codex" }
        let bare = raw.split(separator: ":", maxSplits: 1).last.map(String.init) ?? raw
        if let name = openAIShortNames[bare] { return "Codex \(name)" }
        if bare.hasPrefix("gpt-") { return "Codex \(prettifyGPT(bare))" }
        return "Codex"
    }

    private static func prettifyGPT(_ id: String) -> String {
        // "gpt-5-mini" -> "GPT-5 Mini"
        let trimmed = id.replacingOccurrences(of: "gpt-", with: "", options: [.anchored, .caseInsensitive])
        let tokens = trimmed.split(separator: "-").map { token -> String in
            let s = String(token)
            // Leave version tokens like "5" or "5.4" alone.
            if Double(s) != nil { return s }
            return s.prefix(1).uppercased() + s.dropFirst()
        }
        let tail = tokens.joined(separator: " ")
        return tail.isEmpty ? "GPT" : "GPT-\(tail)"
    }
}
