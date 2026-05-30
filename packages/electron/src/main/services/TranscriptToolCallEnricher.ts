import type { ToolCallDiffResult, TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { toolCallMatcher } from './ToolCallMatcher';

const DIRECT_DIFF_TOOL_NAMES = new Set(['file_change']);
const ENRICH_CONCURRENCY = 4;

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

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });

  await Promise.all(workers);
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

  const cache = new Map<string, ToolCallDiffResult[]>();

  await runWithConcurrency(candidates, ENRICH_CONCURRENCY, async ({ message, toolCallItemId, toolCallTimestamp }) => {
    const cacheKey = `${toolCallItemId}\u0000${toolCallTimestamp ?? ''}`;
    let diffs = cache.get(cacheKey);
    if (!diffs) {
      diffs = await toolCallMatcher.getDiffsForToolCall(sessionId, toolCallItemId, toolCallTimestamp);
      cache.set(cacheKey, diffs);
    }
    if (diffs.length > 0 && message.toolCall) {
      message.toolCall.fileDiffs = diffs;
    }
  });

  return clonedMessages;
}
