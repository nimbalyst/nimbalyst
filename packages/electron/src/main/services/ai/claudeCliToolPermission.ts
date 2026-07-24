/**
 * Pure builders for the genuine `claude-code-cli` tool-permission flow
 * (NIM-806, Phase 4 / Direction A). Kept free of Electron/IPC so the contract
 * with the CLI and the `ToolPermissionWidget` is unit-testable without a process.
 *
 * Flow: the CLI is launched with
 *   `--permission-prompt-tool request_tool_permission`
 * so that, instead of its native TUI prompt, it calls our MCP tool whenever a
 * built-in tool (Bash/Edit/Write/WebFetch/…) needs approval. The tool is called
 * with `{ tool_name, input }`; it must RETURN a JSON permission result of the
 * exact Claude Code shape (verified against the 2.1.168 binary strings —
 * `behavior` / `updatedInput`):
 *   { "behavior": "allow", "updatedInput": <input> }
 *   { "behavior": "deny",  "message": "<why>" }
 *
 * To render the real `ToolPermissionWidget` inline (the external CLI never writes
 * to `ai_agent_messages`), we persist a synthetic `nimbalyst_tool_use` row named
 * `ToolPermission` whose `input` matches what that widget reads — identical to the
 * SDK path's `toolAuthorization.ts`. The widget answer (`{decision, scope}`)
 * arrives over IPC; we then persist a synthetic `nimbalyst_tool_result` to flip
 * the widget to its completed state and return the behavior JSON above.
 */

import {
  buildToolDescription,
  generateToolPattern,
  matchesAllowPattern,
} from '@nimbalyst/runtime/ai/server/permissions/toolPermissionHelpers';
import { getPatternDisplayName } from '@nimbalyst/runtime/ai/server/types';

/** Workspace trust/permission mode (mirrors PermissionService). */
export type WorkspacePermissionMode = 'ask' | 'allow-all' | 'bypass-all' | null;

/**
 * Tools that STILL prompt under "allow-all" (the SDK's acceptEdits-equivalent):
 * allow-all auto-approves file edits + reads but keeps Bash and WebFetch gated.
 * See AGENT_PERMISSIONS.md ("Always Allow … Bash commands and WebFetch still
 * require approval").
 */
const ALLOW_ALL_STILL_PROMPTS = new Set(['Bash', 'WebFetch']);

/**
 * Decide whether a tool call can be auto-resolved WITHOUT rendering the widget,
 * replicating the SDK's permission semantics for the hook path (which bypasses
 * the CLI's own mode/settings handling). Precedence:
 *   1. bypass-all → allow everything (mirrors SDK bypassPermissions).
 *   2. deny-list match → deny.
 *   3. session-approved (Session/Always this run) → allow.
 *   4. settings allow-list match → allow (honors cross-session "Always").
 *   5. allow-all + non-(Bash/WebFetch) → allow (acceptEdits-equivalent).
 *   6. otherwise → ask (render the widget).
 */
export function decideAutoPermission(args: {
  mode: WorkspacePermissionMode;
  toolName: string;
  pattern: string;
  sessionCacheHit: boolean;
  allowList: string[];
  denyList: string[];
}): 'allow' | 'deny' | 'ask' {
  const { mode, toolName, pattern, sessionCacheHit, allowList, denyList } = args;
  if (mode === 'bypass-all') return 'allow';
  if (denyList.some((p) => matchesAllowPattern(pattern, p))) return 'deny';
  if (sessionCacheHit) return 'allow';
  if (allowList.some((p) => matchesAllowPattern(pattern, p))) return 'allow';
  if (mode === 'allow-all' && !ALLOW_ALL_STILL_PROMPTS.has(toolName)) return 'allow';
  return 'ask';
}

/** Decision + scope the `ToolPermissionWidget` sends back. */
export interface ToolPermissionAnswer {
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'always' | 'always-all';
  cancelled?: boolean;
}

export interface ToolPermissionResponseRecord {
  type: 'permission_response';
  requestId: string;
  decision: 'allow' | 'deny';
  scope: ToolPermissionAnswer['scope'];
  cancelled: boolean;
  respondedAt: number;
  respondedBy: 'desktop' | 'mobile';
}

