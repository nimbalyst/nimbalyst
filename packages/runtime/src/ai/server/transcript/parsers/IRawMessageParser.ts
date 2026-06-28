/**
 * IRawMessageParser -- interface for provider-specific raw message parsers.
 *
 * Each parser takes a RawMessage and returns CanonicalEventDescriptors.
 * Parsers are stateless across calls to the transformer -- any per-batch
 * dedup state (e.g. processedTextMessageIds) is internal to the parser
 * instance created per transformMessages() batch.
 *
 * The transformer handles writing descriptors to the DB and updating
 * the tool ID tracking maps.
 */

import type { RawMessage } from '../TranscriptTransformer';
import type { TranscriptEvent, InteractivePromptPayload, TurnEndedPayload, UserMessagePayload, PermissionDeniedReasonType } from '../types';

// ---------------------------------------------------------------------------
// Parse context (provided by the transformer to parsers)
// ---------------------------------------------------------------------------

export interface ParseContext {
  sessionId: string;
  /** Check if a tool call with this provider ID has already been created in this batch */
  hasToolCall(providerToolCallId: string): boolean;
  /** Check if a subagent with this ID has already been created in this batch */
  hasSubagent(subagentId: string): boolean;
  /**
   * Look up existing canonical event for tool matching on resume (DB lookup).
   * Scoped to the current session so that providers that reuse short item IDs
   * (e.g. Codex `item_1`) don't collide with events from other sessions.
   */
  findByProviderToolCallId(id: string): Promise<TranscriptEvent | null>;
  /**
   * Find the most recent active (running/pending) tool_call event whose
   * canonical providerToolCallId is either the raw id directly or a Codex
   * synthetic edit-group ID derived from it (`nimtc|<encoded>|<ts>|<idx>`).
   *
   * Used by the Codex parser so a `tool_call_completed` raw message can map
   * back to the synthetic ID minted when the matching `tool_call_started` was
   * processed in an earlier batch.
   */
  findActiveToolCallByRawProviderId(rawId: string): Promise<TranscriptEvent | null>;
}

// ---------------------------------------------------------------------------
// Canonical event descriptors (plain data, no DB writes)
// ---------------------------------------------------------------------------

export interface UserMessageDescriptor {
  type: 'user_message';
  text: string;
  mode?: 'agent' | 'planning' | 'auto';
  inputType?: 'user' | 'system_message';
  attachments?: UserMessagePayload['attachments'];
  createdAt?: Date;
  /** Raw `ai_agent_messages.id` this descriptor was parsed from. Stamped by the
   * transformer/projector loop (not the parser) so edit/rewind can target the
   * exact raw row. */
  rawMessageId?: number;
}

export interface AssistantMessageDescriptor {
  type: 'assistant_message';
  text: string;
  mode?: 'agent' | 'planning' | 'auto';
  createdAt?: Date;
  /**
   * Extended-thinking output emitted by Claude Code (and other providers)
   * alongside the regular `text` content. Stored on the assistant_message
   * payload so we don't have to add a new event_type and migrate the
   * `ai_transcript_events` CHECK constraint. Renderers should display this
   * collapsed-by-default.
   */
  thinking?: string;
  /** Signature accompanying the thinking block, when present. */
  thinkingSignature?: string;
  /** Per-turn model id (e.g. "claude-opus-4-7"). New in Claude Code 2.1.x. */
  model?: string;
}

export interface SystemMessageDescriptor {
  type: 'system_message';
  text: string;
  systemType?: 'status' | 'slash_command' | 'error' | 'init' | 'permission_denied';
  searchable?: boolean;
  createdAt?: Date;
  /** Marks an authentication failure so the UI can render the login widget. */
  isAuthError?: boolean;
  /** Classification for system-reminder messages (e.g. `session_naming`). */
  reminderKind?: string;
  /**
   * Permission-denied fields. Populated when systemType === 'permission_denied'.
   * Mirrors `SystemMessagePayload` denied fields. Emitted for the SDK's deny
   * short-circuit only (deny rules, dontAsk, headless auto-deny, rare
   * classifier denies) -- the common auto-mode path for destructive tools
   * escalates to the normal permission prompt, not this event.
   */
  deniedToolName?: string;
  deniedReason?: string;
  deniedReasonType?: PermissionDeniedReasonType | (string & {});
  deniedInput?: Record<string, unknown>;
}

export interface ToolCallStartedDescriptor {
  type: 'tool_call_started';
  toolName: string;
  toolDisplayName: string;
  arguments: Record<string, unknown>;
  targetFilePath?: string | null;
  mcpServer?: string | null;
  mcpTool?: string | null;
  providerToolCallId?: string | null;
  subagentId?: string | null;
  createdAt?: Date;
}

export interface ToolCallCompletedDescriptor {
  type: 'tool_call_completed';
  providerToolCallId: string;
  status: 'completed' | 'error';
  result?: string;
  isError?: boolean;
  exitCode?: number;
  durationMs?: number;
}

export interface ToolProgressDescriptor {
  type: 'tool_progress';
  providerToolCallId: string;
  toolName: string;
  elapsedSeconds: number;
  progressContent: string;
  subagentId?: string | null;
  createdAt?: Date;
}

export interface SubagentStartedDescriptor {
  type: 'subagent_started';
  subagentId: string;
  agentType: string;
  teammateName?: string | null;
  teamName?: string | null;
  teammateMode?: string | null;
  isBackground?: boolean;
  prompt: string;
  createdAt?: Date;
}

export interface SubagentCompletedDescriptor {
  type: 'subagent_completed';
  subagentId: string;
  status: 'completed';
  resultSummary?: string;
}

export interface InteractivePromptCreatedDescriptor {
  type: 'interactive_prompt_created';
  payload: InteractivePromptPayload;
  subagentId?: string | null;
  createdAt?: Date;
}

export interface InteractivePromptUpdatedDescriptor {
  type: 'interactive_prompt_updated';
  requestId: string;
  update: Partial<InteractivePromptPayload>;
}

export interface TurnEndedDescriptor {
  type: 'turn_ended';
  contextFill: TurnEndedPayload['contextFill'];
  contextWindow: number;
  cumulativeUsage: TurnEndedPayload['cumulativeUsage'];
  contextCompacted?: boolean;
  subagentId?: string | null;
  createdAt?: Date;
}

export type CanonicalEventDescriptor =
  | UserMessageDescriptor
  | AssistantMessageDescriptor
  | SystemMessageDescriptor
  | ToolCallStartedDescriptor
  | ToolCallCompletedDescriptor
  | ToolProgressDescriptor
  | SubagentStartedDescriptor
  | SubagentCompletedDescriptor
  | InteractivePromptCreatedDescriptor
  | InteractivePromptUpdatedDescriptor
  | TurnEndedDescriptor;

// ---------------------------------------------------------------------------
// Parser interface
// ---------------------------------------------------------------------------

export interface IRawMessageParser {
  /**
   * Parse a single raw message and return canonical event descriptors.
   * The transformer calls this for each raw message in sequence.
   */
  parseMessage(
    msg: RawMessage,
    context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]>;
}
