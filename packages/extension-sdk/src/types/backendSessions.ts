/**
 * Backend-module session API and tool call context.
 *
 * These types describe what a privileged backend module (see
 * `BackendModuleContribution` in `./permissions`) receives from the host when
 * it drives AI agent sessions:
 *
 *   - `BackendToolCallContext`: passed to a backend MCP tool handler as
 *     `ctx.call`, so the handler knows which session called it.
 *   - `BackendSessionsService`: `ctx.services.sessions`, gated by the
 *     `ai-sessions` permission. Every call is scoped by the host to the
 *     calling module's extension and bound workspace; a module can only read
 *     or drive sessions its own extension owns.
 *   - `BackendMcpToolDefinition`: the shape passed to
 *     `ctx.services.registerMcpTools`, including `panelOnly`.
 *
 * Ownership lives in the session row's metadata (`sessionOwner`), written at
 * creation. Sessions an owned session spawns (`spawn_session`, `create_session`,
 * a child created under it in the UI) inherit the owner, but not the directive.
 */

/**
 * Which extension owns a session, and under what key. `key` is the owner's own
 * grouping id (for example a member slug); the host never interprets it.
 */
export interface SessionOwner {
  extensionId: string;
  key: string;
  /**
   * When true, an owned child's settle does NOT queue a `[Child Session
   * Update]` prompt on the session that spawned it and does not re-drive that
   * session. The owner gets the settle through `sessions.onSettled` instead.
   */
  routeChildUpdatesToOwner?: boolean;
}

/**
 * Identity of the caller of a backend MCP tool. Present on `ctx.call` when the
 * method was invoked as a tool; absent for plain RPC calls.
 */
export interface BackendToolCallContext {
  /** Calling AI session, or null when the call did not come from a session (panel, voice). */
  sessionId: string | null;
  /** Workspace the module is bound to. */
  workspacePath: string;
  /**
   * The calling session's owner, populated ONLY when that session is owned by
   * this same extension. Null for unowned sessions and for sessions another
   * extension owns.
   */
  sessionOwner: SessionOwner | null;
  /** Where the call came from. */
  caller: 'agent' | 'panel' | 'voice';
}

/**
 * One tool passed to `ctx.services.registerMcpTools`. The advertised name is
 * namespaced by the host as `<extension short name>.<name>`; `name` is also the
 * backend method the host invokes.
 */
export interface BackendMcpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** Also expose the tool to the voice agent. Ignored when `panelOnly` is set. */
  voiceAgent?: boolean;
  scope?: 'global' | 'editor';
  /**
   * Callable only from this extension's own renderer via `callBackendTool`.
   * The tool is not listed to agents or the voice agent, and an agent call to
   * it is rejected.
   */
  panelOnly?: boolean;
  /**
   * Which agent sessions see the tool. `'all'` (default) lists it to every
   * session in the workspace. `'owned-sessions'` lists it only to sessions this
   * extension owns (`metadata.sessionOwner.extensionId`, inherited by spawned
   * descendants); any other session's call is rejected as an unknown tool, and
   * the voice agent never sees it. Use it for tools that only make sense inside
   * the extension's own sessions, so they cost other sessions no context.
   */
  audience?: 'all' | 'owned-sessions';
}

/** Session lifecycle states as stored by the host. */
export type OwnedSessionStatus =
  | 'idle'
  | 'running'
  | 'waiting_for_input'
  | 'error'
  | 'interrupted';

export interface CreateOwnedSessionOptions {
  /** Owner key recorded in `sessionOwner.key`. The extension id is supplied by the host. */
  ownerKey: string;
  /** Session title. The session is treated as named, so it does not rename itself. */
  name: string;
  /** Agent provider id, e.g. `claude-code`, `openai-codex`. */
  provider: string;
  /** Model id, either `provider:model` or a bare model for `provider`. */
  model: string;
  /** Optional first prompt. Queued and dispatched immediately when present. */
  prompt?: string;
  /** Reasoning effort (`low` | `medium` | `high` | `xhigh` | `max`), clamped to the model. */
  effortLevel?: string;
  /**
   * Text appended to the session's system prompt, frozen at the first turn.
   * `create` rejects it for providers that do not apply it: the chat
   * providers (`claude`, `openai`, `lmstudio`), `claude-code-cli`, and
   * extension-contributed agent providers.
   */
  directive?: string;
  /** Owned workstream container to file the session under (see `createWorkstream`). */
  workstreamId?: string;
  /**
   * Owned session that logically spawned this one. Its settle routing follows
   * `routeChildUpdatesToOwner`.
   */
  createdBySessionId?: string;
  /** Initial owner metadata bag. Only this extension can change it later. */
  ownerMetadata?: Record<string, unknown>;
  /** See `SessionOwner.routeChildUpdatesToOwner`. Inherited by descendants. */
  routeChildUpdatesToOwner?: boolean;
}

export interface CreateOwnedWorkstreamOptions {
  ownerKey: string;
  name: string;
  /** Provider recorded on the container row. Defaults to `claude-code`. */
  provider?: string;
  ownerMetadata?: Record<string, unknown>;
}

