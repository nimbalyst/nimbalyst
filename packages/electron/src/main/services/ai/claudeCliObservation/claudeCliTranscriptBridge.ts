/**
 * Bridges reassembled proxy-observed assistant turns into the existing transcript
 * pipeline for the Claude CLI proxy observation backend (NIM-806, Phase 3 / B3,
 * Slice C).
 *
 * The genuine `claude` CLI is an external process that never writes to
 * `ai_agent_messages`. The proxy tees its SSE stream and `ClaudeApiMessageAssembler`
 * reassembles each turn into an `AssembledAssistantMessage`. Here we serialize
 * that into the EXACT raw-row shape `ClaudeCodeRawParser` already projects for the
 * Agent-SDK path — `{ type:'assistant', message:{ id, role, model, content[], usage } }`
 * — so writing it to `ai_agent_messages` (source `claude-code`) flows through the
 * unchanged TranscriptTransformer / projector into the rich transcript.
 *
 * Two contract points:
 *   - tool_use blocks carry `id`, which the parser maps to `providerToolCallId`.
 *     That is what dedups a proxy-observed tool_use against the synthetic
 *     interactive-prompt row (`interactivePromptTranscript.ts`) keyed by the same
 *     `claudecode/<toolUseId>`, so the AskUserQuestion widget doesn't double up.
 *   - thinking blocks pass through `signature` when present (the parser persists
 *     it on the side-channel).
 *
 * This module is pure: it builds the row content string. Persisting + the
 * `ai:message-logged` reload signal are done by the production observation wiring,
 * with idempotency (skip re-delivered Anthropic message ids) owned upstream.
 */

import type {
  AssembledAssistantMessage,
  AssembledContentBlock,
} from "./claudeApiMessageAssembler";

/**
 * Raw block shape `ClaudeCodeRawParser.parseOutputMessage` reads per content block.
 *
 * `redacted_thinking` / `server_tool_use` / `web_search_tool_result` are emitted in
 * their standard Anthropic shapes so the append-only raw row (the source of truth)
 * keeps them. The current parser only renders text / thinking / tool_use; the others
 * are preserved-but-unrendered until the parser gains support, rather than dropped at
 * the assembler as before.
 */
type RawAssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "server_tool_use"; id: string; name: string; input: unknown }
  | { type: "web_search_tool_result"; tool_use_id: string; content: unknown };

function toRawBlock(block: AssembledContentBlock): RawAssistantBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      };
    case "redacted_thinking":
      return { type: "redacted_thinking", data: block.data };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "server_tool_use":
      return { type: "server_tool_use", id: block.id, name: block.name, input: block.input };
    case "web_search_tool_result":
      return { type: "web_search_tool_result", tool_use_id: block.toolUseId, content: block.content };
  }
}

/**
 * Serialize an assembled assistant turn into the `ai_agent_messages.content`
 * JSON `ClaudeCodeRawParser` projects (mirrors the SDK `type:'assistant'` row).
 */
export function buildAssistantRawContent(msg: AssembledAssistantMessage): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: msg.id,
      role: "assistant",
      model: msg.model,
      content: msg.content.map(toRawBlock),
      usage: {
        input_tokens: msg.usage.inputTokens,
        output_tokens: msg.usage.outputTokens,
        cache_read_input_tokens: msg.usage.cacheReadInputTokens,
        cache_creation_input_tokens: msg.usage.cacheCreationInputTokens,
      },
    },
  });
}
