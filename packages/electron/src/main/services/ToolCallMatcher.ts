/**
 * ToolCallMatcher - Correlates file edits in session_files with tool calls in ai_agent_messages.
 *
 * Creates linkage records in ai_tool_call_file_edits so the UI can show
 * which tool call caused which file edit.
 *
 * Matching heuristics (scored):
 *   +100  toolUseId exact match (bypasses time cutoff)
 *   +40   filename appears in tool call arguments
 *   +30   filename appears in tool call output
 *
 * Time cutoff: file edit must occur within 10s before tool call start
 * or 10s after tool result end. Candidates outside this window are
 * excluded entirely (except toolUseId exact matches).
 *
 * Path matching uses filename only (basename), not full paths.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { parse as parseShellCommand } from 'shell-quote';
import { database } from '../database/PGLiteDatabaseWorker';
import { logger } from '../utils/logger';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import { AISessionsRepository } from '@nimbalyst/runtime';
import type { TranscriptEvent, ToolCallPayload } from '@nimbalyst/runtime/ai/server/transcript/types';
import {
  MAX_HISTORY_DIFF_INPUT_BYTES,
  computeBoundedHistoryDiff,
  type HistoryDiffComputationResult,
  type HistoryDiffFailureCode,
  type HistoryDiffOmissionReason,
} from './HistoryDiffService';
import { historyDiffWorkerClient } from './HistoryDiffWorkerClient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallWindow {
  messageId: number;
  messageCreatedAt: number;
  sessionId: string;
  toolName: string;
  toolCallItemId: string | null;
  toolUseId: string | null;
  argsText: string;
  outputText: string;
  args?: any;
  /** Whether this window was parsed from an item.completed event (has result data). */
  isCompleted?: boolean;
}

/**
 * Diff data for a file changed by a tool call.
 * SYNC: Keep in sync with ToolCallDiffResult in packages/runtime/src/ui/AgentTranscript/components/CustomToolWidgets/index.ts
 */
export interface ToolCallDiffResult {
  filePath: string;
  operation: string; // 'create' | 'edit' | 'delete' | 'bash'
  diffs: Array<{ oldString: string; newString: string }>; // empty for bash/unknown
  content?: string; // full content for create operations
  linesAdded?: number;
  linesRemoved?: number;
  debugInfo?: string; // how this file was linked to the tool call
  historySource?: 'history-post-edit' | 'history-disk-fallback';
  omissionReason?: HistoryDiffOmissionReason;
  inputBytes?: { before: number; after: number };
  limitBytes?: number;
  errorCode?: HistoryDiffFailureCode;
}

export interface ToolCallDiffLoadResult {
  state: 'ready' | 'partial' | 'none' | 'failed';
  diffs: ToolCallDiffResult[];
  omissions: Array<{
    filePath: string;
    reason: HistoryDiffOmissionReason;
    inputBytes?: { before: number; after: number };
    limitBytes?: number;
  }>;
  errorCode?: HistoryDiffFailureCode;
}

export interface ToolCallFileEdit {
  id: number;
  sessionId: string;
  sessionFileId: string;
  messageId: number;
  toolCallItemId: string | null;
  toolUseId: string | null;
  matchScore: number;
  matchReason: string;
  fileTimestamp: Date | null;
  createdAt: Date;
}

export interface WorkspaceFileEditMatchInput {
  workspacePath: string;
  filePath: string;
  fileTimestamp: number;
  candidateSessionIds: string[];
}

export interface WorkspaceFileEditCandidate {
  sessionId: string;
  messageId: number;
  toolName: string;
  toolCallItemId: string | null;
  toolUseId: string | null;
  score: number;
  reasons: string[];
  timeDiffMs: number;
}

export interface WorkspaceFileEditMatchResult {
  winner: WorkspaceFileEditCandidate | null;
  candidates: WorkspaceFileEditCandidate[];
  reason: string;
}

interface SessionFileRow {
  id: string;
  file_path: string;
  timestamp_ms: number;
  metadata: any;
}

interface AgentMessageRow {
  id: number;
  content: string;
  created_at_ms: number;
  metadata?: unknown;
}

interface ToolCallMatchRow {
  id: number;
  session_id: string;
  session_file_id: string;
  message_id: number;
  tool_call_item_id: string | null;
  tool_use_id: string | null;
  match_score: number;
  match_reason: string;
  file_timestamp: Date | null;
  created_at: Date;
}

interface ToolCallLookup {
  toolCallItemId: string;
  toolCallTimestamp?: number;
}

/**
 * Per-session data loaded ONCE and reused across every tool call during
 * transcript enrichment. Without it, enriching a session with N tool calls
 * re-runs the same session-invariant queries (workspace_id, session,
 * `session_files`, `ai_tool_call_file_edits`) and repeats per-file work
 * (`document_history` snapshot fetch + gunzip + disk read + diff) once per
 * tool call -- an N+1 that makes a ~1300-edit session take 60s+ to load.
 * The values here are the batched equivalents; the per-tool-call methods read
 * from these maps instead of querying when a context is supplied.
 */
export interface SessionEnrichmentContext {
  sessionId: string;
  workspaceId?: string;
  provider: string;
  /** `edited` session_files grouped by metadata.toolUseId */
  editedByToolUseId: Map<string, SessionFileRow[]>;
  /** all `edited` session_files by row id (for the ai_tool_call_file_edits path) */
  sessionFilesById: Map<string, { file_path: string; metadata: any }>;
  /** ai_tool_call_file_edits rows grouped by tool_call_item_id */
  toolEditsByItemId: Map<string, ToolCallMatchRow[]>;
  /** pre-edit document_history content keyed by `${filePath}\u0000${toolUseId}` (latest wins) */
  preEditByFileAndTool: Map<string, Buffer>;
  /** latest pre-edit document_history content per filePath (toolUseId-agnostic fallback) */
  preEditLatestByFile: Map<string, Buffer>;
  /** ai-edit document_history content keyed by `${filePath}\u0000${toolUseId}` (latest wins) */
  postEditByFileAndTool: Map<string, Buffer>;
  /** memoized current on-disk bytes per filePath (null = unreadable/deleted) */
  diskContentCache: Map<string, Buffer | null>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIME_CUTOFF_MS = 10_000; // 10 second hard cutoff around tool call
const MIN_MATCH_SCORE = 30; // Must have at least a filename match
const WORKSPACE_CLEAR_WINNER_MARGIN = 12;
const WORKSPACE_MIN_CONFIDENCE_SCORE = 55;

/** Shell wrapper: /bin/zsh -lc 'cmd' or bare bash -lc 'cmd' (Windows inner layer) */
const SHELL_WRAPPER_REGEX = /^(?:\/(?:bin|usr\/bin)\/)?(?:bash|zsh|sh)\s+-l?c\s+([\s\S]+)$/;

/** Windows PowerShell wrapper: "C:\...\powershell.exe" -Command 'actual command' */
const POWERSHELL_REGEX = /^"?[A-Za-z]:\\[^"]*\\(?:powershell|pwsh)(?:\.exe)?"?\s+-Command\s+([\s\S]+)$/i;

/** Windows cmd.exe wrapper: cmd.exe /c "actual command" or cmd /c "actual command" */
const CMD_EXE_REGEX = /^"?(?:[A-Za-z]:\\[^"]*\\)?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/;

