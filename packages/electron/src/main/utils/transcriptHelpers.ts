import { AgentMessagesRepository, AISessionsRepository, TranscriptMigrationRepository } from '@nimbalyst/runtime';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript';
import type { AgentMessage } from '@nimbalyst/runtime/ai/server/types';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript';
import { TranscriptProjector } from '@nimbalyst/runtime/ai/server/transcript';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';

/**
 * Load projected transcript view messages for a session.
 * Shared helper used by ExportHandlers and ShareHandlers.
 */
export async function loadViewMessages(
  sessionId: string,
  provider: string,
): Promise<{ success: true; messages: TranscriptViewMessage[] } | { success: false; error: string }> {
  if (!TranscriptMigrationRepository.hasService()) {
    return { success: false, error: 'TranscriptMigrationService not available' };
  }
  const messages = await TranscriptMigrationRepository.getService().getViewMessages(sessionId, provider);
  return { success: true, messages };
}

const MOBILE_TRANSCRIPT_TAIL_TEXT_LIMIT = 6000;
const MOBILE_TRANSCRIPT_TAIL_PROGRESS_LIMIT = 400;
const MOBILE_TRANSCRIPT_TAIL_MAX_RAW_MESSAGES = 1500;

function agentMessageToRawMessage(message: AgentMessage): RawMessage {
  return {
    id: Number(message.id ?? 0),
    sessionId: message.sessionId,
    source: message.source,
    direction: message.direction,
    content: message.content,
    createdAt: message.createdAt ?? new Date(),
    metadata: message.metadata,
    hidden: message.hidden ?? false,
  };
}

async function listRawMessageTail(sessionId: string, count: number): Promise<AgentMessage[]> {
  const limit = Math.max(1, Math.min(count, MOBILE_TRANSCRIPT_TAIL_MAX_RAW_MESSAGES));
  return AgentMessagesRepository.listTail(sessionId, limit);
}

function truncateMobileTailText(value: string | undefined, limit: number): string | undefined {
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated on mobile sync; view full transcript on desktop]`;
}

export function serializeMobileTranscriptTail(messages: TranscriptViewMessage[]): string {
  return JSON.stringify(messages.map((message) => {
    const normalized: any = {
      ...message,
      createdAt: message.createdAt instanceof Date
        ? message.createdAt.getTime()
        : typeof message.createdAt === 'number'
          ? message.createdAt
          : Date.now(),
      text: truncateMobileTailText(message.text, MOBILE_TRANSCRIPT_TAIL_TEXT_LIMIT),
      thinking: truncateMobileTailText(message.thinking, MOBILE_TRANSCRIPT_TAIL_TEXT_LIMIT / 2),
    };

    if (message.toolCall) {
      normalized.toolCall = {
        ...message.toolCall,
        description: truncateMobileTailText(message.toolCall.description ?? undefined, 1200) ?? null,
        result: truncateMobileTailText(message.toolCall.result ?? undefined, MOBILE_TRANSCRIPT_TAIL_TEXT_LIMIT / 2),
        progress: Array.isArray(message.toolCall.progress)
          ? message.toolCall.progress.slice(-5).map((progress) => ({
              ...progress,
              progressContent: truncateMobileTailText(progress.progressContent, MOBILE_TRANSCRIPT_TAIL_PROGRESS_LIMIT) ?? '',
            }))
          : [],
        changes: undefined,
      };
    }

    if (message.subagent?.childEvents) {
      normalized.subagent = {
        ...message.subagent,
        childEvents: undefined,
      };
    }

    return normalized;
  }));
}

export async function getMobileTranscriptTailJson(
  sessionId: string,
  count: number,
) : Promise<string | null> {
  if (!TranscriptMigrationRepository.hasService()) return null;

  const session = await AISessionsRepository.get(sessionId);
  if (!session) return null;

  const provider = session.provider ?? 'unknown';
  const targetMessageCount = Math.max(1, count);
  const rawTailCount = Math.min(
    MOBILE_TRANSCRIPT_TAIL_MAX_RAW_MESSAGES,
    Math.max(targetMessageCount * 3, 350),
  );
  const rawTail = await listRawMessageTail(sessionId, rawTailCount);
  const messages = (await projectRawMessagesToViewMessages(
    rawTail.map(agentMessageToRawMessage),
    provider,
  )).slice(-targetMessageCount);

  if (messages.length === 0) return null;
  return serializeMobileTranscriptTail(messages);
}
