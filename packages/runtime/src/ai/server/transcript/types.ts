/**
 * Canonical Transcript Event Types
 *
 * Defines the product-facing canonical transcript contract.
 * The ai_transcript_events table stores these typed events,
 * while ai_agent_messages remains the raw source log.
 */

// ---------------------------------------------------------------------------
// Event type discriminator
// ---------------------------------------------------------------------------

export type TranscriptEventType =
  | 'user_message'
  | 'assistant_message'
  | 'system_message'
  | 'tool_call'
  | 'tool_progress'
  | 'interactive_prompt'
  | 'subagent'
  | 'turn_ended';

// ---------------------------------------------------------------------------
// Per-event payload interfaces
// ---------------------------------------------------------------------------

export interface UserMessagePayload {
  mode: 'agent' | 'planning' | 'auto';
  inputType: 'user' | 'system_message';
  attachments?: Array<{
    id: string;
    filename: string;
    filepath: string;
    mimeType: string;
    size: number;
    type: string;
  }>;
}

export interface AssistantMessagePayload {
  mode: 'agent' | 'planning' | 'auto';
  /**
   * Extended-thinking output. Stored on the assistant_message payload so we
   * can render it without introducing a new event_type (the
   * `ai_transcript_events.event_type` CHECK constraint locks the allowed
   * set). Renderers should treat this as collapsed-by-default secondary
   * content.
   */
  thinking?: string;
  /** Signature accompanying the thinking block. */
  thinkingSignature?: string;
  /** Per-turn model id (e.g. "claude-opus-4-7"). New in Claude Code 2.1.x. */
  model?: string;
}

/**
 * Discriminator returned by the SDK on a `permission_denied` event identifying
 * which subsystem produced the denial. Mirrors values emitted by
 * `@anthropic-ai/claude-agent-sdk` (see `SDKPermissionDeniedMessage`).
 *
 * Future SDK versions may introduce new values, so consumers should still
 * handle an unknown string gracefully -- the union narrows the *known*
 * vocabulary for typed label maps without locking out forward compatibility.
 */
export type PermissionDeniedReasonType =
  | 'classifier'
  | 'mode'
  | 'rule'
  | 'asyncAgent';

export interface SystemMessagePayload {
  systemType: 'status' | 'slash_command' | 'error' | 'init' | 'permission_denied';
  statusCode?: string;
  /** Marks an authentication failure so the UI can render the login widget. */
  isAuthError?: boolean;
  /**
   * Classification for system-reminder messages (e.g. `session_naming`).
   * Lets the UI pick a friendlier label than the raw reminder body.
   */
  reminderKind?: string;
  /**
   * Permission-denied fields. Populated when systemType === 'permission_denied'.
   * Emitted by the SDK when a tool call is auto-denied WITHOUT an interactive
   * prompt (deny rule, dontAsk mode, headless auto-deny, or -- rarely -- the
   * auto-mode classifier short-circuiting). The common auto-mode path for
   * destructive tools is escalation to the normal permission prompt, not this
   * deny short-circuit. See @anthropic-ai/claude-agent-sdk
   * SDKPermissionDeniedMessage.
   *
   * `deniedReasonType` is typed as the known union but persisted as a plain
   * string in the DB payload, so forward-compatible SDK additions arrive as
   * an unknown value rather than a parse failure -- renderers should treat
   * unknown values as a generic "SDK" source.
   */
  deniedToolName?: string;
  deniedReason?: string;
  deniedReasonType?: PermissionDeniedReasonType | (string & {});
  deniedInput?: Record<string, unknown>;
}

export interface ToolCallPayload {
  toolName: string;
  toolDisplayName: string;
  status: 'running' | 'completed' | 'error';
  description: string | null;
  arguments: Record<string, unknown>;
  targetFilePath: string | null;
  mcpServer: string | null;
  mcpTool: string | null;
  result?: string;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
  changes?: Array<{ path: string; patch: string }>;
}

export interface ToolProgressPayload {
  toolName: string;
  elapsedSeconds: number;
  progressContent: string;
}

// Interactive prompt payloads (discriminated union on promptType)

export interface PermissionRequestPayload {
  promptType: 'permission_request';
  requestId: string;
  status: 'pending' | 'resolved' | 'cancelled';
  toolName: string;
  rawCommand: string;
  pattern: string;
  patternDisplayName: string;
  isDestructive: boolean;
  warnings: string[];
  decision?: 'allow' | 'deny';
  scope?: 'once' | 'session' | 'always' | 'always-all';
  respondedBy?: 'desktop' | 'mobile' | 'telegram';
}

export interface AskUserQuestionPayload {
  promptType: 'ask_user_question';
  requestId: string;
  status: 'pending' | 'resolved' | 'cancelled';
  questions: Array<{
    question: string;
    header: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  answers?: Record<string, string>;
  cancelled?: boolean;
  respondedBy?: 'desktop' | 'mobile' | 'telegram';
}

export interface GitCommitProposalPayload {
  promptType: 'git_commit_proposal';
  requestId: string;
  status: 'pending' | 'resolved' | 'cancelled';
  commitMessage: string;
  stagedFiles: string[];
  decision?: 'committed' | 'cancelled';
  commitSha?: string;
  respondedBy?: 'desktop' | 'mobile' | 'telegram';
}

export type InteractivePromptPayload =
  | PermissionRequestPayload
  | AskUserQuestionPayload
  | GitCommitProposalPayload;

export interface SubagentPayload {
  agentType: string;
  status: 'running' | 'completed';
  teammateName: string | null;
  teamName: string | null;
  teammateMode: string | null;
  model: string | null;
  reasoningEffort: string | null;
  color: string | null;
  isBackground: boolean;
  prompt: string;
  resultSummary?: string;
  toolCallCount?: number;
  durationMs?: number;
}

export interface TurnEndedPayload {
  contextFill: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    outputTokens: number;
    totalContextTokens: number;
  };
  contextWindow: number;
  cumulativeUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    webSearchRequests: number;
  };
  contextCompacted: boolean;
}

