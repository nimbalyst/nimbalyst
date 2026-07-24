/**
 * Persist proxy-observed `tool_result` blocks for a `claude-code-cli` session
 * (NIM-806, Phase 3 / B3, Slice E).
 *
 * The tee'd SSE response only carries the assistant's `tool_use` calls; the
 * matching `tool_result` blocks ride in the NEXT `/v1/messages` REQUEST body's
 * trailing user message (parsed by `extractToolResults`). We persist each as a
 * `nimbalyst_tool_result` raw row keyed by `tool_use_id`, in the exact shape
 * `ClaudeCodeRawParser.parseToolResult` projects — so the tool card the assistant
 * `tool_use` opened (same `providerToolCallId`) completes in the rich transcript.
 *
 * Dedup: the request body re-sends every prior turn's tool_result each turn, so a
 * caller-owned `seen` set (one per observation session) keeps each `tool_use_id`
 * persisted exactly once. Deps are injected for unit-testing without a DB / window.
 */

import { AgentMessagesRepository } from '@nimbalyst/runtime';
import { buildInteractivePromptToolResultContent } from '../../mcp/tools/interactivePromptTranscript';
import { broadcastMessageLogged } from './claudeCliUserPromptLog';
import type { ObservedToolResult } from './claudeCliObservation/claudeApiRequestParser';

export interface LogClaudeCliToolResultsInput {
  sessionId: string;
  workspacePath: string;
  results: ObservedToolResult[];
  /** Caller-owned set of already-persisted tool_use_ids (one per observation session). */
  seen: Set<string>;
}

export interface LogClaudeCliToolResultsDeps {
  createMessage: (row: {
    sessionId: string;
    source: 'claude-code';
    direction: 'output';
    content: string;
    hidden: boolean;
    createdAt: Date;
  }) => Promise<unknown>;
  notifyMessageLogged: (sessionId: string, workspacePath: string) => void;
  now: () => Date;
}

const productionDeps: LogClaudeCliToolResultsDeps = {
  createMessage: (row) => AgentMessagesRepository.create(row),
  notifyMessageLogged: broadcastMessageLogged,
  now: () => new Date(),
};

/**
 * Persist the not-yet-seen tool_results and broadcast a single transcript reload
 * if any were new. Best-effort: a per-row failure is swallowed (the row stays
 * unseen so a later turn's re-delivery can retry).
 */
export async function logClaudeCliToolResults(
  input: LogClaudeCliToolResultsInput,
  deps: LogClaudeCliToolResultsDeps = productionDeps,
): Promise<void> {
  let persistedAny = false;

  for (const result of input.results) {
    const toolUseId = result.toolUseId;
    if (!toolUseId || input.seen.has(toolUseId)) continue;

    try {
      await deps.createMessage({
        sessionId: input.sessionId,
        source: 'claude-code',
        direction: 'output',
        content: buildInteractivePromptToolResultContent({
          toolUseId,
          result: result.content,
          isError: result.isError,
        }),
        hidden: false,
        createdAt: deps.now(),
      });
      input.seen.add(toolUseId);
      persistedAny = true;
    } catch (err) {
      console.warn('[ClaudeCliToolResultLog] Failed to persist tool_result:', err);
    }
  }

  if (persistedAny) {
    deps.notifyMessageLogged(input.sessionId, input.workspacePath);
  }
}

/**
 * Parse already-persisted `nimbalyst_tool_result` rows back into their
 * `tool_use_id`s (NIM-806 BUG 3, double-logging guard). Pure and tolerant of
 * non-JSON / non-tool_result rows.
 *
 * The per-launch `seen` set above only stops re-logging WITHIN one observation
 * session. A RESUMED CLI (`--resume`) replays the entire prior conversation —
 * including every old `tool_result` — in its first request body, but the `seen`
 * set is empty after relaunch. Pre-seeding it from the rows already on disk keeps
 * each tool_result persisted exactly once across restarts.
 */
export function extractPersistedToolResultIds(rows: Array<{ content: string }>): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    // Cheap pre-filter before the JSON parse — most rows are assistant turns / prompts.
    if (!row?.content || !row.content.includes('nimbalyst_tool_result')) continue;
    try {
      const parsed = JSON.parse(row.content) as { type?: unknown; tool_use_id?: unknown };
      if (parsed?.type === 'nimbalyst_tool_result' && typeof parsed.tool_use_id === 'string' && parsed.tool_use_id) {
        ids.add(parsed.tool_use_id);
      }
    } catch {
      // Not JSON / not our shape — ignore.
    }
  }
  return ids;
}

export interface LoadSeenToolResultIdsDeps {
  /** List the session's persisted agent messages (includes hidden rows). */
  list: (sessionId: string) => Promise<Array<{ content: string }>>;
}

const productionLoadDeps: LoadSeenToolResultIdsDeps = {
  list: (sessionId) => AgentMessagesRepository.list(sessionId, { includeHidden: true }),
};

/**
 * Build the initial `seen` set for an observation session by reading the
 * tool_results already persisted for it. Best-effort: a DB failure yields an
 * empty set (worst case = the pre-resume behavior, possible re-log) rather than
 * blocking observation.
 */
export async function loadSeenToolResultIds(
  sessionId: string,
  deps: LoadSeenToolResultIdsDeps = productionLoadDeps,
): Promise<Set<string>> {
  try {
    const rows = await deps.list(sessionId);
    return extractPersistedToolResultIds(rows);
  } catch (err) {
    console.warn('[ClaudeCliToolResultLog] Failed to pre-seed seen tool_result ids:', err);
    return new Set<string>();
  }
}