/** Strip matching outer quotes (single or double) from a string */
function stripOuterQuotes(s: string): string {
  return s.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

/**
 * Escape SQL LIKE wildcard characters in a string so it can be safely
 * interpolated into a LIKE pattern. Use with ESCAPE '\' in the query.
 */
function escapeSqlLikeWildcards(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Unwrap a shell-wrapped command to extract the inner command.
 *
 * macOS/Linux: /bin/zsh -lc "sed -n '1,260p' file.ts"
 *   -> sed -n '1,260p' file.ts
 *
 * Windows: "C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'bash -lc "cat file.md"'
 *   -> cat file.md
 *
 * Windows: cmd.exe /c "bash -lc 'echo hello'"
 *   -> echo hello
 *
 * Returns the original command if not shell-wrapped.
 */
export function unwrapShellCommand(command: string): string {
  // Try cmd.exe wrapper
  const cmdMatch = command.match(CMD_EXE_REGEX);
  if (cmdMatch) {
    const inner = stripOuterQuotes(cmdMatch[1]);
    return unwrapShellCommand(inner);
  }

  // Try PowerShell wrapper (may contain a nested Unix shell wrapper)
  const psMatch = command.match(POWERSHELL_REGEX);
  if (psMatch) {
    const inner = stripOuterQuotes(psMatch[1]);
    return unwrapShellCommand(inner);
  }

  // Try shell wrapper (with or without path prefix)
  const unixMatch = command.match(SHELL_WRAPPER_REGEX);
  if (unixMatch) {
    return stripOuterQuotes(unixMatch[1]);
  }

  return command;
}

// Tool item types that represent tool calls
const TOOL_ITEM_TYPES = new Set([
  'mcp_tool_call',
  'command_execution',
  'file_change',
  'tool_call',
  'function_call',
]);

/** Count newline-delimited lines in a string. Returns 0 for empty strings. */
function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function applyHistoryDiffOutcome(
  target: ToolCallDiffResult,
  outcome: HistoryDiffComputationResult & {
    source: 'history-post-edit' | 'history-disk-fallback';
  },
): void {
  target.historySource = outcome.source;
  if (outcome.status === 'ready') {
    target.diffs = [{ oldString: outcome.oldString, newString: outcome.newString }];
    target.linesAdded = outcome.linesAdded;
    target.linesRemoved = outcome.linesRemoved;
    return;
  }
  if (outcome.status === 'omitted') {
    target.omissionReason = outcome.reason;
    target.inputBytes = outcome.inputBytes;
    target.limitBytes = outcome.limitBytes;
    return;
  }
  if (outcome.status === 'failed') {
    target.errorCode = outcome.errorCode;
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Ensure a value is a number, converting from string if needed.
 */
function ensureNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Parse tool call lookup inputs from the renderer.
 * Format (Codex disambiguation): "nimtc|<urlEncodedItemId>|<timestamp>|<index>"
 */
function parseToolCallLookupId(toolCallItemId: string, toolCallTimestamp?: number): ToolCallLookup {
  if (toolCallItemId.startsWith('nimtc|')) {
    const parts = toolCallItemId.split('|');
    const encodedId = parts[1] || '';
    const parsedTimestamp = Number(parts[2]);
    try {
      const decodedId = decodeURIComponent(encodedId);
      if (decodedId) {
        return {
          toolCallItemId: decodedId,
          toolCallTimestamp: Number.isFinite(parsedTimestamp) ? parsedTimestamp : toolCallTimestamp,
        };
      }
    } catch {
      // Fall through to plain ID handling.
    }
  }

  return { toolCallItemId, toolCallTimestamp };
}

/**
 * Stringify tool arguments for filename matching in scoreMatch.
 */
function stringifyArgs(args: any): string {
  if (!args) return '';
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

/**
 * Stringify tool output for text scanning.
 */
function stringifyOutput(output: any): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  if (typeof output === 'object') {
    // Check common result fields
    const parts: string[] = [];
    if (typeof output.output === 'string') parts.push(output.output);
    if (typeof output.stdout === 'string') parts.push(output.stdout);
    if (typeof output.stderr === 'string') parts.push(output.stderr);
    if (typeof output.aggregated_output === 'string') parts.push(output.aggregated_output);
    if (typeof output.result === 'string') parts.push(output.result);
    if (parts.length > 0) return parts.join('\n');
    // Fallback: stringify the whole thing (truncated)
    try {
      const str = JSON.stringify(output);
      return str.length > 10000 ? str.slice(0, 10000) : str;
    } catch {
      return '';
    }
  }
  return String(output);
}

function extractSyntheticEditGroupId(rawMetadata: unknown): string | null {
  if (!rawMetadata || typeof rawMetadata !== 'object') {
    return null;
  }
  const editGroupId = (rawMetadata as { editGroupId?: unknown }).editGroupId;
  if (typeof editGroupId === 'string' && editGroupId.startsWith('nimtc|')) {
    return editGroupId;
  }
  return null;
}

/**
 * Parse an ai_agent_messages content string to extract tool call windows.
 */
export function parseToolCallWindows(
  messageId: number,
  content: string,
  createdAt: Date,
  sessionId: string,
  workspacePath?: string,
  rawMetadata?: unknown,
): ToolCallWindow[] {
  const windows: ToolCallWindow[] = [];

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return windows;
  }

  if (!parsed || typeof parsed !== 'object') return windows;

  const eventType = typeof parsed.type === 'string' ? parsed.type : '';

  // -----------------------------------------------------------------------
  // Format 1: Raw Claude API messages
  // Structure: {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}
  // or: {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
  // -----------------------------------------------------------------------
  if ((eventType === 'assistant' || eventType === 'user') && parsed.message?.content) {
    const contentBlocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];

    for (const block of contentBlocks) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const toolName = block.name;
        const args = block.input ?? null;
        const toolId = typeof block.id === 'string' ? block.id : null;

        windows.push({
          messageId,
          messageCreatedAt: createdAt.getTime(),
          sessionId,
          toolName,
          toolCallItemId: toolId,
          toolUseId: toolId,
          argsText: stringifyArgs(args),
          outputText: '',
          args,
        });
      }
    }

    return windows;
  }

  // -----------------------------------------------------------------------
  // Format 2: Claude Code SDK events
  // Structure: {"type":"item.completed","item":{"type":"tool_call",...}}
  // -----------------------------------------------------------------------
  const item = parsed.item;

  if (!item || typeof item !== 'object') return windows;

  const itemType = typeof item.type === 'string' ? item.type : '';

  // Only process tool-like items
  const isTool = TOOL_ITEM_TYPES.has(itemType) ||
    itemType.includes('tool') ||
    itemType.includes('command');

  if (!isTool) return windows;

  // Extract tool name
  let toolName = '';
  if (itemType === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : '';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    toolName = server && tool ? `mcp__${server}__${tool}` : tool || 'Unknown';
  } else if (itemType === 'command_execution') {
    toolName = 'Bash';
  } else if (itemType === 'file_change') {
    toolName = 'file_change';
  } else {
    toolName = typeof item.name === 'string' ? item.name :
      typeof item.tool === 'string' ? item.tool :
      typeof item.command === 'string' ? item.command : 'Unknown';
  }

  // Extract tool arguments
  let args: any = null;
  if (itemType === 'command_execution') {
    // Codex uses command field directly, often wrapped in a shell invocation
    // like "/bin/zsh -lc 'actual command'" - unwrap to get the inner command
    const rawCommand = typeof item.command === 'string' ? item.command : '';
    args = { command: unwrapShellCommand(rawCommand) };
  } else if (itemType === 'file_change') {
    args = { changes: item.changes };
  } else {
    // Standard tool call with arguments/input
    args = item.arguments ?? item.args ?? item.input ?? item.parameters ?? null;
    // Also check nested tool object
    if (!args && item.tool && typeof item.tool === 'object') {
      const toolObj = item.tool as any;
      args = toolObj.arguments ?? toolObj.args ?? toolObj.input ?? null;
    }
  }

  // Extract result/output for completed items
  const isCompleted = eventType === 'item.completed';
  let result: any = null;
  if (isCompleted) {
    result = item.result ?? item.output ?? item.aggregated_output ?? null;
  }

  // Get item ID and tool use ID
  const itemId = typeof item.id === 'string' ? item.id : null;
  const toolUseId = extractSyntheticEditGroupId(rawMetadata)
    ?? (typeof item.tool_use_id === 'string' ? item.tool_use_id :
      typeof item.id === 'string' ? item.id : null);

  windows.push({
    messageId,
    messageCreatedAt: createdAt.getTime(),
    sessionId,
    toolName,
    toolCallItemId: itemId,
    toolUseId,
    argsText: stringifyArgs(args),
    outputText: stringifyOutput(result),
    args,
    isCompleted,
  });

  return windows;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface MatchCandidate {
  window: ToolCallWindow;
  score: number;
  reasons: string[];
}

/** Exported for testing */
/**
 * Load ToolCallWindow[] for a single session by parsing raw ai_agent_messages.
 *
 * We query ai_agent_messages (the raw log) instead of ai_transcript_events (the
 * canonical view) because the linkage table ai_tool_call_file_edits has a FK to
 * ai_agent_messages.id. Canonical event IDs are local-only derived values that
 * change when events are regenerated, so they cannot be used for stable linkage.
 */
export async function getRawToolCallWindows(
  sessionId: string,
  workspacePath?: string,
  options?: { afterDate?: Date; beforeDate?: Date },
): Promise<ToolCallWindow[]> {
  try {
    const conditions = [
      'session_id = $1',
      "direction = 'output'",
      'hidden = FALSE',
    ];
    const params: any[] = [sessionId];
    let paramIdx = 2;

    if (options?.afterDate) {
      conditions.push(`(EXTRACT(EPOCH FROM created_at) * 1000) >= $${paramIdx}`);
      params.push(options.afterDate.getTime());
      paramIdx++;
    }
    if (options?.beforeDate) {
      conditions.push(`(EXTRACT(EPOCH FROM created_at) * 1000) <= $${paramIdx}`);
      params.push(options.beforeDate.getTime());
      paramIdx++;
    }

    const messagesResult = await database.query<AgentMessageRow>(
      `SELECT id, content, metadata, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
       FROM ai_agent_messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY id ASC`,
      params,
    );

    const windows: ToolCallWindow[] = [];
    for (const msg of messagesResult.rows) {
      const msgWindows = parseToolCallWindows(
        ensureNumber(msg.id),
        msg.content,
        new Date(ensureNumber(msg.created_at_ms)),
        sessionId,
        workspacePath,
        msg.metadata,
      );
      windows.push(...msgWindows);
    }
    return windows;
  } catch (error) {
    logger.main.warn('[ToolCallMatcher] Failed to read raw tool call windows:', error);
    return [];
  }
}

/**
 * Batch version: load ToolCallWindow[] for multiple sessions from raw ai_agent_messages.
 */
async function getRawToolCallWindowsMultiSession(
  sessionIds: string[],
  options?: { afterDate?: Date; beforeDate?: Date },
): Promise<Map<string, ToolCallWindow[]>> {
  try {
    if (sessionIds.length === 0) return new Map();

    const conditions = [
      'session_id = ANY($1::text[])',
      "direction = 'output'",
      'hidden = FALSE',
    ];
    const params: any[] = [sessionIds];
    let paramIdx = 2;

    if (options?.afterDate) {
      conditions.push(`(EXTRACT(EPOCH FROM created_at) * 1000) >= $${paramIdx}`);
      params.push(options.afterDate.getTime());
      paramIdx++;
    }
    if (options?.beforeDate) {
      conditions.push(`(EXTRACT(EPOCH FROM created_at) * 1000) <= $${paramIdx}`);
      params.push(options.beforeDate.getTime());
      paramIdx++;
    }

    const messagesResult = await database.query<AgentMessageRow & { session_id: string }>(
      `SELECT session_id, id, content, metadata, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
       FROM ai_agent_messages
       WHERE ${conditions.join(' AND ')}
       ORDER BY id ASC`,
      params,
    );

    const result = new Map<string, ToolCallWindow[]>();
    for (const msg of messagesResult.rows) {
      const msgWindows = parseToolCallWindows(
        ensureNumber(msg.id),
        msg.content,
        new Date(ensureNumber(msg.created_at_ms)),
        msg.session_id,
        undefined,
        msg.metadata,
      );
      for (const w of msgWindows) {
        let arr = result.get(msg.session_id);
        if (!arr) {
          arr = [];
          result.set(msg.session_id, arr);
        }
        arr.push(w);
      }
    }
    return result;
  } catch (error) {
    logger.main.warn('[ToolCallMatcher] Failed to read raw tool call windows (multi-session):', error);
    return new Map();
  }
}

export function scoreMatch(
  filePath: string,
  fileTimestamp: number,
  window: ToolCallWindow,
  fileMetadataToolUseId?: string,
): MatchCandidate | null {
  let score = 0;
  const reasons: string[] = [];

  // 1. Direct toolUseId match - definitive, bypasses time cutoff.
  //    Only used for providers with unique tool IDs (e.g., Claude Code SDK).
  //    Codex sessions don't store toolUseId in session_files metadata because
  //    Codex reuses item IDs across turns, so this path is never reached for Codex.
  if (fileMetadataToolUseId && window.toolUseId && fileMetadataToolUseId === window.toolUseId) {
    score += 100;
    reasons.push('toolUseId');
    return { window, score, reasons };
  }

  // 2. Time cutoff - hard filter, not a score adjustment.
  //    File edit must be within 10s before tool call start or 10s after tool result end.
  const toolTime = window.messageCreatedAt;
  const timeDiff = Math.abs(fileTimestamp - toolTime);
  if (timeDiff > TIME_CUTOFF_MS) {
    return null; // Outside time window, not a candidate
  }

  // 3. file_change (Codex apply_patch): match file path in the changes array.
  //    Try full path match first, then fall back to basename match for relative paths.
  if (window.toolName === 'file_change' && window.args?.changes) {
    const changes = Array.isArray(window.args.changes) ? window.args.changes : [];
    const normalizedFilePath = path.normalize(filePath);
    const fileBaseName = path.basename(filePath);
    const hasExactMatch = changes.some(
      (c: any) => typeof c.path === 'string' && path.normalize(c.path) === normalizedFilePath
    );
    if (hasExactMatch) {
      score += 40;
      reasons.push('path_in_changes');
    } else {
      // Fall back to basename match (handles relative paths from Codex)
      const hasBaseNameMatch = changes.some(
        (c: any) => typeof c.path === 'string' && path.basename(c.path) === fileBaseName
      );
      if (hasBaseNameMatch) {
        score += 40;
        reasons.push('basename_in_changes');
      }
    }
    return score >= MIN_MATCH_SCORE ? { window, score, reasons } : null;
  }

  // 4. Filename in tool input (arguments) - basename match
  const fileName = path.basename(filePath);
  if (window.argsText.includes(fileName)) {
    score += 40;
    reasons.push('name_in_args');
  }

  // 5. Filename in tool output
  if (window.outputText && window.outputText.includes(fileName)) {
    score += 30;
    reasons.push('name_in_output');
  }

  return { window, score, reasons };
}

function normalizeForContains(value: string): string {
  return path.normalize(value).replace(/\\/g, '/').toLowerCase();
}

function hasPathEvidence(text: string, filePath: string): boolean {
  if (!text) return false;
  const normalizedText = text.replace(/\\/g, '/').toLowerCase();
  const normalizedPath = normalizeForContains(filePath);
  return normalizedText.includes(normalizedPath);
}

function hasBaseNameEvidence(text: string, filePath: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(path.basename(filePath).toLowerCase());
}

/** Exported for unit tests covering workspace-scoped watcher attribution scoring. */
export function scoreWorkspaceFileEdit(
  filePath: string,
  fileTimestamp: number,
  window: ToolCallWindow,
): MatchCandidate | null {
  const reasons: string[] = [];
  let score = 0;

  const timeDiff = Math.abs(fileTimestamp - window.messageCreatedAt);
  if (timeDiff > TIME_CUTOFF_MS) {
    return null;
  }

  // Strong signal: explicit file path in Codex file_change payload.
  if (window.toolName === 'file_change' && Array.isArray(window.args?.changes)) {
    const changes = window.args.changes as Array<{ path?: string }>;
    const normalizedTarget = normalizeForContains(filePath);
    const fileBaseName = path.basename(filePath).toLowerCase();

    if (changes.some(change => typeof change.path === 'string' && normalizeForContains(change.path) === normalizedTarget)) {
      score += 90;
      reasons.push('exact_path_in_changes');
    } else if (changes.some(change => typeof change.path === 'string' && path.basename(change.path).toLowerCase() === fileBaseName)) {
      score += 55;
      reasons.push('basename_in_changes');
    }
  }

  if (hasPathEvidence(window.argsText, filePath)) {
    score += 45;
    reasons.push('exact_path_in_args');
  }
  if (hasPathEvidence(window.outputText, filePath)) {
    score += 40;
    reasons.push('exact_path_in_output');
  }

  if (hasBaseNameEvidence(window.argsText, filePath)) {
    score += 30;
    reasons.push('basename_in_args');
  }
  if (hasBaseNameEvidence(window.outputText, filePath)) {
    score += 25;
    reasons.push('basename_in_output');
  }

  // Bash evidence uses plain command text only - no parser heuristics.
  if (window.toolName === 'Bash' && window.args?.command && typeof window.args.command === 'string') {
    const commandText = window.args.command;
    if (hasPathEvidence(commandText, filePath)) {
      score += 25;
      reasons.push('bash_command_path_text');
    } else if (hasBaseNameEvidence(commandText, filePath)) {
      score += 20;
      reasons.push('bash_command_basename_text');
    }
  }

  if (timeDiff <= 500) {
    score += 20;
    reasons.push('recency_500ms');
  } else if (timeDiff <= 2000) {
    score += 14;
    reasons.push('recency_2s');
  } else if (timeDiff <= 5000) {
    score += 8;
    reasons.push('recency_5s');
  } else {
    score += 2;
    reasons.push('recency_10s');
  }

  return { window, score, reasons };
}

// ---------------------------------------------------------------------------
// ToolCallMatcher class
// ---------------------------------------------------------------------------

class ToolCallMatcherImpl {
  async matchWorkspaceFileEdit(input: WorkspaceFileEditMatchInput): Promise<WorkspaceFileEditMatchResult> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const candidateSessionIds = [...new Set(input.candidateSessionIds.filter(Boolean))];
      if (candidateSessionIds.length === 0) {
        return { winner: null, candidates: [], reason: 'no_active_sessions' };
      }

      const sessionWindows = new Map<string, ToolCallWindow[]>();

      // Load tool call windows from raw ai_agent_messages for all sessions
      const windowStart = input.fileTimestamp - TIME_CUTOFF_MS;
      const windowEnd = input.fileTimestamp + TIME_CUTOFF_MS;
      const batchWindows = await getRawToolCallWindowsMultiSession(candidateSessionIds, {
        afterDate: new Date(windowStart),
        beforeDate: new Date(windowEnd),
      });
      for (const [sessionId, windows] of batchWindows) {
        if (windows.length > 0) {
          sessionWindows.set(sessionId, windows);
        }
      }

      if (sessionWindows.size === 0) {
        return { winner: null, candidates: [], reason: 'no_recent_tool_windows' };
      }

      const bestBySession = new Map<string, WorkspaceFileEditCandidate>();

      for (const sessionId of candidateSessionIds) {
        const windows = sessionWindows.get(sessionId) || [];
        if (windows.length === 0) continue;

        // Canonical events produce one window per tool call (already deduplicated by providerToolCallId).
        // deduplicateWindows is safe to call with empty messages - it groups by toolCallItemId and
        // prefers completed windows, which is correct for canonical events.
        const deduped = this.deduplicateWindows(windows, []);
        for (const window of deduped) {
          const scored = scoreWorkspaceFileEdit(input.filePath, input.fileTimestamp, window);
          if (!scored || scored.score < MIN_MATCH_SCORE) continue;

          const candidate: WorkspaceFileEditCandidate = {
            sessionId,
            messageId: window.messageId,
            toolName: window.toolName,
            toolCallItemId: window.toolCallItemId,
            toolUseId: window.toolUseId,
            score: scored.score,
            reasons: scored.reasons,
            timeDiffMs: Math.abs(input.fileTimestamp - window.messageCreatedAt),
          };
          const previousBest = bestBySession.get(sessionId);
          if (
            !previousBest ||
            candidate.score > previousBest.score ||
            (candidate.score === previousBest.score && candidate.timeDiffMs < previousBest.timeDiffMs)
          ) {
            bestBySession.set(sessionId, candidate);
          }
        }
      }

      const sessionCandidates = [...bestBySession.values()]
        .sort((a, b) => b.score - a.score || a.timeDiffMs - b.timeDiffMs);

      logger.main.debug('[ToolCallMatcher] Workspace attribution candidate scoring:', {
        workspacePath: input.workspacePath,
        filePath: input.filePath,
        fileTimestamp: input.fileTimestamp,
        candidateSessions: candidateSessionIds,
        sessionCandidates: sessionCandidates.slice(0, 6).map(candidate => ({
          sessionId: candidate.sessionId,
          score: candidate.score,
          reasons: candidate.reasons,
          toolName: candidate.toolName,
          messageId: candidate.messageId,
          timeDiffMs: candidate.timeDiffMs,
        })),
      });

      if (sessionCandidates.length === 0) {
        return { winner: null, candidates: [], reason: 'no_candidates' };
      }

      const winner = sessionCandidates[0];
      if (winner.score < WORKSPACE_MIN_CONFIDENCE_SCORE) {
        logger.main.debug('[ToolCallMatcher] Workspace attribution rejected (low confidence):', {
          filePath: input.filePath,
          score: winner.score,
          sessionId: winner.sessionId,
        });
        return { winner: null, candidates: sessionCandidates, reason: 'low_confidence' };
      }

      const runnerUp = sessionCandidates[1];
      if (runnerUp && (winner.score - runnerUp.score) < WORKSPACE_CLEAR_WINNER_MARGIN) {
        logger.main.debug('[ToolCallMatcher] Workspace attribution rejected (ambiguous tie):', {
          filePath: input.filePath,
          winnerSessionId: winner.sessionId,
          winnerScore: winner.score,
          runnerUpSessionId: runnerUp.sessionId,
          runnerUpScore: runnerUp.score,
          scoreDelta: winner.score - runnerUp.score,
        });
        return { winner: null, candidates: sessionCandidates, reason: 'ambiguous' };
      }

      logger.main.debug('[ToolCallMatcher] Workspace attribution winner selected:', {
        filePath: input.filePath,
        sessionId: winner.sessionId,
        score: winner.score,
        reasons: winner.reasons,
        messageId: winner.messageId,
      });

      return { winner, candidates: sessionCandidates, reason: 'winner_selected' };
    } catch (error) {
      logger.main.error('[ToolCallMatcher] matchWorkspaceFileEdit failed:', error);
      return { winner: null, candidates: [], reason: 'matcher_error' };
    }
  }

  /**
   * Match all unmatched session_files entries for a session.
   * Returns the number of new matches created.
   */
  async matchSession(sessionId: string): Promise<number> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      // 1. Get workspace path from session metadata (fallback to file path heuristic)
      const sessionInfo = await database.query<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM ai_sessions WHERE id = $1 LIMIT 1`,
        [sessionId]
      );
      const workspacePath = sessionInfo.rows[0]?.workspace_id || undefined;

      // 2. Load edited session_files
      // Use EXTRACT(EPOCH) to get correct epoch ms regardless of
      // timestamp column timezone type (avoids PGLite tz interpretation bug
      // where "timestamp without time zone" values get a phantom offset).
      const filesResult = await database.query<SessionFileRow>(
        `SELECT id, file_path, EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp_ms, metadata
         FROM session_files
         WHERE session_id = $1 AND link_type = 'edited'`,
        [sessionId]
      );
      // Deduplicate session_files: keep every row with a distinct toolUseId
      // (each represents a separate tool call edit). For rows WITHOUT a
      // toolUseId (Codex, watcher side-effects), dedup by file path keeping
      // the most recent timestamp.
      const sessionFilesByKey = new Map<string, SessionFileRow>();
      for (const file of filesResult.rows) {
        const toolUseId = file.metadata?.toolUseId;
        if (toolUseId) {
          // Rows with a toolUseId are unique per tool call — keep all of them.
          // Use toolUseId as key so duplicates from watcher + tracker collapse.
          const key = `${file.file_path}::${toolUseId}`;
          const existing = sessionFilesByKey.get(key);
          if (!existing || ensureNumber(file.timestamp_ms) > ensureNumber(existing.timestamp_ms)) {
            sessionFilesByKey.set(key, file);
          }
        } else {
          // No toolUseId (Codex): dedup by file path, keep most recent
          const key = `no-tool::${file.file_path}`;
          const existing = sessionFilesByKey.get(key);
          if (!existing || ensureNumber(file.timestamp_ms) > ensureNumber(existing.timestamp_ms)) {
            sessionFilesByKey.set(key, file);
          }
        }
      }
      const sessionFiles = [...sessionFilesByKey.values()];

      // A session with no edited files cannot produce a match, so avoid the
      // raw-message scan entirely.
      if (sessionFiles.length === 0) return 0;

      // Bound raw history for providers whose file rows have no definitive
      // tool IDs (notably Codex). Exact metadata toolUseId matches deliberately
      // bypass scoreMatch's time cutoff, so sessions carrying any such ID must
      // retain the unbounded lookup to preserve those matches.
      const hasDefinitiveToolUseIds = sessionFiles.some(file =>
        typeof file.metadata?.toolUseId === 'string' && file.metadata.toolUseId.length > 0
      );
      let rawWindowOptions: { afterDate: Date; beforeDate: Date } | undefined;
      if (!hasDefinitiveToolUseIds) {
        const fileTimestamps = sessionFiles.map(file => ensureNumber(file.timestamp_ms));
        const hasInvalidTimestamp = fileTimestamps.some(timestamp => !Number.isFinite(timestamp));
        let minFileTs = Infinity;
        let maxFileTs = -Infinity;
        for (const timestamp of fileTimestamps) {
          if (timestamp < minFileTs) minFileTs = timestamp;
          if (timestamp > maxFileTs) maxFileTs = timestamp;
        }
        if (!hasInvalidTimestamp) {
          rawWindowOptions = {
            afterDate: new Date(minFileTs - TIME_CUTOFF_MS),
            beforeDate: new Date(maxFileTs + TIME_CUTOFF_MS),
          };
        }
      }

      // 3. Load tool call windows from raw ai_agent_messages.
      const windows = await getRawToolCallWindows(sessionId, workspacePath, rawWindowOptions);

      if (windows.length === 0) return 0;

      // 4. Deduplicate windows by toolCallItemId.
      // When both item.started and item.completed exist for the same tool call,
      // merge into one window preferring item.completed data (has output/result).
      // When only item.started exists but the session continued (later messages exist),
      // treat it as implicitly closed — a valid match candidate.
      // Canonical events produce one window per tool call (already deduplicated by providerToolCallId).
      // deduplicateWindows is safe to call with empty messages - it groups by toolCallItemId and
      // prefers completed windows, which is correct for canonical events.
      const deduped = this.deduplicateWindows(windows, []);
      logger.main.debug('[ToolCallMatcher] Loaded match inputs:', {
        sessionId,
        sessionFileCount: sessionFiles.length,
        toolWindowCount: deduped.length,
      });

      // 6. Load existing matches so we can skip unchanged files and replace stale ones
      const existingResult = await database.query<{
        session_file_id: string;
        match_score: number;
        tool_use_id: string | null;
      }>(
        `SELECT session_file_id, match_score, tool_use_id FROM ai_tool_call_file_edits WHERE session_id = $1`,
        [sessionId]
      );
      // Best existing score per file (a file may have multiple rows from legacy data)
      const existingBestScore = new Map<string, number>();
      for (const row of existingResult.rows) {
        const prev = existingBestScore.get(row.session_file_id) ?? 0;
        existingBestScore.set(row.session_file_id, Math.max(prev, ensureNumber(row.match_score)));
      }

      // 7. Match each file, replacing old matches when a better one is found
      const matches: Array<{
        sessionId: string;
        sessionFileId: string;
        messageId: number;
        toolCallItemId: string | null;
        toolUseId: string | null;
        score: number;
        reason: string;
        fileTimestamp: number;
      }> = [];

      // Track file IDs where a new match replaces an old one
      const replacedFileIds: string[] = [];

      for (const file of sessionFiles) {
        const metadataToolUseId = file.metadata?.toolUseId;
        const fileTimestamp = ensureNumber(file.timestamp_ms);

        // Score against deduplicated windows (scoreMatch returns null for time-cutoff failures)
        const candidates = deduped
          .map(w => scoreMatch(file.file_path, fileTimestamp, w, metadataToolUseId))
          .filter((c): c is MatchCandidate => c !== null && c.score >= MIN_MATCH_SCORE);

        if (candidates.length === 0) {
          logger.main.debug('[ToolCallMatcher] No candidates for file edit:', {
            sessionId,
            sessionFileId: file.id,
            filePath: file.file_path,
            fileTimestamp,
            metadataToolUseId: metadataToolUseId ?? null,
          });
        } else {
          const topCandidates = [...candidates]
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(c => ({
              score: c.score,
              reasons: c.reasons,
              toolName: c.window.toolName,
              toolCallItemId: c.window.toolCallItemId,
              messageId: c.window.messageId,
              toolTimestamp: c.window.messageCreatedAt,
            }));
          logger.main.debug('[ToolCallMatcher] Candidate matches for file edit:', {
            sessionId,
            sessionFileId: file.id,
            filePath: file.file_path,
            fileTimestamp,
            metadataToolUseId: metadataToolUseId ?? null,
            topCandidates,
          });
        }

        // Pick the best match
        const best = candidates.sort((a, b) => b.score - a.score)[0];
        if (!best) continue;

        logger.main.debug('[ToolCallMatcher] Selected best candidate for file edit:', {
          sessionId,
          sessionFileId: file.id,
          filePath: file.file_path,
          score: best.score,
          reasons: best.reasons,
          toolName: best.window.toolName,
          toolCallItemId: best.window.toolCallItemId,
          messageId: best.window.messageId,
        });

        const previousScore = existingBestScore.get(file.id);
        if (previousScore != null) {
          // Already matched — only replace if the new match is strictly better
          if (best.score <= previousScore) {
            logger.main.debug('[ToolCallMatcher] Keeping existing match (new score not higher):', {
              sessionId,
              sessionFileId: file.id,
              filePath: file.file_path,
              previousScore,
              newScore: best.score,
            });
            continue;
          }
          logger.main.debug('[ToolCallMatcher] Replacing existing match with higher score:', {
            sessionId,
            sessionFileId: file.id,
            filePath: file.file_path,
            previousScore,
            newScore: best.score,
          });
          replacedFileIds.push(file.id);
        }

        matches.push({
          sessionId,
          sessionFileId: file.id,
          messageId: best.window.messageId,
          toolCallItemId: best.window.toolCallItemId,
          toolUseId: best.window.toolUseId,
          score: best.score,
          reason: `${best.reasons.join(',')}|score=${best.score}|tool=${best.window.toolName}`,
          fileTimestamp,
        });
      }

      // Remove old matches that are being replaced by better ones
      if (replacedFileIds.length > 0) {
        await database.query(
          `DELETE FROM ai_tool_call_file_edits
           WHERE session_id = $1 AND session_file_id = ANY($2)`,
          [sessionId, replacedFileIds]
        );
        logger.main.debug(`[ToolCallMatcher] Replaced ${replacedFileIds.length} matches with better ones`);
      }

      if (matches.length > 0) {
        await this.insertMatchesBatch(matches);
        logger.main.debug(`[ToolCallMatcher] Matched ${matches.length} files for session ${sessionId}`);
      }

      // Clean up provisional bash side-effect entries that didn't match any tool call.
      // When multiple sessions share a workspace, each creates a provisional entry
      // for file changes detected by the watcher. Only the session whose tool call
      // actually matches should keep the entry — delete the rest.
      const matchedFileIds = new Set([
        ...matches.map(m => m.sessionFileId),
        ...existingBestScore.keys(),
      ]);
      const orphanedBashSideEffects = sessionFiles
        .filter(f => f.metadata?.bashSideEffect === true && !matchedFileIds.has(f.id));
      if (orphanedBashSideEffects.length > 0) {
        const orphanIds = orphanedBashSideEffects.map(f => f.id);
        await database.query(
          `DELETE FROM session_files WHERE id = ANY($1)`,
          [orphanIds]
        );
        logger.main.debug(`[ToolCallMatcher] Removed ${orphanIds.length} unmatched bash side-effect entries`);
      }

      return matches.length;
    } catch (error) {
      logger.main.error('[ToolCallMatcher] matchSession failed:', error);
      return 0;
    }
  }

  /**
   * Get all matches for a session.
   */
  async getMatchesForSession(sessionId: string): Promise<ToolCallFileEdit[]> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<ToolCallMatchRow>(
        `SELECT id, session_id, session_file_id, message_id,
                tool_call_item_id, tool_use_id, match_score, match_reason, file_timestamp, created_at
         FROM ai_tool_call_file_edits
         WHERE session_id = $1
         ORDER BY id ASC`,
        [sessionId]
      );

      return result.rows.map(row => this.mapRowToToolCallFileEdit(row));
    } catch (error) {
      logger.main.error('[ToolCallMatcher] getMatchesForSession failed:', error);
      return [];
    }
  }

  /**
   * Get match for a specific session file.
   */
  async getMatchForFile(sessionFileId: string): Promise<ToolCallFileEdit | null> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const result = await database.query<ToolCallMatchRow>(
        `SELECT id, session_id, session_file_id, message_id,
                tool_call_item_id, tool_use_id, match_score, match_reason, file_timestamp, created_at
         FROM ai_tool_call_file_edits
         WHERE session_file_id = $1
         LIMIT 1`,
        [sessionFileId]
      );

      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      return this.mapRowToToolCallFileEdit(row);
    } catch (error) {
      logger.main.error('[ToolCallMatcher] getMatchForFile failed:', error);
      return null;
    }
  }

  /** NUL-separated composite key (path/id components may contain spaces). */
  private preEditKey(filePath: string, toolUseId: string): string {
    return `${filePath}\u0000${toolUseId}`;
  }

  /**
   * Load, in a fixed number of queries, everything the per-tool-call diff
   * resolution needs for an entire session. Pass the returned context to
   * getDiffsForToolCall to avoid the N+1 fan-out (see SessionEnrichmentContext).
   */
  async createSessionEnrichmentContext(sessionId: string): Promise<SessionEnrichmentContext> {
    if (!database.isInitialized()) {
      await database.initialize();
    }

    const ctx: SessionEnrichmentContext = {
      sessionId,
      workspaceId: undefined,
      provider: 'unknown',
      editedByToolUseId: new Map(),
      sessionFilesById: new Map(),
      toolEditsByItemId: new Map(),
      preEditByFileAndTool: new Map(),
      preEditLatestByFile: new Map(),
      postEditByFileAndTool: new Map(),
      diskContentCache: new Map(),
    };

    // 1. Workspace path + provider (session-invariant, formerly fetched per call).
    const sessionRow = await database.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM ai_sessions WHERE id = $1`,
      [sessionId]
    );
    ctx.workspaceId = sessionRow.rows[0]?.workspace_id;
    try {
      const session = await AISessionsRepository.get(sessionId);
      if (session?.provider) ctx.provider = session.provider;
    } catch {
      // Provider only affects canonical-event lookup; default 'unknown' is fine.
    }

    // 2. All `edited` session_files for the session, grouped by toolUseId and by id.
    const editedResult = await database.query<{ id: string; file_path: string; timestamp_ms: number; metadata: any }>(
      `SELECT id, file_path, EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp_ms, metadata
       FROM session_files
       WHERE session_id = $1 AND link_type = 'edited'`,
      [sessionId]
    );
    for (const row of editedResult.rows) {
      const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
      ctx.sessionFilesById.set(row.id, { file_path: row.file_path, metadata });
      const toolUseId = metadata?.toolUseId;
      if (typeof toolUseId === 'string' && toolUseId.length > 0) {
        const list = ctx.editedByToolUseId.get(toolUseId) ?? [];
        list.push({ id: row.id, file_path: row.file_path, timestamp_ms: ensureNumber(row.timestamp_ms), metadata });
        ctx.editedByToolUseId.set(toolUseId, list);
      }
    }

    // 3. All tool-call file-edit matches, grouped by tool_call_item_id.
    const matchRows = await database.query<ToolCallMatchRow>(
      `SELECT id, session_id, session_file_id, message_id,
              tool_call_item_id, tool_use_id, match_score, match_reason, file_timestamp, created_at
       FROM ai_tool_call_file_edits
       WHERE session_id = $1
       ORDER BY id ASC`,
      [sessionId]
    );
    for (const row of matchRows.rows) {
      const itemId = row.tool_call_item_id;
      if (!itemId) continue;
      const list = ctx.toolEditsByItemId.get(itemId) ?? [];
      list.push(row);
      ctx.toolEditsByItemId.set(itemId, list);
    }

    // 4. All pre/post-edit history snapshots for the session (content is compressed;
    //    bounded by distinct edits, decompressed lazily per file in computeHistoryDiff).
    //    SQLite must use json_extract (matching idx_history_preedit_session, migration
    //    18) -- writing metadata->>'x' makes the dialect translator parameterize the
    //    JSON key as metadata->>?, which no expression index can match. PGLite needs
    //    the ->> operator (its metadata is jsonb; json_extract has no jsonb overload).
    //    Same split as HistoryManager.getPendingFilesForSession.
    const isSqlite = database.getEngine() === 'sqlite';
    const sessionIdExpr = isSqlite ? `json_extract(metadata, '$.sessionId')` : `metadata->>'sessionId'`;
    const typeExpr = isSqlite ? `json_extract(metadata, '$.type')` : `metadata->>'type'`;
    const toolUseIdExpr = isSqlite ? `json_extract(metadata, '$.toolUseId')` : `metadata->>'toolUseId'`;
    const historyResult = await database.query<{
      file_path: string;
      content: Buffer;
      tool_use_id: string | null;
      snapshot_type: 'pre-edit' | 'ai-edit';
    }>(
      `SELECT file_path, content, ${toolUseIdExpr} AS tool_use_id, ${typeExpr} AS snapshot_type
       FROM document_history
       WHERE ${sessionIdExpr} = $1 AND ${typeExpr} IN ('pre-edit', 'ai-edit')
       ORDER BY timestamp DESC`,
      [sessionId]
    );
    for (const row of historyResult.rows) {
      if (row.snapshot_type === 'ai-edit') {
        if (row.tool_use_id) {
          const key = this.preEditKey(row.file_path, row.tool_use_id);
          if (!ctx.postEditByFileAndTool.has(key)) {
            ctx.postEditByFileAndTool.set(key, row.content);
          }
        }
        continue;
      }
      // Rows are newest-first; keep the first (latest) seen for each key.
      if (!ctx.preEditLatestByFile.has(row.file_path)) {
        ctx.preEditLatestByFile.set(row.file_path, row.content);
      }
      if (row.tool_use_id) {
        const key = this.preEditKey(row.file_path, row.tool_use_id);
        if (!ctx.preEditByFileAndTool.has(key)) {
          ctx.preEditByFileAndTool.set(key, row.content);
        }
      }
    }

    return ctx;
  }

  /**
   * Batched entry point for transcript enrichment: resolve diffs for many tool
   * calls in one session while loading session-invariant data only once.
   * Returns a map keyed by `${toolCallItemId} ${timestamp}` (NUL-separated).
   */
  async getDiffsForSession(
    sessionId: string,
    refs: Array<{ toolCallItemId: string; toolCallTimestamp?: number }>
  ): Promise<Map<string, ToolCallDiffResult[]>> {
    const out = new Map<string, ToolCallDiffResult[]>();
    if (refs.length === 0) return out;

    let ctx: SessionEnrichmentContext | undefined;
    try {
      ctx = await this.createSessionEnrichmentContext(sessionId);
    } catch (error) {
      logger.main.warn('[ToolCallMatcher] createSessionEnrichmentContext failed, falling back to per-call queries:', error);
      ctx = undefined;
    }

    for (const ref of refs) {
      const key = `${ref.toolCallItemId} ${ref.toolCallTimestamp ?? ''}`;
      if (out.has(key)) continue;
      try {
        out.set(key, await this.getDiffsForToolCall(sessionId, ref.toolCallItemId, ref.toolCallTimestamp, ctx));
      } catch (error) {
        logger.main.error('[ToolCallMatcher] getDiffsForSession item failed:', error);
        out.set(key, []);
      }
    }

    return out;
  }

  // Tool-call diffs are immutable once the tool has finished: the inputs are
  // the historical ai_agent_messages content and the post-edit session_files
  // metadata. Without dedup, every AsyncEditToolResultCard mount on the
  // transcript fires its own 4-query lookup -- a session with 20 edit cards
  // pegs the SQLite worker as the cards all mount in parallel. Cache the
  // result by (sessionId, toolCallItemId, timestamp) and dedup in-flight
  // requests so N concurrent callers share one query.
  private diffCache = new Map<string, ToolCallDiffResult[]>();
  private diffInFlight = new Map<string, Promise<ToolCallDiffResult[]>>();
  private readonly DIFF_CACHE_MAX_ENTRIES = 500;

  private diffCacheKey(sessionId: string, toolCallItemId: string, ts?: number): string {
    return `${sessionId}\u0000${toolCallItemId}\u0000${ts ?? ''}`;
  }

  /** Invalidate cached diffs for a session (e.g. when its messages are mutated). */
  invalidateDiffCacheForSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.diffCache.keys()) {
      if (key.startsWith(prefix)) this.diffCache.delete(key);
    }
  }

  /**
   * Get file diffs caused by a specific tool call.
   * Looks up matches by tool_call_item_id, then extracts diff data from
   * the raw ai_agent_messages content (tool arguments).
   */
  async getDiffsForToolCall(
    sessionId: string,
    toolCallItemId: string,
    toolCallTimestamp?: number,
    ctx?: SessionEnrichmentContext
  ): Promise<ToolCallDiffResult[]> {
    const cacheKey = this.diffCacheKey(sessionId, toolCallItemId, toolCallTimestamp);
    const cached = this.diffCache.get(cacheKey);
    if (cached) return cached;
    const inFlight = this.diffInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = this.computeDiffsForToolCall(sessionId, toolCallItemId, toolCallTimestamp, ctx);
    this.diffInFlight.set(cacheKey, promise);
    try {
      const result = await promise;
      // Exact pre/post snapshots are immutable. Legacy current-disk fallback
      // is not, so retaining it would make later file changes appear frozen.
      if (!result.some((item) => item.historySource === 'history-disk-fallback')) {
        // Cap the cache to avoid unbounded growth in long-lived sessions.
        if (this.diffCache.size >= this.DIFF_CACHE_MAX_ENTRIES) {
          const firstKey = this.diffCache.keys().next().value;
          if (firstKey !== undefined) this.diffCache.delete(firstKey);
        }
        this.diffCache.set(cacheKey, result);
      }
      return result;
    } finally {
      this.diffInFlight.delete(cacheKey);
    }
  }

  async getDiffsForToolCallResult(
    sessionId: string,
    toolCallItemId: string,
    toolCallTimestamp?: number,
  ): Promise<ToolCallDiffLoadResult> {
    const raw = await this.getDiffsForToolCall(sessionId, toolCallItemId, toolCallTimestamp);
    const diffs = raw.filter((item) =>
      !item.omissionReason &&
      !item.errorCode &&
      (item.diffs.length > 0 || !!item.content),
    );
    const omissions = raw
      .filter((item): item is ToolCallDiffResult & { omissionReason: HistoryDiffOmissionReason } => !!item.omissionReason)
      .map((item) => ({
        filePath: item.filePath,
        reason: item.omissionReason,
        inputBytes: item.inputBytes,
        limitBytes: item.limitBytes,
      }));
    const failed = raw.find((item) => item.errorCode);

    if (failed?.errorCode && diffs.length === 0 && omissions.length === 0) {
      return { state: 'failed', diffs: [], omissions: [], errorCode: failed.errorCode };
    }
    if (diffs.length > 0 && (omissions.length > 0 || failed)) {
      return { state: 'partial', diffs, omissions, errorCode: failed?.errorCode };
    }
    if (diffs.length > 0) return { state: 'ready', diffs, omissions: [] };
    if (omissions.length > 0) return { state: 'partial', diffs: [], omissions };
    return { state: 'none', diffs: [], omissions: [] };
  }

  private async computeDiffsForToolCall(
    sessionId: string,
    toolCallItemId: string,
    toolCallTimestamp?: number,
    ctx?: SessionEnrichmentContext
  ): Promise<ToolCallDiffResult[]> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      const lookup = parseToolCallLookupId(toolCallItemId, toolCallTimestamp);

      // Pass both forms to the content lookup. session_files.metadata.toolUseId
      // is the synthetic `nimtc|...` ID for Codex sessions written after the
      // Phase 1.5 streaming wiring; legacy rows persisted the raw item id. The
      // helper queries on either form so reading historical sessions still
      // works.
      const directDiffs = await this.getDiffsFromToolCallContent(
        sessionId,
        toolCallItemId,
        lookup.toolCallItemId,
        lookup.toolCallTimestamp,
        ctx
      );
      if (directDiffs.length > 0) {
        return directDiffs;
      }

      // 1. Find matches for this tool call. With a session context, all
      // ai_tool_call_file_edits rows were loaded once and grouped by item id.
      let matchRows: Array<{ session_file_id: string; message_id: number; match_reason: string }>;
      if (ctx) {
        const grouped = ctx.toolEditsByItemId.get(lookup.toolCallItemId) ?? [];
        if (grouped.length === 0) return [];
        // Latest message wins (matches the ORDER BY created_at DESC LIMIT 1 below).
        let latestMessageId = -Infinity;
        for (const row of grouped) {
          const mid = ensureNumber(row.message_id);
          if (mid > latestMessageId) latestMessageId = mid;
        }
        matchRows = grouped
          .filter(row => ensureNumber(row.message_id) === latestMessageId)
          .map(row => ({ session_file_id: row.session_file_id, message_id: row.message_id, match_reason: row.match_reason }));
      } else {
        const latestMessageResult = await database.query<{
            message_id: number;
          }>(
            `SELECT message_id
             FROM ai_tool_call_file_edits
             WHERE session_id = $1 AND tool_call_item_id = $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [sessionId, lookup.toolCallItemId]
          );

        if (latestMessageResult.rows.length === 0) return [];

        const latestMessageId = ensureNumber(latestMessageResult.rows[0].message_id);

        const matchResult = await database.query<{
          session_file_id: string;
          message_id: number;
          match_reason: string;
        }>(
          `SELECT session_file_id, message_id, match_reason
           FROM ai_tool_call_file_edits
           WHERE session_id = $1 AND tool_call_item_id = $2 AND message_id = $3`,
          [sessionId, lookup.toolCallItemId, latestMessageId]
        );
        matchRows = matchResult.rows;
      }

      if (matchRows.length === 0) return [];

      // 2. Get session_files metadata for each match
      const fileIds = matchRows.map(r => r.session_file_id);
      const filesById = new Map<string, { filePath: string; metadata: any }>();
      if (ctx) {
        for (const id of fileIds) {
          const info = ctx.sessionFilesById.get(id);
          if (info) filesById.set(id, { filePath: info.file_path, metadata: info.metadata });
        }
      } else {
        const filesResult = await database.query<{
          id: string;
          file_path: string;
          metadata: any;
        }>(
          `SELECT id, file_path, metadata
           FROM session_files
           WHERE id = ANY($1)`,
          [fileIds]
        );

        for (const row of filesResult.rows) {
          filesById.set(row.id, {
            filePath: row.file_path,
            metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
          });
        }
      }

      // 3. Try canonical event for the specific tool call, fall back to raw messages.
      // Phase 3 of canonical-transcript-deprecation: canonical events live in
      // TranscriptRuntime's in-memory cache instead of a persisted store. The
      // runtime resolves the per-session cache and rebuilds from raw on miss.
      let canonicalPayload: ToolCallPayload | null = null;
      try {
        if (TranscriptMigrationRepository.hasService() && lookup.toolCallItemId) {
          const runtime = TranscriptMigrationRepository.getService();
          const provider = ctx?.provider ?? (await AISessionsRepository.get(sessionId))?.provider ?? 'unknown';
          const event = await runtime.findToolCallByProviderId(sessionId, lookup.toolCallItemId, provider);
          if (event) {
            canonicalPayload = event.payload as unknown as ToolCallPayload;
          }
        }
      } catch (canonicalError) {
        logger.main.warn('[ToolCallMatcher] Failed to load canonical event for diffs, falling back to raw:', canonicalError);
      }

      // 4. Build diff results
      const results: ToolCallDiffResult[] = [];

      for (const match of matchRows) {
        const fileInfo = filesById.get(match.session_file_id);
        if (!fileInfo) continue;

        const msgId = ensureNumber(match.message_id);
        const operation = fileInfo.metadata?.operation || 'edit';
        const debug: string[] = [`match: ${match.match_reason}`];

        const diffResult: ToolCallDiffResult = {
          filePath: fileInfo.filePath,
          operation,
          diffs: [],
          linesAdded: fileInfo.metadata?.linesAdded,
          linesRemoved: fileInfo.metadata?.linesRemoved,
        };

        // Try canonical payload first
        let extracted: { diffs: Array<{ oldString: string; newString: string }>; content?: string } | null = null;
        if (canonicalPayload) {
          extracted = this.extractDiffsFromCanonicalPayload(canonicalPayload, fileInfo.filePath);
          if (extracted && (extracted.diffs.length > 0 || extracted.content)) {
            debug.push('diff: canonical');
          }
        }

        if (!extracted || (extracted.diffs.length === 0 && !extracted.content)) {
          debug.push('diff: no canonical payload found');
        }

        if (extracted) {
          if (extracted.diffs.length > 0) {
            diffResult.diffs = extracted.diffs;
          } else if (extracted.content) {
            diffResult.content = extracted.content;
          }
          if (diffResult.linesAdded == null && diffResult.linesRemoved == null) {
            let added = 0;
            let removed = 0;
            for (const diff of extracted.diffs) {
              if (diff.newString) added += countLines(diff.newString);
              if (diff.oldString) removed += countLines(diff.oldString);
            }
            if (extracted.content) {
              added += countLines(extracted.content);
            }
            if (added > 0) diffResult.linesAdded = added;
            if (removed > 0) diffResult.linesRemoved = removed;
          }
        }

        diffResult.debugInfo = debug.join(' | ');
        results.push(diffResult);
      }

      // Fallback for entries with no extractable diff data:
      // Use history snapshot (before-content from file watcher vs current file on disk)
      for (const result of results) {
        if (result.diffs.length === 0 && !result.content) {
          const historyDiff = await this.computeHistoryDiff(sessionId, result.filePath, lookup.toolCallItemId, ctx);
          if (historyDiff) {
            applyHistoryDiffOutcome(result, historyDiff);
            result.debugInfo += ` | diff: ${historyDiff.status} ${historyDiff.source}`;
          } else {
            result.debugInfo += ' | diff: no history snapshot found';
          }
        }
      }

      return results;
    } catch (error) {
      logger.main.error('[ToolCallMatcher] getDiffsForToolCall failed:', error);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Deduplicate tool call windows by toolCallItemId.
   *
   * When both item.started and item.completed messages exist for the same
   * tool call, merge them into a single window using the completed message's
   * data (which has result/output). When only item.started exists but
   * subsequent messages prove the session continued past it, keep the window
   * as a valid match candidate (implicitly closed).
   *
   * Windows without a toolCallItemId (null) are kept as-is since they can't
   * be deduplicated.
   */
  private deduplicateWindows(windows: ToolCallWindow[], allMessages: AgentMessageRow[]): ToolCallWindow[] {
    // Find the latest message timestamp to determine if subsequent messages exist
    const latestMessageMs = allMessages.length > 0
      ? Math.max(...allMessages.map(m => ensureNumber(m.created_at_ms)))
      : 0;

    // Group windows by toolCallItemId
    const byItemId = new Map<string, ToolCallWindow[]>();
    const noItemId: ToolCallWindow[] = [];

    for (const w of windows) {
      if (w.toolCallItemId) {
        const existing = byItemId.get(w.toolCallItemId);
        if (existing) {
          existing.push(w);
        } else {
          byItemId.set(w.toolCallItemId, [w]);
        }
      } else {
        noItemId.push(w);
      }
    }

    const result: ToolCallWindow[] = [...noItemId];

    for (const group of byItemId.values()) {
      // Prefer the item.completed window (has output/result data)
      const completed = group.find(w => w.isCompleted);
      if (completed) {
        // Merge: use completed window but ensure args from started are available
        // (in case completed has fewer args — unlikely but defensive)
        const started = group.find(w => !w.isCompleted);
        if (started && !completed.argsText && started.argsText) {
          completed.argsText = started.argsText;
          completed.args = started.args;
        }
        result.push(completed);
      } else {
        // Only item.started exists — treat as implicitly closed if the session
        // continued past this tool call (subsequent messages exist)
        const best = group[0];
        const hasSubsequentMessages = latestMessageMs > best.messageCreatedAt;
        if (hasSubsequentMessages) {
          // Implicitly closed: session continued, so this tool call finished
          // even though we never got item.completed
          result.push(best);
        } else {
          // Tool call is the latest message — may still be running.
          // Still include it for matching since file edits may already exist.
          result.push(best);
        }
      }
    }

    if (result.length < windows.length) {
      logger.main.debug(
        `[ToolCallMatcher] Deduplicated ${windows.length} windows to ${result.length} (${windows.length - result.length} started+completed merged)`
      );
    }

    return result;
  }

  /**
   * Map a database row to a ToolCallFileEdit object.
   */
  private mapRowToToolCallFileEdit(row: ToolCallMatchRow): ToolCallFileEdit {
    return {
      id: ensureNumber(row.id),
      sessionId: row.session_id,
      sessionFileId: row.session_file_id,
      messageId: ensureNumber(row.message_id),
      toolCallItemId: row.tool_call_item_id,
      toolUseId: row.tool_use_id,
      matchScore: ensureNumber(row.match_score),
      matchReason: row.match_reason || '',
      fileTimestamp: row.file_timestamp ? (row.file_timestamp instanceof Date ? row.file_timestamp : new Date(row.file_timestamp)) : null,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }

  /**
   * Extract diff data from a canonical ToolCallPayload.
   * Reads the structured arguments directly without JSON parsing.
   */
  private extractDiffsFromCanonicalPayload(
    payload: ToolCallPayload,
    targetFilePath: string
  ): { diffs: Array<{ oldString: string; newString: string }>; content?: string } {
    const args = payload.arguments;
    if (!args || typeof args !== 'object') return { diffs: [] };

    // Check if this tool call targets the right file
    const toolFilePath = (args as any).file_path || (args as any).filePath || (args as any).path || (args as any).notebook_path;
    if (toolFilePath && typeof toolFilePath === 'string') {
      const normalizedTool = path.normalize(toolFilePath);
      const normalizedTarget = path.normalize(targetFilePath);
      if (normalizedTool !== normalizedTarget) {
        return { diffs: [] };
      }
    }

    // file_change: check for content in changes array
    if (payload.changes && Array.isArray(payload.changes)) {
      for (const change of payload.changes) {
        if (change.path === targetFilePath && typeof (change as any).content === 'string') {
          return { diffs: [], content: (change as any).content };
        }
      }
    }

    // Extract Edit-style diffs (old_string / new_string)
    if ((args as any).old_string !== undefined || (args as any).new_string !== undefined) {
      return {
        diffs: [{
          oldString: (args as any).old_string || '',
          newString: (args as any).new_string || '',
        }],
      };
    }

    // Extract Write-style content (full file creation)
    if (typeof (args as any).content === 'string' && (args as any).content.length > 0) {
      return { diffs: [], content: (args as any).content };
    }

    // Multi-edit: replacements array
    if (Array.isArray((args as any).replacements)) {
      const diffs = (args as any).replacements
        .filter((r: any) => r && (r.oldText || r.old_text || r.newText || r.new_text))
        .map((r: any) => ({
          oldString: r.oldText || r.old_text || '',
          newString: r.newText || r.new_text || '',
        }));
      if (diffs.length > 0) return { diffs };
    }

    return { diffs: [] };
  }

  /**
   * Extract diff data from a raw ai_agent_messages content string.
   * Parses the JSON to find tool arguments containing old_string/new_string,
   * content (for Write), or other diff-relevant fields.
   */
  private extractDiffsFromMessageContent(
    content: string,
    targetFilePath: string
  ): { diffs: Array<{ oldString: string; newString: string }>; content?: string } {
    try {
      const parsed = JSON.parse(content);

      // Determine tool arguments based on message format
      let args: any = null;
      let itemForChanges: any = null;

      if (parsed?.item) {
        // Claude Code SDK format: {"type":"item.completed","item":{...}}
        const item = parsed.item;
        args = item.arguments ?? item.args ?? item.input ?? item.parameters ?? null;
        if (!args && item?.type === 'command_execution' && typeof item.command === 'string') {
          args = { command: unwrapShellCommand(item.command) };
        }
        itemForChanges = item;
      } else if (parsed?.message?.content && Array.isArray(parsed.message.content)) {
        // Raw Claude API format: {"type":"assistant","message":{"content":[{"type":"tool_use","input":{...}}]}}
        // Find the tool_use block that targets our file
        for (const block of parsed.message.content) {
          if (block?.type === 'tool_use' && block.input) {
            const blockArgs = block.input;
            const blockFilePath = blockArgs.file_path || blockArgs.filePath || blockArgs.path || blockArgs.notebook_path;
            if (blockFilePath && typeof blockFilePath === 'string') {
              const normalizedBlock = path.normalize(blockFilePath);
              const normalizedTarget = path.normalize(targetFilePath);
              if (normalizedBlock === normalizedTarget) {
                args = blockArgs;
                break;
              }
            } else if (!blockFilePath) {
              // No file path in args - could be a bash command or other tool
              args = blockArgs;
            }
          }
        }
      }

      // file_change: check for content in changes array (before args guard,
      // since file_change items may have no arguments/args/input/parameters)
      if (itemForChanges && Array.isArray(itemForChanges.changes)) {
        for (const change of itemForChanges.changes) {
          if (change.path === targetFilePath && typeof change.content === 'string') {
            return { diffs: [], content: change.content };
          }
        }
      }

      if (!args || typeof args !== 'object') return { diffs: [] };

      // Check if this tool call targets the right file
      const toolFilePath = args.file_path || args.filePath || args.path || args.notebook_path;

      // For MCP tools with file_path arg, verify it matches our target
      if (toolFilePath && typeof toolFilePath === 'string') {
        const normalizedTool = path.normalize(toolFilePath);
        const normalizedTarget = path.normalize(targetFilePath);
        if (normalizedTool !== normalizedTarget) {
          return { diffs: [] };
        }
      }

      // Extract Edit-style diffs (old_string / new_string)
      if (args.old_string !== undefined || args.new_string !== undefined) {
        return {
          diffs: [{
            oldString: args.old_string || '',
            newString: args.new_string || '',
          }],
        };
      }

      // Extract Write-style content (full file creation)
      if (typeof args.content === 'string' && args.content.length > 0) {
        return { diffs: [], content: args.content };
      }

      // Multi-edit: replacements array
      if (Array.isArray(args.replacements)) {
        const diffs = args.replacements
          .filter((r: any) => r && (r.oldText || r.old_text || r.newText || r.new_text))
          .map((r: any) => ({
            oldString: r.oldText || r.old_text || '',
            newString: r.newText || r.new_text || '',
          }));
        if (diffs.length > 0) return { diffs };
      }

      // Bash: attempt to extract appended content from command redirects
      if (typeof args.command === 'string' && args.command.length > 0) {
        const appended = this.extractBashAppendContent(args.command, targetFilePath);
        if (appended && appended.length > 0) {
          return {
            diffs: [{
              oldString: '',
              newString: appended,
            }],
          };
        }
      }

      return { diffs: [] };
    } catch {
      return { diffs: [] };
    }
  }

  private extractBashAppendContent(command: string, targetFilePath: string): string | null {
    const workspaceRoot = this.inferWorkspacePath(targetFilePath);
    const normalizedTarget = path.normalize(targetFilePath);

    const decodeEscapes = (value: string): string => {
      if (!value.includes('\\')) return value;
      return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\"/g, '"')
        .replace(/\\'/g, '\'')
        .replace(/\\\\/g, '\\');
    };

    const resolveTarget = (target: string): string | null => {
      if (!target) return null;
      try {
        const resolved = target.startsWith('/') ? target : path.resolve(workspaceRoot, target);
        return path.normalize(resolved);
      } catch {
        return null;
      }
    };

    const extractOutputFromTokens = (tokens: string[]): string | null => {
      if (tokens.length === 0) return null;
      const cmd = tokens[0];

      if (cmd === 'echo') {
        let idx = 1;
        let interpretEscapes = false;
        let suppressNewline = false;
        while (idx < tokens.length && tokens[idx].startsWith('-')) {
          const opt = tokens[idx];
          if (opt.includes('e')) interpretEscapes = true;
          if (opt.includes('n')) suppressNewline = true;
          idx += 1;
        }
        let output = tokens.slice(idx).join(' ');
        if (interpretEscapes) {
          output = decodeEscapes(output);
        }
        if (!suppressNewline) {
          output += '\n';
        }
        return output;
      }

      if (cmd === 'printf') {
        const format = tokens[1];
        const arg = tokens[2];
        if (typeof format !== 'string') return null;
        let output = format;
        if (typeof arg === 'string' && format.includes('%s')) {
          output = format.replace('%s', arg);
        }
        output = decodeEscapes(output);
        return output;
      }

      return null;
    };

    const tryParseTokens = (tokens: Array<string | { op: string }>): string | null => {
      let currentTokens: string[] = [];
      let expectingRedirectTarget = false;
      let redirectTarget: string | null = null;

      const flush = (): string | null => {
        if (!redirectTarget) {
          currentTokens = [];
          return null;
        }
        const resolvedTarget = resolveTarget(redirectTarget);
        if (resolvedTarget && resolvedTarget === normalizedTarget) {
          const output = extractOutputFromTokens(currentTokens);
          if (output) return output;
        }
        currentTokens = [];
        redirectTarget = null;
        return null;
      };

      for (const token of tokens) {
        if (typeof token === 'object' && token !== null && 'op' in token) {
          const op = token.op;
          if (op === '>' || op === '>>') {
            expectingRedirectTarget = true;
            continue;
          }
          if (['&&', '||', ';', '|'].includes(op)) {
            const output = flush();
            if (output) return output;
            expectingRedirectTarget = false;
            continue;
          }
        } else if (typeof token === 'string') {
          if (expectingRedirectTarget) {
            redirectTarget = token;
            expectingRedirectTarget = false;
            continue;
          }
          currentTokens.push(token);
        }
      }

      return flush();
    };

    try {
      const normalizedCommand = decodeEscapes(command);
      const tokens = parseShellCommand(normalizedCommand) as Array<string | { op: string }>;
      const parsed = tryParseTokens(tokens);
      if (parsed) return parsed;
    } catch {
      // fall through to regex parsing
    }

    // Regex fallback for simple printf/echo redirects
    const regex = /(?:^|[;&|]\s*|\n)\s*(?:printf|echo)(?:\s+-e)?\s+(['"])([\s\S]*?)\1\s*>>?\s*([^\s;&|]+)/g;
    let match;
    const regexCommand = decodeEscapes(command);
    while ((match = regex.exec(regexCommand)) !== null) {
      const raw = match[2] ?? '';
      const target = match[3] ?? '';
      const resolvedTarget = resolveTarget(target);
      if (resolvedTarget && resolvedTarget === normalizedTarget) {
        return decodeEscapes(raw);
      }
    }

    return null;
  }

  private async insertMatchesBatch(
    matches: Array<{
      sessionId: string;
      sessionFileId: string;
      messageId: number;
      toolCallItemId: string | null;
      toolUseId: string | null;
      score: number;
      reason: string;
      fileTimestamp: number;
    }>
  ): Promise<void> {
    if (matches.length === 0) return;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const m of matches) {
      const fileTs = m.fileTimestamp ? new Date(m.fileTimestamp) : null;
      placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5}, $${paramIdx + 6}, $${paramIdx + 7})`);
      values.push(m.sessionId, m.sessionFileId, m.messageId, m.toolCallItemId, m.toolUseId, m.score, m.reason, fileTs);
      paramIdx += 8;
    }

    await database.query(
      `INSERT INTO ai_tool_call_file_edits
       (session_id, session_file_id, message_id, tool_call_item_id, tool_use_id, match_score, match_reason, file_timestamp)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (session_file_id, message_id) DO UPDATE SET
         match_score = EXCLUDED.match_score,
         match_reason = EXCLUDED.match_reason,
         file_timestamp = EXCLUDED.file_timestamp`,
      values
    );
  }

  /**
   * Infer workspace path from a file path by going up to a reasonable root.
   * Uses heuristic: find the path component before the first src/ or packages/ or lib/ etc.
   */
  private inferWorkspacePath(filePath: string): string {
    // Simple heuristic: go up directories until we hit a common root indicator
    const parts = filePath.split(path.sep);
    const markers = ['src', 'packages', 'lib', 'node_modules', '.git'];
    for (let i = 0; i < parts.length; i++) {
      if (markers.includes(parts[i])) {
        return parts.slice(0, i).join(path.sep);
      }
    }
    // Fallback: use the directory two levels up from the file
    return path.dirname(path.dirname(filePath));
  }

  /**
   * Compute a diff for a file using git.
   * Falls back through: git diff HEAD, git diff (staged), git diff HEAD~1 (just committed).
   * Returns old/new content strings suitable for DiffViewer, or null if no diff available.
   */
  /**
   * Get diff from history snapshot (document_history pre-edit tag) vs current file on disk.
   * The SessionFileWatcher stores before-content when it detects file changes during an AI session.
   */
  private async computeHistoryDiff(
    sessionId: string,
    filePath: string,
    toolUseId?: string,
    ctx?: SessionEnrichmentContext
  ): Promise<(HistoryDiffComputationResult & {
    source: 'history-post-edit' | 'history-disk-fallback';
  }) | null> {
    try {
      let compressedBefore: Buffer | undefined;
      let compressedAfter: Buffer | undefined;
      if (ctx) {
        compressedBefore = toolUseId
          ? ctx.preEditByFileAndTool.get(this.preEditKey(filePath, toolUseId))
          : ctx.preEditLatestByFile.get(filePath);
        compressedAfter = toolUseId
          ? ctx.postEditByFileAndTool.get(this.preEditKey(filePath, toolUseId))
          : undefined;
      } else {
        const isSqlite = database.getEngine() === 'sqlite';
        const sessionIdExpr = isSqlite ? `json_extract(metadata, '$.sessionId')` : `metadata->>'sessionId'`;
        const typeExpr = isSqlite ? `json_extract(metadata, '$.type')` : `metadata->>'type'`;
        const toolUseIdExpr = isSqlite ? `json_extract(metadata, '$.toolUseId')` : `metadata->>'toolUseId'`;

        if (toolUseId) {
          const snapshots = await database.query<{
            content: Buffer;
            snapshot_type: 'pre-edit' | 'ai-edit';
          }>(`
            SELECT content, ${typeExpr} AS snapshot_type
            FROM document_history
            WHERE file_path = $1
              AND ${sessionIdExpr} = $2
              AND ${toolUseIdExpr} = $3
              AND ${typeExpr} IN ('pre-edit', 'ai-edit')
            ORDER BY timestamp DESC
          `, [filePath, sessionId, toolUseId]);
          compressedBefore = snapshots.rows.find((row) => row.snapshot_type === 'pre-edit')?.content;
          compressedAfter = snapshots.rows.find((row) => row.snapshot_type === 'ai-edit')?.content;
        } else {
          const result = await database.query<{ content: Buffer }>(`
            SELECT content
            FROM document_history
            WHERE file_path = $1
              AND ${sessionIdExpr} = $2
              AND ${typeExpr} = 'pre-edit'
            ORDER BY timestamp DESC
            LIMIT 1
          `, [filePath, sessionId]);
          compressedBefore = result.rows[0]?.content;
        }
      }

      if (!compressedBefore) return null;

      let source: 'history-post-edit' | 'history-disk-fallback';
      let after: Buffer | undefined;
      if (compressedAfter) {
        source = 'history-post-edit';
      } else {
        source = 'history-disk-fallback';
        if (ctx?.diskContentCache.has(filePath)) {
          after = ctx.diskContentCache.get(filePath) ?? undefined;
        } else {
          try {
            const stat = await fs.stat(filePath);
            after = stat.size > MAX_HISTORY_DIFF_INPUT_BYTES
              ? Buffer.alloc(MAX_HISTORY_DIFF_INPUT_BYTES + 1)
              : await fs.readFile(filePath);
            ctx?.diskContentCache.set(filePath, after);
          } catch {
            ctx?.diskContentCache.set(filePath, null);
            return null;
          }
        }
        if (!after) return null;
      }

      const result = await computeBoundedHistoryDiff({
        compressedBefore,
        compressedAfter,
        after,
        runDiff: historyDiffWorkerClient.runDiff,
      });
      logger.main.debug('[ToolCallMatcher] history diff result', {
        sessionId,
        toolUseId,
        source,
        status: result.status,
        reason: result.status === 'omitted' ? result.reason : undefined,
        inputBytes: result.status === 'omitted' ? result.inputBytes : undefined,
      });
      return { ...result, source };
    } catch (error) {
      logger.main.error('[ToolCallMatcher] computeHistoryDiff failed:', error);
      return null;
    }
  }

  private async getDiffsFromToolCallContent(
    sessionId: string,
    primaryLookupId: string,
    fallbackLookupId: string,
    toolCallTimestamp?: number,
    ctx?: SessionEnrichmentContext
  ): Promise<ToolCallDiffResult[]> {
    try {
      if (!database.isInitialized()) {
        await database.initialize();
      }

      // Get file paths from the file watcher (session_files) for this tool call.
      // Match on either the synthetic edit-group ID (Phase 1.5+ writes) OR the
      // raw item id (legacy data) -- both map to the same logical tool call.
      // Use EXTRACT(EPOCH) for correct epoch ms (avoids PGLite tz interpretation bug).
      const lookupIds = primaryLookupId === fallbackLookupId
        ? [primaryLookupId]
        : [primaryLookupId, fallbackLookupId];

      let workspacePath: string | undefined;
      let linkRows: Array<{ file_path: string; timestamp_ms: number; metadata: any }>;
      if (ctx) {
        // Workspace + edited session_files were loaded once for the whole session.
        workspacePath = ctx.workspaceId;
        linkRows = [];
        for (const id of lookupIds) {
          const rows = ctx.editedByToolUseId.get(id);
          if (rows) linkRows.push(...rows.map(r => ({ file_path: r.file_path, timestamp_ms: r.timestamp_ms, metadata: r.metadata })));
        }
      } else {
        const sessionResult = await database.query<{ workspace_id: string }>(
          `SELECT workspace_id FROM ai_sessions WHERE id = $1`,
          [sessionId]
        );
        workspacePath = sessionResult.rows[0]?.workspace_id;

        const linkResult = await database.query<{ file_path: string; timestamp_ms: number; metadata: any }>(
          `SELECT file_path, EXTRACT(EPOCH FROM timestamp) * 1000 AS timestamp_ms, metadata
           FROM session_files
           WHERE session_id = $1
             AND link_type = 'edited'
             AND metadata->>'toolUseId' = ANY($2)`,
          [sessionId, lookupIds]
        );
        linkRows = linkResult.rows;
      }

      if (linkRows.length === 0) return [];

      // Deduplicate by a timestamp anchor near the requested tool call.
      // If timestamp hint is absent, keep legacy behavior: use latest timestamp.
      const sorted = [...linkRows].sort((a, b) => {
        return ensureNumber(b.timestamp_ms) - ensureNumber(a.timestamp_ms);
      });
      const anchorTs = toolCallTimestamp != null
        ? [...sorted]
          .sort((a, b) => {
            return Math.abs(ensureNumber(a.timestamp_ms) - toolCallTimestamp) -
              Math.abs(ensureNumber(b.timestamp_ms) - toolCallTimestamp);
          })[0]
        : sorted[0];
      const maxTs = ensureNumber(anchorTs.timestamp_ms);
      const thresholdMs = 2000;
      const recentPaths = sorted.filter(row => {
        return Math.abs(ensureNumber(row.timestamp_ms) - maxTs) <= thresholdMs;
      });
      const filePaths = [...new Set(recentPaths.map(r => r.file_path))];

      if (filePaths.length === 0) return [];

      // Try canonical event first for diff extraction (targeted lookup via indexed column).
      // Phase 1 promoted Codex synthetic IDs (`nimtc|...`) to canonical
      // providerToolCallId, but legacy events still use the raw item id; try
      // the synthetic form first and fall back to raw.
      let canonicalPayload: ToolCallPayload | null = null;
      let toolName = 'edit';
      try {
        if (TranscriptMigrationRepository.hasService()) {
          const runtime = TranscriptMigrationRepository.getService();
          const provider = ctx?.provider ?? (await AISessionsRepository.get(sessionId))?.provider ?? 'unknown';
          const ids = primaryLookupId === fallbackLookupId
            ? [primaryLookupId]
            : [primaryLookupId, fallbackLookupId];
          for (const id of ids) {
            if (!id) continue;
            const matchingEvent = await runtime.findToolCallByProviderId(sessionId, id, provider);
            if (matchingEvent) {
              canonicalPayload = matchingEvent.payload as unknown as ToolCallPayload;
              toolName = canonicalPayload.toolName;
              break;
            }
          }
        }
      } catch (canonicalError) {
        logger.main.warn('[ToolCallMatcher] Failed to load canonical event for getDiffsFromToolCallContent:', canonicalError);
      }

      // Build a lookup of session_files metadata.operation by file path so
      // the create/delete kind set by SessionFileTracker is preserved here.
      // Hardcoding 'edit' would mask new-file creation (NewFilePreview) and
      // route everything to DiffViewer.
      const opByFilePath = new Map<string, string>();
      for (const row of linkRows) {
        const op = (row.metadata as Record<string, unknown> | undefined)?.operation;
        if (typeof op === 'string' && !opByFilePath.has(row.file_path)) {
          opByFilePath.set(row.file_path, op);
        }
      }

      const results: ToolCallDiffResult[] = [];
      for (const filePath of filePaths) {
        const operation =
          opByFilePath.get(filePath) ??
          (toolName === 'Bash' ? 'bash' : 'edit');
        const debug: string[] = [`match: toolUseId in session_files`, `tool: ${toolName}`, `op: ${operation}`];
        const diffResult: ToolCallDiffResult = {
          filePath,
          operation,
          diffs: [],
        };

        let extracted: { diffs: Array<{ oldString: string; newString: string }>; content?: string } | null = null;
        if (canonicalPayload) {
          extracted = this.extractDiffsFromCanonicalPayload(canonicalPayload, filePath);
          if (extracted && (extracted.diffs.length > 0 || extracted.content)) {
            debug.push('diff: canonical');
          }
        }

        if (!extracted || (extracted.diffs.length === 0 && !extracted.content)) {
          debug.push('diff: no canonical payload found');
        }

        if (extracted) {
          if (extracted.diffs.length > 0) {
            diffResult.diffs = extracted.diffs;
          } else if (extracted.content) {
            diffResult.content = extracted.content;
          }
        }

        let added = 0;
        let removed = 0;
        for (const diff of diffResult.diffs) {
          if (diff.newString) added += countLines(diff.newString);
          if (diff.oldString) removed += countLines(diff.oldString);
        }
        if (diffResult.content) {
          added += countLines(diffResult.content);
        }
        if (added > 0) diffResult.linesAdded = added;
        if (removed > 0) diffResult.linesRemoved = removed;

        diffResult.debugInfo = debug.join(' | ');
        results.push(diffResult);
      }

      // History snapshot fallback for entries with no extractable diff data.
      // Try the synthetic ID first (matches the tagId pattern history tags
      // are written with for new Codex sessions); fall back to raw for
      // legacy data.
      for (const result of results) {
        if (result.diffs.length === 0 && !result.content) {
          let historyDiff: (HistoryDiffComputationResult & {
            source: 'history-post-edit' | 'history-disk-fallback';
          }) | null = null;
          for (const id of (primaryLookupId === fallbackLookupId ? [primaryLookupId] : [primaryLookupId, fallbackLookupId])) {
            if (!id) continue;
            historyDiff = await this.computeHistoryDiff(sessionId, result.filePath, id, ctx);
            if (historyDiff) break;
          }
          if (historyDiff) {
            applyHistoryDiffOutcome(result, historyDiff);
            result.debugInfo += ` | diff: ${historyDiff.status} ${historyDiff.source}`;
          } else {
            result.debugInfo += ' | diff: no history snapshot found';
          }
        }
      }

      // Filter to only entries that have diff data
      return results.filter(r => r.diffs.length > 0 || r.content || r.omissionReason || r.errorCode);
    } catch (error) {
      logger.main.error('[ToolCallMatcher] getDiffsFromToolCallContent failed:', error);
      return [];
    }
  }
}

export const toolCallMatcher = new ToolCallMatcherImpl();
