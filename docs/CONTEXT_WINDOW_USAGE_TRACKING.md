# Context Window Usage Tracking

How we track and display context window fill percentage for Claude Code sessions.

## Background

We show users how full their Claude Code context window is (e.g., "42% used / 200k"). The SDK's `/context` slash command stopped returning parseable output in agent-sdk 0.2.x (returns empty string, takes 30-80s), so we extract usage data directly from the streaming protocol instead.

## Source of Truth

Each `assistant` chunk from the Claude Agent SDK includes per-step `usage` data:

```json
{
  "type": "assistant",
  "message": {
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 239,
      "cache_read_input_tokens": 83066,
      "output_tokens": 42
    }
  }
}
```

The sum **`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`** equals the actual number of tokens in the context window for that step. The `output_tokens` field is excluded because it represents generated tokens, not context fill.

The SDK also provides `contextWindow` (e.g., 200,000) per model in `result.modelUsage`.

## Cumulative vs Per-Step Usage

The SDK has two kinds of usage data that look similar but mean very different things:

| Field | Scope | Use for |
|---|---|---|
| `chunk.message.usage` (on `assistant` chunks) | **Per-step** | Context fill display |
| `result.usage` (on `result` chunk) | **Cumulative** across all steps | Not useful (zeroed out) |
| `result.modelUsage` (on `result` chunk) | **Cumulative** across all steps | Billing, cost tracking, `contextWindow` |

This distinction is critical. A session with 200k context might show `modelUsage.inputTokens = 3,100,000` because it sums every step's input across the entire session. Using that for context fill would be wildly wrong.

We track these separately in `ClaudeCodeProvider.ts`:
- **`usageData`** -- general usage tracking, gets overwritten by cumulative `result.usage` at the end of a turn
- **`lastAssistantUsage`** -- only set from `assistant` chunks, never overwritten by the result chunk. This is what we use for context fill.

## Live (Mid-Turn) Updates

Context fill is surfaced **per assistant step**, not just at turn end. Every `assistant` chunk carries per-step `usage`; the provider emits a lightweight `context_usage` StreamChunk (carrying `contextFillTokens` only) for each one, and `MessageStreamingHandler` updates **only** `currentContext` from it and fires `ai:tokenUsageUpdated`. Cumulative input/output counters stay on the `complete` chunk so the live updates can't double-count. Without this, a long agentic turn (many tool calls over minutes) shows no indicator movement until the final `result` chunk. See NIM-868.

