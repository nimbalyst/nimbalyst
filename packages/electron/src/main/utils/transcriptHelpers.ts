import { AgentMessagesRepository, AISessionsRepository, TranscriptMigrationRepository } from '@nimbalyst/runtime';
import { projectRawMessagesToViewMessages } from '@nimbalyst/runtime/ai/server/transcript';
import type { AgentMessage } from '@nimbalyst/runtime/ai/server/types';
import type { RawMessage } from '@nimbalyst/runtime/ai/server/transcript';
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
const MOBILE_TRANSCRIPT_HISTORY_PAGE_MAX_RAW_MESSAGES = 450;

export interface MobileTranscriptHistoryPageRequest {
  count?: number;
  beforeRawMessageId?: number | null;
  requestId?: string;
}

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

async function listRawMessagesBefore(
  sessionId: string,
  beforeRawMessageId: number | null | undefined,
  count: number,
): Promise<AgentMessage[]> {
  const limit = Math.max(1, Math.min(count, MOBILE_TRANSCRIPT_HISTORY_PAGE_MAX_RAW_MESSAGES));
  return AgentMessagesRepository.listBefore(sessionId, beforeRawMessageId, limit);
}

function truncateMobileTailText(value: string | undefined, limit: number): string | undefined {
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[truncated on mobile sync; view full transcript on desktop]`;
}

function normalizeMobileTranscriptMessage(message: TranscriptViewMessage): any {
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
}

export function serializeMobileTranscriptTail(messages: TranscriptViewMessage[]): string {
  return JSON.stringify(messages.map(normalizeMobileTranscriptMessage));
}

export function serializeMobileTranscriptHistoryPage(page: {
  version: 1;
  sessionId: string;
  requestId?: string;
  beforeRawMessageId: number | null;
  rawStartId: number | null;
  rawEndId: number | null;
  rawMessageCount: number;
  projectedMessageCount: number;
  hasMoreBefore: boolean;
  messages: TranscriptViewMessage[];
}): string {
  return JSON.stringify({
    ...page,
    messages: page.messages.map(normalizeMobileTranscriptMessage),
  });
}

export async function getMobileTranscriptHistoryPageJson(
  sessionId: string,
  request: MobileTranscriptHistoryPageRequest = {},
): Promise<string | null> {
  if (!TranscriptMigrationRepository.hasService()) return null;

  const session = await AISessionsRepository.get(sessionId);
  if (!session) return null;

  const provider = session.provider ?? 'unknown';
  const beforeRawMessageId = typeof request.beforeRawMessageId === 'number' && Number.isFinite(request.beforeRawMessageId)
    ? Math.max(1, Math.floor(request.beforeRawMessageId))
    : null;
  const rawLimit = Number.isFinite(request.count)
    ? Math.max(40, Math.min(MOBILE_TRANSCRIPT_HISTORY_PAGE_MAX_RAW_MESSAGES, Math.floor(request.count as number)))
    : 240;
  const rawPage = await listRawMessagesBefore(sessionId, beforeRawMessageId, rawLimit);
  const rawStartId = rawPage[0]?.id != null ? Number(rawPage[0].id) : null;
  const rawEndId = rawPage[rawPage.length - 1]?.id != null ? Number(rawPage[rawPage.length - 1].id) : null;
  const hasMoreBefore = rawStartId != null
    ? (await listRawMessagesBefore(sessionId, rawStartId, 1)).length > 0
    : false;
  const messages = rawPage.length > 0
    ? await projectRawMessagesToViewMessages(rawPage.map(agentMessageToRawMessage), provider)
    : [];

  return serializeMobileTranscriptHistoryPage({
    version: 1,
    sessionId,
    requestId: request.requestId,
    beforeRawMessageId,
    rawStartId,
    rawEndId,
    rawMessageCount: rawPage.length,
    projectedMessageCount: messages.length,
    hasMoreBefore,
    messages,
  });
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
