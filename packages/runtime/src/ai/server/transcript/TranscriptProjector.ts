/**
 * TranscriptProjector -- pure function that reads canonical transcript events
 * and produces UI view models.
 *
 * No side effects, no DB access. Expects events pre-sorted by sequence.
 */

import type {
  TranscriptEvent,
  TranscriptEventType,
  UserMessagePayload,
  SystemMessagePayload,
  ToolCallPayload,
  ToolProgressPayload,
  InteractivePromptPayload,
  SubagentPayload,
  TurnEndedPayload,
  AssistantMessagePayload,
} from './types';

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

export interface TranscriptViewModel {
  messages: TranscriptViewMessage[];
}

export interface ToolCallDiffResult {
  filePath: string;
  operation: string; // 'create' | 'edit' | 'delete' | 'bash'
  diffs: Array<{ oldString: string; newString: string }>;
  content?: string; // full content for create operations
  linesAdded?: number;
  linesRemoved?: number;
  debugInfo?: string; // how this file was linked to the tool call
}

export interface TranscriptViewMessage {
  id: number;
  sequence: number;
  createdAt: Date;
  type: TranscriptEventType;
  text?: string;
  mode?: 'agent' | 'planning' | 'auto';
  attachments?: UserMessagePayload['attachments'];
  toolCall?: {
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
    fileDiffs?: ToolCallDiffResult[];
    providerToolCallId: string | null;
    progress: Array<{
      elapsedSeconds: number;
      progressContent: string;
    }>;
  };
  interactivePrompt?: InteractivePromptPayload;
  subagent?: SubagentPayload & {
    childEvents: TranscriptViewMessage[];
  };
  turnEnded?: TurnEndedPayload;
  systemMessage?: SystemMessagePayload;
  subagentId: string | null;

  /** Extended-thinking content rendered by the assistant message UI as a collapsed-by-default block. */
  thinking?: string;
  /** Per-turn model id (Claude Code 2.1.x). */
  model?: string;

  // -- Optimistic/live UI state (not from database) --
  /** True when this message represents an error (auth failure, API error, etc.) */
  isError?: boolean;
  /** True when the error is an authentication failure */
  isAuthError?: boolean;
  /** True when this is a Codex app-server "user not signed in" pre-flight error -- renders a CTA widget. */
  isCodexAuthRequired?: boolean;
  /** Provider-specific metadata (e.g., Codex raw events) */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

export class TranscriptProjector {
  /**
   * Project canonical events into a UI view model.
   * Handles:
   * - Grouping tool_progress under parent tool_call
   * - Grouping events by subagent_id into subagent hierarchies
   * - Merging stateful event data (already in payload)
   * - Surfacing stable tool IDs for diff rendering
   */
  static project(events: TranscriptEvent[]): TranscriptViewModel {
    if (events.length === 0) {
      return { messages: [] };
    }

    // Index tool_progress events by parentEventId for grouping
    const progressByParent = new Map<number, TranscriptEvent[]>();
    for (const event of events) {
      if (event.eventType === 'tool_progress' && event.parentEventId != null) {
        const list = progressByParent.get(event.parentEventId) ?? [];
        list.push(event);
        progressByParent.set(event.parentEventId, list);
      }
    }

    // Build view messages for non-progress, non-turn-ended events
    const allMessages: TranscriptViewMessage[] = [];
    for (const event of events) {
      if (event.eventType === 'tool_progress' || event.eventType === 'turn_ended') {
        continue; // progress grouped under parent tool_call; turn_ended is metadata-only
      }
      allMessages.push(projectEvent(event, progressByParent));
    }

    // Separate subagent child events from top-level
    const subagentEvents = new Map<string, TranscriptViewMessage[]>();
    const subagentParents = new Map<string, TranscriptViewMessage>();
    const topLevel: TranscriptViewMessage[] = [];

    // First pass: identify subagent parent events
    for (const msg of allMessages) {
      if (msg.type === 'subagent' && msg.subagent && msg.subagentId) {
        subagentParents.set(msg.subagentId, msg);
        if (!subagentEvents.has(msg.subagentId)) {
          subagentEvents.set(msg.subagentId, []);
        }
      }
    }

    // Second pass: group events by subagent ownership
    for (const msg of allMessages) {
      if (msg.subagentId && subagentParents.has(msg.subagentId) && msg.type !== 'subagent') {
        subagentEvents.get(msg.subagentId)!.push(msg);
      } else {
        topLevel.push(msg);
      }
    }

    // Attach child events to subagent parents
    for (const [subagentId, parent] of subagentParents) {
      if (parent.subagent) {
        parent.subagent.childEvents = subagentEvents.get(subagentId) ?? [];
      }
    }

    return { messages: coalesceAdjacentAssistantMessages(topLevel) };
  }

