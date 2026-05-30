/**
 * Descriptor processor -- maps CanonicalEventDescriptor values to TranscriptWriter
 * calls and maintains the tool/subagent ID tracking maps.
 *
 * Shared between TranscriptTransformer (server-side, DB-backed) and
 * projectRawMessages (client-side, in-memory) so both paths produce
 * identical canonical events.
 */

import type { TranscriptWriter } from './TranscriptWriter';
import type { ITranscriptEventStore, TranscriptEvent } from './types';
import type { CanonicalEventDescriptor } from './parsers/IRawMessageParser';

function isActiveToolCallEvent(event: TranscriptEvent): boolean {
  const payload = event.payload as Record<string, unknown>;
  const status = payload.status;
  return status === 'running' || status === 'pending' || status == null;
}

function isDuplicateToolStart(
  existing: TranscriptEvent,
  toolName: string,
): boolean {
  const existingToolName = (existing.payload as Record<string, unknown>).toolName;
  return existingToolName === toolName && isActiveToolCallEvent(existing);
}

/**
 * Synthetic edit-group IDs minted by CodexRawParser / CodexAppServerRawParser
 * (`nimtc|<rawItemId>|<ts>|<idx>`) are per-MCP-call, not per-turn. If two raw
 * messages -- one SDK-shape, one app-server-shape -- both resolve to the same
 * synthetic ID for a single MCP call (we've seen this happen for
 * developer_git_commit_proposal when auto-commit runs in a session that has
 * been resumed across SDK/app-server transport boundaries), the second
 * tool_call_started must NOT create a second canonical event even if the
 * first has already completed. The toolName-and-active dedup above only
 * suppresses while the first event is still running.
 */
function isSyntheticCodexLookupId(id: string): boolean {
  return id.startsWith('nimtc|');
}

