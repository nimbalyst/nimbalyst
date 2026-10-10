import XCTest
@testable import NimbalystNative

/// Tests for `ModelLabel.shortLabel` — pins the short-form badge text we
/// render for every known `(provider, model)` shape across providers, and
/// locks in `nil` (hidden badge) for unknown inputs.
final class ModelLabelTests: XCTestCase {

    // MARK: - Claude Code

    func testClaudeCodeCanonicalVariants() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:fable"), "Fable 5.1")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:opus"), "Opus 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:sonnet"), "Sonnet 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:haiku"), "Haiku 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:haiku-4-5"), "Haiku 4.5")
    }

    func testClaudeCodeExtendedContextVariants() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:fable-1m"), "Fable 5.1")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:opus-1m"), "Opus 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:sonnet-1m"), "Sonnet 5.5")
    }

    func testClaudeCodeFableAliasVariants() {
        // `fable-5` is the pinned previous generation; `fable-5-1` is an alias for `fable`.
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:fable-5"), "Fable 5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:fable-5-1"), "Fable 5.1")
    }

    func testClaudeCodeSonnet55AndPinnedSonnet5() {
        for provider in ["claude-code", "claude-code-cli"] {
            XCTAssertEqual(ModelLabel.shortLabel(provider: provider, model: "\(provider):sonnet-5-5"), "Sonnet 5.5")
            XCTAssertEqual(ModelLabel.shortLabel(provider: provider, model: "\(provider):sonnet-5"), "Sonnet 5")
            XCTAssertEqual(ModelLabel.shortLabel(provider: provider, model: "\(provider):sonnet-5-1m"), "Sonnet 5")
        }
    }

    func testClaudeCodeOpus55AndPinnedOpus5() {
        for provider in ["claude-code", "claude-code-cli"] {
            XCTAssertEqual(ModelLabel.shortLabel(provider: provider, model: "\(provider):opus-5-5-1m"), "Opus 5.5")
            XCTAssertEqual(ModelLabel.shortLabel(provider: provider, model: "\(provider):opus-5-1m"), "Opus 5")
            XCTAssertEqual(ModelLabel.shortLabel(provider: provider, model: "claude-opus-5-5"), "Opus 5.5")
            XCTAssertEqual(ModelLabel.shortLabel(provider: provider, model: "claude-opus-5"), "Opus 5")
        }
    }

    func testClaudeCodeOpus48AliasVariants() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:opus-4-8"), "Opus 4.8")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:opus-4-8-1m"), "Opus 4.8")
    }

    func testClaudeCodePinnedVariant() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:opus-4-6"), "Opus 4.6")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:opus-4-6-1m"), "Opus 4.6")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-code:sonnet-4-6"), "Sonnet 4.6")
    }

    func testClaudeCodeRawSDKModelIds() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-fable-5"), "Fable 5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-opus-4-7"), "Opus 4.7")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-opus-4-6"), "Opus 4.6")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "claude-sonnet-4-5-20250929"), "Sonnet 4.5")
    }

    func testClaudeCodeUnknownModelFallsBackToProviderLabel() {
        // When we know the provider but can't identify the model, show the
        // provider label rather than hiding the badge or guessing a family.
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: nil), "Claude Agent")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: ""), "Claude Agent")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code", model: "mystery-model"), "Claude Agent")
    }

    // MARK: - Claude Code CLI (subscription)

    func testClaudeCodeCliVariantsMatchAgent() {
        // The subscription CLI shares the variant set with the SDK provider, so
        // the model badge resolves the same way (must NOT collapse to Sonnet).
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: "claude-code-cli:fable"), "Fable 5.1")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: "claude-code-cli:opus"), "Opus 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: "claude-code-cli:opus-1m"), "Opus 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: "claude-code-cli:sonnet-1m"), "Sonnet 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: "claude-code-cli:opus-4-6"), "Opus 4.6")
    }

    func testClaudeCodeCliUnknownModelFallsBackToCliLabel() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: nil), "Claude Code CLI")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: ""), "Claude Code CLI")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude-code-cli", model: "mystery-model"), "Claude Code CLI")
    }

    // MARK: - Claude API

    func testClaudeApiKnownModels() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-fable-5"), "Fable 5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-opus-5"), "Opus 5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-sonnet-5-5"), "Sonnet 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-haiku-5-5"), "Haiku 5.5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-sonnet-5"), "Sonnet 5")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-opus-4-7"), "Opus 4.7")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-sonnet-4-6"), "Sonnet 4.6")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-3-7-sonnet-20250219"), "Sonnet 3.7")
    }

    func testClaudeApiFallsBackToFamilyPlusVersion() {
        // Not in the exact-match table, but still recognizable.
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:claude-opus-5-0"), "Opus 5.0")
    }

    // MARK: - OpenAI

    func testOpenAIKnownModels() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai", model: "openai:gpt-5.6-sol"), "GPT-5.6 Sol")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai", model: "openai:gpt-5.4"), "GPT-5.4")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai", model: "openai:gpt-5-mini"), "GPT-5 Mini")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai", model: "openai:gpt-4.1"), "GPT-4.1")
    }

    func testOpenAIUnknownGptFallback() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai", model: "openai:gpt-6-turbo"), "GPT-6 Turbo")
    }

    // MARK: - OpenAI Codex

    func testCodexIncludesUnderlyingModel() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai-codex", model: "openai-codex:gpt-5.4"), "Codex GPT-5.4")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai-codex", model: "openai-codex:gpt-5-mini"), "Codex GPT-5 Mini")
    }

    func testCodexFallsBackToProviderOnlyWhenModelUnknown() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai-codex", model: nil), "Codex")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai-codex", model: ""), "Codex")
        // Unknown non-GPT model — do not append the mystery string.
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai-codex", model: "openai-codex:weirdo"), "Codex")
    }

    // MARK: - LM Studio

    func testLmStudio() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "lmstudio", model: "lmstudio:local-model"), "Local")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "lm-studio", model: nil), "Local")
    }

    // MARK: - Provider-only fallbacks for known providers with unknown models

    func testClaudeApiFallsBackToClaude() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: nil), "Claude")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "claude", model: "claude:weird"), "Claude")
    }

    func testOpenAIFallsBackToOpenAI() {
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai", model: nil), "OpenAI")
        XCTAssertEqual(ModelLabel.shortLabel(provider: "openai", model: "openai:weird"), "OpenAI")
    }

    // MARK: - Unknown provider

    func testUnknownProviderReturnsNil() {
        XCTAssertNil(ModelLabel.shortLabel(provider: nil, model: nil))
        XCTAssertNil(ModelLabel.shortLabel(provider: "", model: nil))
        XCTAssertNil(ModelLabel.shortLabel(provider: "some-future-provider", model: "something"))
    }
}