  /**
   * Project events for a specific subagent only.
   */
  static projectSubagent(events: TranscriptEvent[], subagentId: string): TranscriptViewMessage[] {
    const filtered = events.filter((e) => e.subagentId === subagentId);
    const vm = TranscriptProjector.project(filtered);
    return vm.messages;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coalesceAdjacentAssistantMessages(
  messages: TranscriptViewMessage[],
): TranscriptViewMessage[] {
  const coalesced: TranscriptViewMessage[] = [];

  for (const message of messages) {
    const previous = coalesced[coalesced.length - 1];
    if (
      previous &&
      previous.type === 'assistant_message' &&
      message.type === 'assistant_message' &&
      previous.subagentId === message.subagentId &&
      previous.mode === message.mode &&
      // Don't fuse a thinking-only message into a regular text message --
      // the renderer needs them as distinct UI blocks.
      previous.thinking === undefined &&
      message.thinking === undefined
    ) {
      previous.text = `${previous.text ?? ''}${message.text ?? ''}`;
      continue;
    }

    coalesced.push(message);
  }

  return coalesced;
}

function projectEvent(
  event: TranscriptEvent,
  progressByParent: Map<number, TranscriptEvent[]>,
): TranscriptViewMessage {
  const base: TranscriptViewMessage = {
    id: event.id,
    sequence: event.sequence,
    createdAt: event.createdAt,
    type: event.eventType,
    subagentId: event.subagentId,
  };

  switch (event.eventType) {
    case 'user_message': {
      const p = event.payload as unknown as UserMessagePayload;
      base.text = event.searchableText ?? undefined;
      base.mode = p.mode;
      if (p.attachments) {
        base.attachments = p.attachments;
      }
      break;
    }
    case 'assistant_message': {
      const p = event.payload as unknown as AssistantMessagePayload;
      base.text = event.searchableText ?? undefined;
      base.mode = p.mode;
      if (p.thinking !== undefined) base.thinking = p.thinking;
      if (p.model !== undefined) base.model = p.model;
      break;
    }
    case 'system_message': {
      const p = event.payload as unknown as SystemMessagePayload;
      base.text = event.searchableText ?? undefined;
      base.systemMessage = p;
      if (p.systemType === 'error') {
        base.isError = true;
      }
      if (p.isAuthError) {
        base.isAuthError = true;
      }
      break;
    }
    case 'tool_call': {
      const p = event.payload as unknown as ToolCallPayload;
      const progressEvents = progressByParent.get(event.id) ?? [];
      base.toolCall = {
        toolName: p.toolName,
        toolDisplayName: p.toolDisplayName,
        status: p.status,
        description: p.description,
        arguments: p.arguments,
        targetFilePath: p.targetFilePath,
        mcpServer: p.mcpServer,
        mcpTool: p.mcpTool,
        result: p.result,
        isError: p.isError,
        exitCode: p.exitCode,
        durationMs: p.durationMs,
        changes: p.changes,
        providerToolCallId: event.providerToolCallId,
        progress: progressEvents.map((pe) => {
          const pp = pe.payload as unknown as ToolProgressPayload;
          return {
            elapsedSeconds: pp.elapsedSeconds,
            progressContent: pp.progressContent,
          };
        }),
      };
      break;
    }
    case 'interactive_prompt': {
      const prompt = event.payload as unknown as InteractivePromptPayload;
      base.interactivePrompt = prompt;
      // Populate a synthetic toolCall so that existing custom widgets
      // (ToolPermissionWidget, AskUserQuestionWidget, etc.) can render
      // without changes -- they access data via message.toolCall.
      base.toolCall = interactivePromptToToolCall(prompt, event.providerToolCallId);
      break;
    }
    case 'subagent': {
      const p = event.payload as unknown as SubagentPayload;
      base.subagent = {
        ...p,
        childEvents: [],
      };
      base.toolCall = {
        toolName: 'Task',
        toolDisplayName: 'Task',
        status: p.status === 'completed' ? 'completed' : 'running',
        description: null,
        arguments: {
          prompt: p.prompt,
          ...(p.isBackground ? { run_in_background: true } : {}),
          ...(p.teammateName ? { name: p.teammateName } : {}),
          ...(p.teamName ? { team_name: p.teamName } : {}),
          ...(p.teammateMode ? { mode: p.teammateMode } : {}),
          ...(p.model ? { model: p.model } : {}),
        },
        targetFilePath: null,
        mcpServer: null,
        mcpTool: null,
        result: p.resultSummary,
        providerToolCallId: event.providerToolCallId ?? event.subagentId,
        progress: [],
      };
      break;
    }
    case 'turn_ended': {
      base.turnEnded = event.payload as unknown as TurnEndedPayload;
      break;
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Map an InteractivePromptPayload into a synthetic toolCall so that
// existing custom widgets (which read message.toolCall) keep working.
// ---------------------------------------------------------------------------

const PROMPT_TYPE_TO_TOOL_NAME: Record<string, string> = {
  permission_request: 'ToolPermission',
  ask_user_question: 'AskUserQuestion',
  git_commit_proposal: 'GitCommitProposal',
  exit_plan_mode: 'ExitPlanMode',
};

function interactivePromptToToolCall(
  prompt: InteractivePromptPayload,
  providerToolCallId: string | null,
): TranscriptViewMessage['toolCall'] {
  const toolName = PROMPT_TYPE_TO_TOOL_NAME[prompt.promptType] ?? prompt.promptType;
  const status: 'running' | 'completed' | 'error' =
    prompt.status === 'pending' ? 'running' : 'completed';

  // Build result from prompt resolution data
  let result: string | undefined;
  if (prompt.status !== 'pending') {
    const { promptType: _pt, status: _s, requestId: _r, ...rest } = prompt as unknown as Record<string, unknown>;
    result = JSON.stringify(rest);
  }

  return {
    toolName,
    toolDisplayName: toolName,
    status,
    description: null,
    arguments: prompt as unknown as Record<string, unknown>,
    targetFilePath: null,
    mcpServer: null,
    mcpTool: null,
    result,
    providerToolCallId: providerToolCallId ?? (prompt as any).requestId ?? null,
    progress: [],
  };
}