export interface OwnedSessionStatusResult {
  sessionId: string;
  status: OwnedSessionStatus;
  title: string;
  lastActivity: number | null;
  updatedAt: number | null;
  /** The session has an unanswered durable prompt (question, plan approval, permission). */
  hasPendingPrompt: boolean;
  /** Queued prompts not yet delivered. */
  queuedPromptCount: number;
}

export interface OwnedSessionContextFill {
  /** Tokens currently in the context window. */
  tokens: number;
  contextWindow: number;
}

export interface OwnedSessionResult {
  sessionId: string;
  status: OwnedSessionStatus;
  /** Text of the last assistant turn, or null if the session has not answered. */
  lastResponse: string | null;
  errorMessage: string | null;
  /** Current context fill as last reported by the provider; null before the first report. */
  contextFill: OwnedSessionContextFill | null;
  pendingPrompt: { promptId: string; promptType: string } | null;
  editedFiles: string[];
}

export interface OwnedSessionSummary {
  sessionId: string;
  key: string;
  sessionType: 'session' | 'workstream' | string;
  title: string;
  /** Owned workstream container this session is filed under, if any. */
  workstreamId: string | null;
  /** Session that spawned this one, if any. */
  createdBySessionId: string | null;
  status: OwnedSessionStatus;
  hasPendingPrompt: boolean;
  queuedPromptCount: number;
  createdAt: number;
  updatedAt: number;
  ownerMetadata: Record<string, unknown>;
}

/**
 * Token usage for one session over its whole lifetime, as persisted by the
 * host (the same counters the session's usage display reads). `costUSD` is
 * 0 when the provider does not report cost.
 *
 * The four token counters are disjoint: `inputTokens` is uncached input only,
 * and cache reads/writes are counted separately (0 for providers that report
 * no cache split, and for sessions recorded before the host stored them).
 * `totalTokens` keeps its historical meaning, input + output without cache;
 * budget over `allTokens` to count everything the session consumed.
 */
export interface OwnedSessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** inputTokens + outputTokens + cacheReadInputTokens + cacheCreationInputTokens. */
  allTokens: number;
}

/**
 * Usage is session-granular: a session counts in full when its last activity
 * is at or after `since`. The host keeps no per-turn usage history. For an
 * exact time window, record `OwnedSessionSettledEvent.tokenUsage` deltas in
 * the module's own storage.
 */
export interface OwnedUsageReport {
  since: number;
  totals: OwnedSessionUsage;
  sessions: Array<OwnedSessionUsage & { sessionId: string; key: string; lastActivity: number }>;
}

export type OwnedSessionSettleOutcome = 'completed' | 'error' | 'waiting' | 'interrupted';

/**
 * Delivered to `onSettled` handlers. `completed` fires once the session's
 * prompt queue is empty, not between queued prompts.
 */
export interface OwnedSessionSettledEvent {
  sessionId: string;
  ownerKey: string;
  outcome: OwnedSessionSettleOutcome;
  createdBySessionId: string | null;
  workstreamId: string | null;
  at: number;
  /** The session's lifetime usage at settle time; diff consecutive events for per-turn usage. */
  tokenUsage: OwnedSessionUsage;
}

export interface NotifyUserOptions {
  /** Owned session the notification is about; clicking it opens this session. */
  sessionId: string;
  title: string;
  body: string;
  /** `critical` also pushes to the user's phone. Defaults to `normal`. */
  urgency?: 'low' | 'normal' | 'critical';
}

/**
 * `ctx.services.sessions`. Requires the `ai-sessions` permission. Every method
 * that takes a session id rejects sessions this extension does not own.
 */
export interface BackendSessionsService {
  create(options: CreateOwnedSessionOptions): Promise<{ sessionId: string; queuedPromptId: string | null }>;
  createWorkstream(options: CreateOwnedWorkstreamOptions): Promise<{ workstreamId: string }>;
  /** Queue a prompt; it is delivered when the session is idle. */
  sendPrompt(sessionId: string, prompt: string): Promise<{ queuedPromptId: string }>;
  getStatus(sessionId: string): Promise<OwnedSessionStatusResult>;
  getResult(sessionId: string): Promise<OwnedSessionResult>;
  /** Owned sessions in this workspace, optionally filtered to one owner key. Newest first. */
  listOwned(options?: { key?: string }): Promise<OwnedSessionSummary[]>;
  /** Lifetime usage of owned sessions active at or after `since` (epoch ms). See `OwnedUsageReport`. */
  getUsage(options: { key?: string; since: number }): Promise<OwnedUsageReport>;
  /** Shallow-merge `patch` into the session's owner metadata bag. A `null` value deletes the key. */
  updateOwnerMetadata(sessionId: string, patch: Record<string, unknown>): Promise<{ ownerMetadata: Record<string, unknown> }>;
  notifyUser(options: NotifyUserOptions): Promise<void>;
  /** Subscribe to settle events for sessions this extension owns in this workspace. Returns an unsubscribe. */
  onSettled(handler: (event: OwnedSessionSettledEvent) => void): () => void;
}
