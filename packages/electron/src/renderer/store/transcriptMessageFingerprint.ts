import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';

/**
 * Content identity for transcript view messages whose ids come from
 * different id spaces (raw-anchored history pages vs canonical/live event
 * ids). Used to dedupe overlapping projections of the same underlying raw
 * rows when ids cannot be compared.
 */
export function transcriptMessageFingerprint(message: TranscriptViewMessage): string {
  const createdAt = message.createdAt instanceof Date
    ? message.createdAt.getTime()
    : new Date(message.createdAt as any).getTime();
  return [
    Number.isFinite(createdAt) ? createdAt : 0,
    message.type,
    message.text ?? '',
    message.toolCall?.providerToolCallId ?? '',
    message.toolCall?.toolName ?? '',
    message.subagentId ?? '',
  ].join('\u001f');
}
