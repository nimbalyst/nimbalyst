import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { toolCallMatcher } from './ToolCallMatcher';

const DIRECT_DIFF_TOOL_NAMES = new Set(['file_change']);

interface ToolCallMessageRef {
  message: TranscriptViewMessage;
  toolCallItemId: string;
  toolCallTimestamp?: number;
}

function cloneTranscriptMessages(
  messages: TranscriptViewMessage[],
  toolRefs: ToolCallMessageRef[],
): TranscriptViewMessage[] {
  return messages.map((message) => {
    const cloned: TranscriptViewMessage = {
      ...message,
      toolCall: message.toolCall ? { ...message.toolCall } : undefined,
      subagent: message.subagent
        ? {
            ...message.subagent,
            childEvents: cloneTranscriptMessages(message.subagent.childEvents, toolRefs),
          }
        : undefined,
    };

    const toolCallItemId = cloned.toolCall?.providerToolCallId;
    if (toolCallItemId && cloned.toolCall?.result != null) {
      toolRefs.push({
        message: cloned,
        toolCallItemId,
        toolCallTimestamp: cloned.createdAt instanceof Date ? cloned.createdAt.getTime() : undefined,
      });
    }

    return cloned;
  });
}

function shouldHydrateDiffs(
  message: TranscriptViewMessage,
  matchedToolCallIds: Set<string>,
): boolean {
  const tool = message.toolCall;
  const toolCallItemId = tool?.providerToolCallId;
  if (!tool || !toolCallItemId || tool.result == null) return false;

  return matchedToolCallIds.has(toolCallItemId) || DIRECT_DIFF_TOOL_NAMES.has(tool.toolName);
}

/** Stable key for the getDiffsForSession result map (ids have no spaces; ts is numeric). */
function refKey(toolCallItemId: string, toolCallTimestamp?: number): string {
  return `${toolCallItemId} ${toolCallTimestamp ?? ''}`;
}

export async function enrichTranscriptMessagesWithToolCallDiffs(
  sessionId: string,
  messages: TranscriptViewMessage[],
): Promise<TranscriptViewMessage[]> {
  if (messages.length === 0) return messages;

  const clonedRefs: ToolCallMessageRef[] = [];
  const clonedMessages = cloneTranscriptMessages(messages, clonedRefs);
  if (clonedRefs.length === 0) return clonedMessages;

  const matches = await toolCallMatcher.getMatchesForSession(sessionId);
  const matchedToolCallIds = new Set(
    matches
      .map((match) => match.toolCallItemId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );

  const candidates = clonedRefs.filter(({ message }) => shouldHydrateDiffs(message, matchedToolCallIds));
  if (candidates.length === 0) return clonedMessages;

  // Resolve all tool-call diffs in one batched pass. getDiffsForSession loads
  // the session's invariant data (workspace, session_files, history snapshots)
  // ONCE and reuses it across every tool call -- without this, a session with
  // thousands of tool calls re-runs the same per-file queries per call (an N+1
  // that made large sessions take 60s+ to load).
  const uniqueRefs = new Map<string, { toolCallItemId: string; toolCallTimestamp?: number }>();
  for (const { toolCallItemId, toolCallTimestamp } of candidates) {
    const key = refKey(toolCallItemId, toolCallTimestamp);
    if (!uniqueRefs.has(key)) uniqueRefs.set(key, { toolCallItemId, toolCallTimestamp });
  }

  const diffsByKey = await toolCallMatcher.getDiffsForSession(sessionId, [...uniqueRefs.values()]);

  for (const { message, toolCallItemId, toolCallTimestamp } of candidates) {
    const diffs = diffsByKey.get(refKey(toolCallItemId, toolCallTimestamp));
    if (diffs && diffs.length > 0 && message.toolCall) {
      message.toolCall.fileDiffs = diffs;
    }
  }

  return clonedMessages;
}