export async function processDescriptor(
  writer: TranscriptWriter,
  store: ITranscriptEventStore,
  sessionId: string,
  desc: CanonicalEventDescriptor,
  toolEventIds: Map<string, number>,
  subagentEventIds: Map<string, number>,
): Promise<TranscriptEvent | null> {
  switch (desc.type) {
    case 'user_message': {
      return writer.appendUserMessage(sessionId, desc.text, {
        mode: desc.mode,
        attachments: desc.attachments,
        createdAt: desc.createdAt,
      });
    }

    case 'assistant_message': {
      return writer.appendAssistantMessage(sessionId, desc.text, {
        mode: desc.mode,
        createdAt: desc.createdAt,
        thinking: desc.thinking,
        thinkingSignature: desc.thinkingSignature,
        model: desc.model,
      });
    }

    case 'system_message': {
      return writer.appendSystemMessage(sessionId, desc.text, {
        systemType: desc.systemType,
        searchable: desc.searchable,
        createdAt: desc.createdAt,
        isAuthError: desc.isAuthError,
        reminderKind: desc.reminderKind,
        deniedToolName: desc.deniedToolName,
        deniedReason: desc.deniedReason,
        deniedReasonType: desc.deniedReasonType,
        deniedInput: desc.deniedInput,
      });
    }

    case 'tool_call_started': {
      if (desc.providerToolCallId) {
        const isSynthetic = isSyntheticCodexLookupId(desc.providerToolCallId);
        // In-memory dedup: same provider id, same toolName, and still-active
        // existing event means the parser saw this tool call twice in one
        // batch (genuine duplicate). Once the older event is completed or
        // errored, the same id/toolName pair may legitimately refer to a new
        // later-turn Codex tool call and must create a fresh event/card.
        //
        // Exception: synthetic `nimtc|...` IDs encode rawItemId + msg
        // timestamp + msg row id, so a collision means two raw messages
        // resolved to the same edit-group for the *same* MCP call (typically
        // SDK and app-server shapes of the same item.completed during a
        // transport upgrade). Suppress the second start even if the first
        // event is already completed.
        const existingId = toolEventIds.get(desc.providerToolCallId);
        if (existingId !== undefined) {
          const existing = await store.getEventById(existingId);
          if (existing && (isDuplicateToolStart(existing, desc.toolName) || isSynthetic)) {
            return null;
          }
        } else {
          // DB fallback for the desktop incremental path: the in-memory map
          // is fresh per batch but the DB may already hold this id from an
          // earlier batch.
          const existing = await store.findByProviderToolCallId(desc.providerToolCallId, sessionId);
          if (existing && (isDuplicateToolStart(existing, desc.toolName) || isSynthetic)) {
            toolEventIds.set(desc.providerToolCallId, existing.id);
            return null;
          }
        }
      }
      const event = await writer.createToolCall(sessionId, {
        toolName: desc.toolName,
        toolDisplayName: desc.toolDisplayName,
        arguments: desc.arguments,
        targetFilePath: desc.targetFilePath,
        mcpServer: desc.mcpServer,
        mcpTool: desc.mcpTool,
        providerToolCallId: desc.providerToolCallId,
        subagentId: desc.subagentId,
        createdAt: desc.createdAt,
      });
      if (desc.providerToolCallId) {
        toolEventIds.set(desc.providerToolCallId, event.id);
      }
      return event;
    }

    case 'tool_call_completed': {
      let eventId = toolEventIds.get(desc.providerToolCallId);
      if (!eventId) {
        const existing = await store.findByProviderToolCallId(desc.providerToolCallId, sessionId);
        if (existing) {
          eventId = existing.id;
          toolEventIds.set(desc.providerToolCallId, eventId);
        }
      }
      if (!eventId) return null;

      await writer.updateToolCall(eventId, {
        status: desc.status,
        result: desc.result,
        isError: desc.isError,
        exitCode: desc.exitCode,
        durationMs: desc.durationMs,
      });
      return store.getEventById(eventId);
    }

    case 'tool_progress': {
      const parentEventId = toolEventIds.get(desc.providerToolCallId);
      if (!parentEventId) return null;

      return writer.appendToolProgress(sessionId, {
        parentEventId,
        toolName: desc.toolName,
        elapsedSeconds: desc.elapsedSeconds,
        progressContent: desc.progressContent,
        subagentId: desc.subagentId,
        createdAt: desc.createdAt,
      });
    }

    case 'subagent_started': {
      const event = await writer.createSubagent(sessionId, {
        subagentId: desc.subagentId,
        agentType: desc.agentType,
        teammateName: desc.teammateName,
        teamName: desc.teamName,
        teammateMode: desc.teammateMode,
        isBackground: desc.isBackground,
        prompt: desc.prompt,
        createdAt: desc.createdAt,
      });
      subagentEventIds.set(desc.subagentId, event.id);
      toolEventIds.set(desc.subagentId, event.id);
      return event;
    }

    case 'subagent_completed': {
      const eventId = subagentEventIds.get(desc.subagentId);
      if (!eventId) return null;

      await writer.updateSubagent(eventId, {
        status: desc.status,
        resultSummary: desc.resultSummary,
      });
      return store.getEventById(eventId);
    }

    case 'interactive_prompt_created': {
      return writer.createInteractivePrompt(sessionId, desc.payload, {
        subagentId: desc.subagentId,
        createdAt: desc.createdAt,
      });
    }

    case 'interactive_prompt_updated': {
      return null;
    }

    case 'turn_ended': {
      return writer.recordTurnEnded(sessionId, {
        contextFill: desc.contextFill,
        contextWindow: desc.contextWindow,
        cumulativeUsage: desc.cumulativeUsage,
        contextCompacted: desc.contextCompacted,
        subagentId: desc.subagentId,
      });
    }

    default:
      return null;
  }
}

export function selectRawParser(
  provider: string,
): 'codex' | 'codex-acp' | 'copilot' | 'claude-code' | 'opencode' {
  if (provider === 'copilot-cli') {
    return 'copilot';
  }
  if (provider === 'openai-codex') {
    return 'codex';
  }
  if (provider === 'openai-codex-acp') {
    return 'codex-acp';
  }
  if (provider === 'opencode') {
    return 'opencode';
  }
  return 'claude-code';
}