/** The Claude Code `--permission-prompt-tool` return contract. */
export type ToolPermissionBehaviorResult =
  | { behavior: 'allow'; updatedInput: unknown }
  | { behavior: 'deny'; message: string };

/** Tools we flag as destructive (drives the widget's warning styling). */
const DESTRUCTIVE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'Bash'];

/**
 * Read the tool name + input out of the MCP permission-prompt call args,
 * tolerant of snake/camel and the older `tool_input` key. Returns `''`/`{}`
 * defaults so a malformed call still renders a (denyable) widget rather than
 * throwing inside the CLI's permission path.
 */
export function parseToolPermissionRequestArgs(args: unknown): {
  toolName: string;
  input: Record<string, unknown>;
} {
  const a = (args ?? {}) as Record<string, unknown>;
  const toolName =
    (typeof a.tool_name === 'string' && a.tool_name) ||
    (typeof a.toolName === 'string' && a.toolName) ||
    '';
  const rawInput = a.input ?? a.tool_input ?? {};
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  return { toolName, input };
}

export interface ToolPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  pattern: string;
  patternDisplayName: string;
  toolDescription: string;
  isDestructive: boolean;
  rawCommand: string;
}

/**
 * Derive the permission request metadata from a tool call, reusing the SAME
 * pure helpers the SDK path uses so patterns/descriptions are identical across
 * both paths (and the cache / settings allow-list matching lines up).
 */
export function buildToolPermissionRequest(
  toolName: string,
  input: Record<string, unknown>,
): ToolPermissionRequest {
  const pattern = generateToolPattern(toolName, input);
  const toolDescription = buildToolDescription(toolName, input);
  const isDestructive = DESTRUCTIVE_TOOLS.includes(toolName);
  const rawCommand =
    toolName === 'Bash'
      ? ((input?.command as string) || '')
      : toolDescription;
  return {
    toolName,
    input,
    pattern,
    patternDisplayName: getPatternDisplayName(pattern),
    toolDescription,
    isDestructive,
    rawCommand,
  };
}

/**
 * The `input` object for the synthetic `nimbalyst_tool_use` row (name
 * `ToolPermission`) — must match what `ToolPermissionWidget` reads.
 */
export function buildToolPermissionWidgetInput(args: {
  requestId: string;
  request: ToolPermissionRequest;
  workspacePath: string | undefined;
  teammateName?: string;
}): Record<string, unknown> {
  const { requestId, request, workspacePath, teammateName } = args;
  return {
    requestId,
    toolName: request.toolName,
    rawCommand: request.rawCommand,
    pattern: request.pattern,
    patternDisplayName: request.patternDisplayName,
    isDestructive: request.isDestructive,
    warnings: [],
    workspacePath,
    ...(teammateName ? { teammateName } : {}),
  };
}

/** The `result` payload for the synthetic `nimbalyst_tool_result` (completed widget state). */
export function buildToolPermissionResultPayload(answer: ToolPermissionAnswer): {
  decision: 'allow' | 'deny';
  scope: ToolPermissionAnswer['scope'];
  cancelled: boolean;
} {
  return {
    decision: answer.decision,
    scope: answer.scope,
    cancelled: answer.cancelled === true,
  };
}

export function normalizeToolPermissionAnswer(payload: any): ToolPermissionAnswer {
  const r = (payload && payload.response) || payload || {};
  const decision = r.decision === 'allow' ? 'allow' : 'deny';
  const scope =
    r.scope === 'session' || r.scope === 'always' || r.scope === 'always-all'
      ? r.scope
      : 'once';
  return { decision, scope, cancelled: r.cancelled === true };
}

export function buildToolPermissionResponseRecord(args: {
  requestId: string;
  answer: ToolPermissionAnswer;
  respondedBy: 'desktop' | 'mobile';
  respondedAt?: number;
}): ToolPermissionResponseRecord {
  const answer = normalizeToolPermissionAnswer(args.answer);
  return {
    type: 'permission_response',
    requestId: args.requestId,
    decision: answer.decision,
    scope: answer.scope,
    cancelled: answer.cancelled === true,
    respondedAt: args.respondedAt ?? Date.now(),
    respondedBy: args.respondedBy,
  };
}