References:
- [Claude Agent SDK cost tracking docs](https://platform.claude.com/docs/en/agent-sdk/cost-tracking)
- [GitHub issue #66](https://github.com/anthropics/claude-agent-sdk-typescript/issues/66) on cumulative vs per-step usage

## Compaction Handling

When a user runs `/compact`, the SDK produces this chunk sequence:

```
system(status: "compacting")
system(status: null)
system(init)
system(compact_boundary)    ← has compact_metadata.pre_tokens
user(compaction summary)
result
```

There is **no `assistant` message** after compaction. Without special handling, `lastAssistantUsage` would still hold the pre-compaction value (e.g., 94% full), which is now stale since the context was just compressed.

Fix: when we see `compact_boundary`, we:
1. Reset `lastAssistantUsage = undefined` so the stale value isn't used
2. Set `contextCompacted = true` on the `complete` StreamChunk
3. AIService clears `currentContext` so the UI stops showing stale data

The next real user message will produce a fresh `assistant` response with accurate post-compaction usage.

## Subagents (Task Tool)

Subagents run as **separate SDK conversations** with their own session IDs, but the SDK relays their `assistant` chunks back through the **same** iterator, tagged with `parent_tool_use_id`. A subagent's context is much smaller than the lead's, so if its per-step usage reached the context-fill calc the live indicator would bounce between the lead's large context and the subagent's small one (NIM-868).

`ClaudeCodeTranscriptAdapter` therefore **skips per-step `usage` items when `parent_tool_use_id` is set** -- the same guard the `session_id` capture uses. Only the parent session's assistant messages set `lastAssistantUsage` / emit `context_usage`, so subagent usage never contaminates the parent's context fill.

After a subagent completes, its tool_result is added to the parent's conversation. The parent's next `assistant` message correctly reflects the enlarged context (including the subagent result).

## The 1M Context Window (and why the CLI path differs)

The 1M-token window is **plan-gated**, not a model property ([model config docs](https://code.claude.com/docs/en/model-config), "Extended context"): Max/Team/Enterprise get Opus auto-upgraded to 1M with no configuration, Pro pays usage credits for it, API/pay-as-you-go has full access, and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` removes 1M entirely. Sonnet 5 on the Anthropic API always runs 1M — it has no 200K variant and no `[1m]` suffix to select, which is why there is no `sonnet-1m` picker row.

So the per-variant table in `modelConstants.ts` is a **seed**, and each provider path corrects it differently:

| Path | Live signal | Correction |
|---|---|---|
| `claude-code` (Agent SDK — most users) | `result.modelUsage[<id>].contextWindow` | Self-corrects after the first turn (`resolveClaudeCodeParentContextWindow`) |
| `claude-code-cli` (genuine CLI) | `anthropic-beta: context-1m-2025-08-07` on the outbound `/v1/messages`, read by the observation proxy | `noteClaudeCliObserved1mSupport` → `contextWindowForCliModel`; keyed by model family so a Haiku subagent request can't downgrade the parent |

The CLI path has no runtime `modelUsage` at all (`AssembledUsage` carries no window), so without the header signal the seed would be the permanent denominator.

**Known limitation on the CLI path.** Nimbalyst points the CLI at its loopback observation proxy via `ANTHROPIC_BASE_URL`. Claude Code treats any custom base URL as an LLM gateway whose 1M support it cannot verify, so it **skips the plan-based 1M auto-upgrade** — a Max user whose direct `claude` session runs at 1M gets 200k through Nimbalyst's CLI provider (measured on CLI 2.1.220, GitHub #989). The explicit `[1m]` form is unaffected, so the fix is to select the **Opus 5 (1M)** or **Fable 5 (1M)** row in the model picker, which sends `opus[1m]` / `fable[1m]`. We deliberately do **not** append `[1m]` automatically: it is metered against usage credits on Pro plans, and silently opting a user into paid capacity is exactly the class of change [CLAUDE.md](../CLAUDE.md) forbids. With the header detection above, the meter reports the real window either way.

**The proxy now declares itself first-party, but that does not move the 1M needle.** The CLI is spawned with `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1` whenever the proxy forwards straight to `api.anthropic.com` (see [`proxyPassthroughEnv.ts`](../packages/electron/src/main/services/ai/claudeCliObservation/proxyPassthroughEnv.ts)), which restores the first-party-only behavior the gateway heuristic was withholding. Measured on CLI 2.1.220: it fixes the web-tool side query (the bug that motivated it), and the explicit `opus[1m]` request still carries `context-1m-2025-08-07`. Plain `opus` still does **not**, so the auto-upgrade above stays unavailable and the `[1m]` picker rows remain the answer.

## Data Flow

```
ClaudeCodeProvider                          AIService
─────────────────                          ─────────
assistant chunk
  → set lastAssistantUsage

compact_boundary
  → reset lastAssistantUsage
  → set receivedCompactBoundary

result chunk
  → compute lastMessageContextTokens
    from lastAssistantUsage
  → yield complete {                       → extract contextFillTokens
      contextFillTokens,                   → extract contextWindow from modelUsage
      contextCompacted,                    → if compacted: clear currentContext
      modelUsage                           → else: set currentContext = {tokens, contextWindow}
    }                                      → persist to DB + send IPC to UI
```

## Files

| File | Role |
|---|---|
| `packages/runtime/src/ai/server/providers/ClaudeCodeProvider.ts` | Streaming loop, `lastAssistantUsage` tracking, compaction reset |
| `packages/electron/src/main/services/ai/AIService.ts` | Persists `tokenUsage.currentContext`, sends `ai:tokenUsageUpdated` IPC |
| `packages/runtime/src/ai/server/types.ts` | `contextFillTokens` and `contextCompacted` fields on `StreamChunk` |
| `packages/runtime/src/ai/server/utils/contextUsage.ts` | Legacy `/context` output parser (no longer used for auto-fetch) |
| `packages/runtime/src/ai/modelConstants.ts` | `CLAUDE_CODE_NATIVE_1M_VARIANTS` (seed) and `CLAUDE_CODE_VARIANTS_WITH_1M` (`-1m` picker rows) |
| `packages/electron/src/main/services/ai/claudeCliContextUsage.ts` | CLI-path denominator: observed-1M registry + `contextWindowForCliModel` |
| `packages/electron/src/main/services/ai/claudeCliObservation/claudeApiRequestParser.ts` | `hasContext1mBeta` — reads the outbound `anthropic-beta` flag |
