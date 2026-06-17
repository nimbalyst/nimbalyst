/**
 * Reassembles Anthropic `/v1/messages` streaming SSE deltas into whole
 * assistant messages for the Claude CLI proxy observation backend
 * (NIM-806, Phase 3 / B3).
 *
 * The loopback proxy tees the same token-level SSE stream the CLI receives.
 * we accumulate the FULL assistant turn (all text / thinking /
 * tool_use blocks of one `message_start`…`message_stop`) and emit it once on
 * `message_stop`. That maps cleanly to a single raw `ai_agent_messages` row the
 * existing `ClaudeCodeRawParser` already projects into the rich transcript.
 *
 * SSE event grammar (Anthropic Messages streaming):
 *   message_start → { message: { id, model, usage } }
 *   content_block_start → { index, content_block: { type, ... } }
 *   content_block_delta → { index, delta: { text_delta | thinking_delta | input_json_delta } }
 *   content_block_stop → { index }
 *   message_delta → { delta: { stop_reason }, usage: { output_tokens } }
 *   message_stop
 *
 */

import type { SSEEvent } from "./sseExtractor";

export type AssembledContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "server_tool_use"; id: string; name: string; input: unknown }
  | { type: "web_search_tool_result"; toolUseId: string; content: unknown };

export interface AssembledUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AssembledAssistantMessage {
  /** Anthropic message id (`msg_…`) — stable per turn; used for bridge idempotency. */
  id: string;
  role: "assistant";
  model: string;
  content: AssembledContentBlock[];
  stopReason: string | null;
  usage: AssembledUsage;
}

interface MessageState {
  id: string;
  model: string;
  content: AssembledContentBlock[];
  stopReason: string | null;
  usage: AssembledUsage;
  /** Raw accumulating JSON string for the in-flight tool_use input. */
  toolInputJson: string[];
}

function emptyUsage(): AssembledUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

export class ClaudeApiMessageAssembler {
  /**
   * In-flight turn state keyed by proxy request id. The genuine CLI runs `Task`
   * sub-agents IN-PROCESS, so their `/v1/messages` calls hit the SAME loopback
   * proxy as the parent and their SSE streams interleave. A single shared
   * `current` would let parent + sub-agent deltas overwrite/pollute each other
   * (merged content blocks, cross-wired tool inputs). Per-request isolation keeps
   * each concurrent stream's assembly independent. Callers that drive a single
   * stream (and the unit tests) can omit the id — they share the `"default"` key.
   */
  private readonly states = new Map<string, MessageState>();
  private readonly onMessage: (msg: AssembledAssistantMessage) => void;

  constructor(onMessage: (msg: AssembledAssistantMessage) => void) {
    this.onMessage = onMessage;
  }

  /** Drop all in-flight state between sessions so no partial turn leaks. */
  reset(): void {
    this.states.clear();
  }

  /**
   * Feed one parsed SSE event for a given proxy request. Emits a whole assistant
   * message on message_stop. `requestId` isolates concurrent (sub-agent) streams.
   */
  processSSE(event: SSEEvent, requestId = "default"): void {
    const p = event.parsed;
    if (!p || typeof p !== "object") return;
    const e = p as Record<string, unknown>;

    switch (e.type) {
      case "message_start": {
        const msg = e.message as Record<string, unknown> | undefined;
        const usage = emptyUsage();
        if (msg?.usage && typeof msg.usage === "object") {
          const u = msg.usage as Record<string, number>;
          usage.inputTokens = u.input_tokens || 0;
          usage.outputTokens = u.output_tokens || 0;
          usage.cacheReadInputTokens = u.cache_read_input_tokens || 0;
          usage.cacheCreationInputTokens = u.cache_creation_input_tokens || 0;
        }
        this.states.set(requestId, {
          id: (msg?.id as string) || "",
          model: (msg?.model as string) || "",
          content: [],
          stopReason: null,
          usage,
          toolInputJson: [],
        });
        break;
      }

      case "content_block_start": {
        const current = this.states.get(requestId);
        if (!current) break;
        const block = (e.content_block as Record<string, unknown>) || {};
        if (block.type === "text") {
          current.content.push({ type: "text", text: (block.text as string) || "" });
        } else if (block.type === "thinking") {
          // `signature` may arrive inline here or accumulate via signature_delta.
          current.content.push({
            type: "thinking",
            thinking: (block.thinking as string) || "",
            ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
          });
        } else if (block.type === "redacted_thinking") {
          // Encrypted thinking — delivered whole (no deltas). Preserve `data` so the
          // raw row keeps thinking continuity rather than silently dropping it.
          current.content.push({ type: "redacted_thinking", data: (block.data as string) || "" });
        } else if (block.type === "tool_use") {
          current.content.push({
            type: "tool_use",
            id: (block.id as string) || "",
            name: (block.name as string) || "",
            input: {},
          });
          current.toolInputJson = [];
        } else if (block.type === "server_tool_use") {
          // Server-side tool call (e.g. web_search) — same input_json_delta shape
          // as tool_use; reassemble its input the same way.
          current.content.push({
            type: "server_tool_use",
            id: (block.id as string) || "",
            name: (block.name as string) || "",
            input: {},
          });
          current.toolInputJson = [];
        } else if (block.type === "web_search_tool_result") {
          // Server-tool result block — delivered whole. Preserve the matched
          // tool_use id + the results payload.
          current.content.push({
            type: "web_search_tool_result",
            toolUseId: (block.tool_use_id as string) || "",
            content: block.content ?? null,
          });
        }
        break;
      }

      case "content_block_delta": {
        const current = this.states.get(requestId);
        if (!current) break;
        const delta = (e.delta as Record<string, unknown>) || {};
        const block = current.content[current.content.length - 1];
        if (!block) break;
        if (delta.type === "text_delta" && block.type === "text") {
          block.text += (delta.text as string) || "";
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += (delta.thinking as string) || "";
        } else if (delta.type === "signature_delta" && block.type === "thinking") {
          // Thinking signature streams as its own delta — required to keep
          // extended-thinking continuity across turns.
          block.signature = (block.signature || "") + ((delta.signature as string) || "");
        } else if (
          delta.type === "input_json_delta" &&
          (block.type === "tool_use" || block.type === "server_tool_use")
        ) {
          current.toolInputJson.push((delta.partial_json as string) || "");
        }
        break;
      }

      case "content_block_stop": {
        const current = this.states.get(requestId);
        if (!current) break;
        const block = current.content[current.content.length - 1];
        if (block?.type === "tool_use" || block?.type === "server_tool_use") {
          const raw = current.toolInputJson.join("");
          if (raw.length > 0) {
            try {
              block.input = JSON.parse(raw);
            } catch {
              // Leave the partial-but-unparseable input as-is ({} default).
            }
          }
          current.toolInputJson = [];
        }
        break;
      }

      case "message_delta": {
        const current = this.states.get(requestId);
        if (!current) break;
        const delta = e.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) {
          current.stopReason = delta.stop_reason as string;
        }
        const usage = e.usage as Record<string, number> | undefined;
        if (usage?.output_tokens) {
          current.usage.outputTokens = usage.output_tokens;
        }
        break;
      }

      case "message_stop": {
        const current = this.states.get(requestId);
        if (!current) break;
        this.onMessage({
          id: current.id,
          role: "assistant",
          model: current.model,
          content: current.content,
          stopReason: current.stopReason,
          usage: current.usage,
        });
        this.states.delete(requestId);
        break;
      }
    }
  }
}