export function parseToolPermissionResponseRecord(
  rawContent: unknown,
  requestId: string,
): ToolPermissionAnswer | null {
  try {
    const content =
      typeof rawContent === 'string'
        ? JSON.parse(rawContent)
        : rawContent;
    if (!content || typeof content !== 'object') {
      return null;
    }
    const record = content as Record<string, unknown>;
    if (record.type !== 'permission_response' || record.requestId !== requestId) {
      return null;
    }
    return normalizeToolPermissionAnswer(record);
  } catch {
    return null;
  }
}

/** Map a widget answer to the Claude Code permission-prompt-tool return contract. */
export function buildToolPermissionBehaviorResult(
  answer: ToolPermissionAnswer,
  input: unknown,
): ToolPermissionBehaviorResult {
  if (answer.decision === 'allow' && !answer.cancelled) {
    return { behavior: 'allow', updatedInput: input };
  }
  return {
    behavior: 'deny',
    message: answer.cancelled ? 'Tool call cancelled by user' : 'Tool call denied by user',
  };
}

/** Wrap a behavior result as the MCP tool's text content (what the CLI receives). */
export function toToolPermissionMcpResult(behavior: ToolPermissionBehaviorResult): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(behavior) }],
    // `deny` is a normal, expected control-flow answer, not a tool error — the
    // CLI parses the JSON either way. Keep isError false so the CLI treats it as
    // a valid permission response (an MCP error would look like a tool failure).
    isError: false,
  };
}

/**
 * Dependencies for the orchestration. Real impls live in the ipcMain wrapper
 * (`handleToolPermission` in interactiveToolHandlers.ts); the tests inject fakes
 * so the whole request→answer→side-effects round-trip is exercised without a
 * process.
 */
export interface ToolPermissionDeps {
  /** True if the pattern was already approved this session (cache short-circuit). */
  isPatternApproved: (sessionId: string, pattern: string) => boolean;
  /** Record an approved pattern for the session (Session/Always scope). */
  markPatternApproved: (sessionId: string, pattern: string) => void;
  /**
   * Workspace permission mode (allow-all / bypass-all auto-approve without a
   * widget). Defaults to 'ask' when omitted (tests / no trust store).
   */
  getPermissionMode?: (workspacePath: string | undefined) => WorkspacePermissionMode;
  /**
   * Effective Claude settings allow/deny lists for the workspace, so a pattern
   * saved via "Always" in a prior session auto-approves. Defaults to empty.
   */
  getAllowDenyLists?: (
    workspacePath: string | undefined,
  ) => Promise<{ allow: string[]; deny: string[] }>;
  /** Persist the synthetic `nimbalyst_tool_use` so the widget renders. */
  persistToolUse: (args: { sessionId: string; toolUseId: string; input: Record<string, unknown> }) => Promise<void>;
  /** Persist the synthetic `nimbalyst_tool_result` so the widget shows completed. */
  persistToolResult: (args: { sessionId: string; toolUseId: string; result: unknown; isError: boolean }) => Promise<void>;
  /** Block until the widget answer arrives over IPC (keyed by requestId). */
  waitForAnswer: (args: { sessionId: string; requestId: string }) => Promise<ToolPermissionAnswer>;
  /** Flip the session indicator to waiting_for_input while the prompt is pending. */
  setWaitingStatus: (sessionId: string) => void;
  /** Restore turn state on settle (CLI-aware; PID watcher owns running/idle). */
  applySettle: (sessionId: string) => void;
  /** Persist an "always" pattern to Claude settings (best-effort). */
  savePattern: (workspacePath: string, pattern: string) => Promise<void>;
  /** Fire the OS "blocked / needs response" notification (best-effort). */
  notifyBlocked: (args: { sessionId: string; workspacePath: string | undefined; request: ToolPermissionRequest }) => void;
  /** Mint a unique requestId (also the widget's answer-channel key). */
  makeRequestId: () => string;
  log?: (message: string) => void;
}