// ---------------------------------------------------------------------------
// Payload type map (event type -> payload interface)
// ---------------------------------------------------------------------------

export interface TranscriptPayloadMap {
  user_message: UserMessagePayload;
  assistant_message: AssistantMessagePayload;
  system_message: SystemMessagePayload;
  tool_call: ToolCallPayload;
  tool_progress: ToolProgressPayload;
  interactive_prompt: InteractivePromptPayload;
  subagent: SubagentPayload;
  turn_ended: TurnEndedPayload;
}

// ---------------------------------------------------------------------------
// Base transcript event
// ---------------------------------------------------------------------------

export interface TranscriptEvent {
  id: number;
  sessionId: string;
  sequence: number;
  createdAt: Date;
  eventType: TranscriptEventType;
  searchableText: string | null;
  payload: Record<string, unknown>;
  parentEventId: number | null;
  searchable: boolean;
  subagentId: string | null;
  provider: string;
  providerToolCallId: string | null;
}

// ---------------------------------------------------------------------------
// Typed transcript events (type-safe payload access)
// ---------------------------------------------------------------------------

export type TypedTranscriptEvent<T extends TranscriptEventType> = Omit<TranscriptEvent, 'eventType' | 'payload'> & {
  eventType: T;
  payload: TranscriptPayloadMap[T];
};

export type UserMessageEvent = TypedTranscriptEvent<'user_message'>;
export type AssistantMessageEvent = TypedTranscriptEvent<'assistant_message'>;
export type SystemMessageEvent = TypedTranscriptEvent<'system_message'>;
export type ToolCallEvent = TypedTranscriptEvent<'tool_call'>;
export type ToolProgressEvent = TypedTranscriptEvent<'tool_progress'>;
export type InteractivePromptEvent = TypedTranscriptEvent<'interactive_prompt'>;
export type SubagentEvent = TypedTranscriptEvent<'subagent'>;
export type TurnEndedEvent = TypedTranscriptEvent<'turn_ended'>;

// ---------------------------------------------------------------------------
// Store interface (abstraction over concrete storage implementations)
// ---------------------------------------------------------------------------

export interface ITranscriptEventStore {
  insertEvent(event: Omit<TranscriptEvent, 'id'>): Promise<TranscriptEvent>;
  /**
   * Batch-insert canonical events. Used by `TranscriptTransformer` during the
   * bulk lazy-migration path where the per-event IPC round-trip of
   * `insertEvent` dominates wall-clock time. Implementations should do this in
   * a single transaction. The returned array preserves input order; ids are
   * assigned by the underlying store. Optional so existing test stores keep
   * working without modification — the transformer falls back to a sequential
   * `insertEvent` loop when this is not implemented.
   */
  insertEvents?(events: Array<Omit<TranscriptEvent, 'id'>>): Promise<TranscriptEvent[]>;
  updateEventPayload(id: number, payload: Record<string, unknown>): Promise<void>;
  /** Merge partial payload fields into an existing event's payload via JSONB || operator */
  mergeEventPayload(id: number, partialPayload: Record<string, unknown>): Promise<void>;
  /** Overwrite the searchable_text of an existing event (used for streaming chunk coalescing) */
  updateEventText(id: number, searchableText: string): Promise<void>;
  getSessionEvents(
    sessionId: string,
    options?: { eventTypes?: TranscriptEventType[]; limit?: number; offset?: number; createdAfter?: Date; createdBefore?: Date },
  ): Promise<TranscriptEvent[]>;
  getNextSequence(sessionId: string): Promise<number>;
  findByProviderToolCallId(
    providerToolCallId: string,
    sessionId: string,
  ): Promise<TranscriptEvent | null>;
  /**
   * Find the most recent active (running/pending) tool_call event whose
   * canonical providerToolCallId is either:
   *   1. equal to `rawProviderToolCallId` (legacy/raw-id sessions), or
   *   2. a Codex synthetic edit-group ID of the form
   *      `nimtc|<encodeURIComponent(rawProviderToolCallId)>|<timestamp>|<index>`
   *
   * Used by the Codex parser to correlate `item.completed` raw messages with
   * a `tool_call_started` written in an earlier batch under a stable synthetic
   * ID. Returns null if no active match exists.
   */
  findActiveToolCallByRawProviderId(
    rawProviderToolCallId: string,
    sessionId: string,
  ): Promise<TranscriptEvent | null>;
  getEventById(id: number): Promise<TranscriptEvent | null>;
  getChildEvents(parentEventId: number): Promise<TranscriptEvent[]>;
  getSubagentEvents(subagentId: string, sessionId: string): Promise<TranscriptEvent[]>;
  getMultiSessionEvents(
    sessionIds: string[],
    options?: { eventTypes?: TranscriptEventType[]; createdAfter?: Date; createdBefore?: Date },
  ): Promise<TranscriptEvent[]>;
  searchSessions(
    query: string,
    options?: { sessionIds?: string[]; limit?: number },
  ): Promise<Array<{ event: TranscriptEvent; sessionId: string }>>;
  getTailEvents(
    sessionId: string,
    count: number,
    options?: { excludeEventTypes?: TranscriptEventType[] },
  ): Promise<TranscriptEvent[]>;
  deleteSessionEvents(sessionId: string): Promise<void>;
}
