/**
 * Synthetic transcript rows that make MCP interactive-prompt widgets render in
 * sessions that have NO SDK-streamed assistant `tool_use` block — chiefly the
 * genuine `claude-code-cli` path (NIM-806).
 *
 * Why this exists
 * ---------------
 * In the Agent-SDK / Codex paths, an interactive tool call (AskUserQuestion,
 * PromptForUserInput, …) reaches the transcript because the provider streams the
 * assistant `tool_use` block into `ai_agent_messages`; the transcript parser
 * projects it into a `tool_call_started` canonical event and the durable-prompt
 * widget renders from it.
 *
 * The genuine `claude` CLI is an external process talking to our in-process MCP
 * server over HTTP — it NEVER writes to `ai_agent_messages`. So when the model
 * (forced off the built-in via `--disallowedTools AskUserQuestion`) calls our
 * `mcp__nimbalyst__AskUserQuestion`, the handler blocks but nothing renders
 * a widget, and the CLI hangs. We close that gap by persisting the same
 * `nimbalyst_tool_use` / `nimbalyst_tool_result` rows the SDK path would have
 * produced — keyed by the CLI's `claudecode/toolUseId` (resolved upstream).
 *
 * Contract (must match `ClaudeCodeRawParser`):
 *   - `nimbalyst_tool_use`  → `parseNimbalystToolUse` reads `name` (→ toolName),
 *     `input` (→ arguments), `id` (→ providerToolCallId). The widget reads
 *     `toolCall.arguments` for its prompt and `toolCall.providerToolCallId` as
 *     the answer-channel key, so `id` MUST equal the MCP handler's response-id.
 *   - `nimbalyst_tool_result` → `parseToolResult` reads `tool_use_id`, `result`,
 *     `is_error`, producing the `tool_call_completed` that clears the widget.
 *
 * Scope guard: only the CLI path needs these (see `isClaudeCliSession`). The
 * existing `findByProviderToolCallId` dedup would also protect SDK/Codex, but
 * gating keeps the change strictly additive for the heavily-used paths.
 */

import { AgentMessagesRepository, AISessionsRepository } from "@nimbalyst/runtime";
import { markToolResultPersisted } from "../../services/ai/claudeCliToolResultSeen";

/** JSON content for a synthetic `nimbalyst_tool_use` row (see contract above). */
export function buildInteractivePromptToolUseContent(args: {
  toolUseId: string;
  toolName: string;
  input: unknown;
}): string {
  return JSON.stringify({
    type: "nimbalyst_tool_use",
    id: args.toolUseId,
    name: args.toolName,
    input: args.input ?? {},
  });
}

/** JSON content for a synthetic `nimbalyst_tool_result` row (see contract above). */
export function buildInteractivePromptToolResultContent(args: {
  toolUseId: string;
  result: unknown;
  isError?: boolean;
}): string {
  return JSON.stringify({
    type: "nimbalyst_tool_result",
    tool_use_id: args.toolUseId,
    result:
      typeof args.result === "string"
        ? args.result
        : JSON.stringify(args.result),
    is_error: args.isError ?? false,
  });
}

/**
 * True when the session is the genuine subscription CLI (`claude-code-cli`),
 * the only path that needs synthetic interactive-prompt rows. Best-effort:
 * returns false if the session can't be loaded (callers then skip the write).
 */
export async function isClaudeCliSession(
  sessionId: string | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const session = await AISessionsRepository.get(sessionId);
    return session?.provider === "claude-code-cli";
  } catch {
    return false;
  }
}

/**
 * Persist the synthetic `tool_use` row so the interactive-prompt widget renders
 * for a CLI session. Best-effort; logs and continues on failure.
 */
export async function persistInteractivePromptToolUse(args: {
  sessionId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  createdAt?: Date;
}): Promise<void> {
  try {
    await AgentMessagesRepository.create({
      sessionId: args.sessionId,
      source: "claude-code",
      direction: "output",
      content: buildInteractivePromptToolUseContent(args),
      hidden: false,
      createdAt: args.createdAt ?? new Date(),
    });
  } catch (err) {
    console.warn(
      "[MCP Server] Failed to persist synthetic interactive-prompt tool_use:",
      err,
    );
  }
}

/**
 * Persist the synthetic `tool_result` row so the widget transitions out of its
 * pending state (and `ClaudeCliPromptSurface` drops it). Best-effort.
 */
export async function persistInteractivePromptToolResult(args: {
  sessionId: string;
  toolUseId: string;
  result: unknown;
  isError?: boolean;
  createdAt?: Date;
}): Promise<void> {
  // Mark this tool_use_id as persisted BEFORE the await so the proxy observation
  // (which scrapes the CLI's echoed tool_result from the continuation request
  // body) skips the duplicate — regardless of DB commit timing (NIM-806 Defect B).
  markToolResultPersisted(args.sessionId, args.toolUseId);
  try {
    await AgentMessagesRepository.create({
      sessionId: args.sessionId,
      source: "claude-code",
      direction: "output",
      content: buildInteractivePromptToolResultContent(args),
      hidden: false,
      createdAt: args.createdAt ?? new Date(),
    });
  } catch (err) {
    console.warn(
      "[MCP Server] Failed to persist synthetic interactive-prompt tool_result:",
      err,
    );
  }
}