export interface ToolPermissionParams {
  args: unknown;
  sessionId: string;
  workspacePath: string | undefined;
  teammateName?: string;
}

/**
 * Orchestrate one CLI tool-permission request end to end and return the MCP
 * result the CLI receives. Pure of Electron — all I/O is injected.
 *
 * Short-circuits to `allow` when the pattern is already approved this session
 * (no widget, no waiting state) — mirroring how the SDK's `sessionApprovedPatterns`
 * suppresses repeat prompts. Otherwise renders the widget, waits for the answer,
 * persists the completed state, applies the scope (session cache / always→settings),
 * and returns the behavior JSON.
 */
export async function resolveClaudeCliToolPermission(
  params: ToolPermissionParams,
  deps: ToolPermissionDeps,
): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
  const { sessionId, workspacePath, teammateName } = params;
  const { toolName, input } = parseToolPermissionRequestArgs(params.args);
  const request = buildToolPermissionRequest(toolName, input);

  // Auto-resolve without a widget when the workspace mode (allow-all / bypass-all),
  // the session cache, or the settings allow/deny lists already decide it — this is
  // what keeps an "allow-all" project from prompting on every edit. The hook path
  // bypasses the CLI's own mode/settings handling, so we replicate it here.
  const mode = (deps.getPermissionMode ?? (() => null))(workspacePath);
  const sessionCacheHit = deps.isPatternApproved(sessionId, request.pattern);
  let allowList: string[] = [];
  let denyList: string[] = [];
  if (deps.getAllowDenyLists) {
    try {
      const lists = await deps.getAllowDenyLists(workspacePath);
      allowList = lists.allow ?? [];
      denyList = lists.deny ?? [];
    } catch {
      // best-effort — fall through to mode/cache only
    }
  }
  const auto = decideAutoPermission({
    mode,
    toolName,
    pattern: request.pattern,
    sessionCacheHit,
    allowList,
    denyList,
  });
  if (auto === 'allow') {
    deps.log?.(`[ToolPermission] auto-allow ${request.pattern} (${toolName}, mode=${mode}, cached=${sessionCacheHit})`);
    return toToolPermissionMcpResult({ behavior: 'allow', updatedInput: input });
  }
  if (auto === 'deny') {
    deps.log?.(`[ToolPermission] auto-deny ${request.pattern} (${toolName}, deny-list)`);
    return toToolPermissionMcpResult({ behavior: 'deny', message: 'Tool call denied by workspace policy' });
  }

  const requestId = deps.makeRequestId();

  await deps.persistToolUse({
    sessionId,
    toolUseId: requestId,
    input: buildToolPermissionWidgetInput({ requestId, request, workspacePath, teammateName }),
  });

  deps.setWaitingStatus(sessionId);
  deps.notifyBlocked({ sessionId, workspacePath, request });

  let answer: ToolPermissionAnswer;
  try {
    answer = await deps.waitForAnswer({ sessionId, requestId });
  } catch (err) {
    // Aborted / failed wait → deny (fail closed) and settle.
    deps.log?.(`[ToolPermission] wait failed for ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
    answer = { decision: 'deny', scope: 'once', cancelled: true };
  }

  await deps.persistToolResult({
    sessionId,
    toolUseId: requestId,
    result: buildToolPermissionResultPayload(answer),
    isError: answer.decision === 'deny' || answer.cancelled === true,
  });

  // Persist scope: Session/Always cache the pattern for this run; Always also
  // writes it to Claude settings so a future CLI session is auto-allowed by the
  // CLI itself. `once` and compound patterns are never cached (markPatternApproved
  // drops compounds defensively).
  if (answer.decision === 'allow' && !answer.cancelled && (answer.scope === 'session' || answer.scope === 'always' || answer.scope === 'always-all')) {
    deps.markPatternApproved(sessionId, request.pattern);
    if ((answer.scope === 'always' || answer.scope === 'always-all') && workspacePath) {
      await deps.savePattern(workspacePath, request.pattern).catch((e) => {
        deps.log?.(`[ToolPermission] savePattern failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  deps.applySettle(sessionId);

  return toToolPermissionMcpResult(buildToolPermissionBehaviorResult(answer, input));
}
