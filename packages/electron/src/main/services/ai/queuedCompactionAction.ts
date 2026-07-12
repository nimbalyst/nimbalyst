import type { ContextCompactionResult } from '@nimbalyst/runtime/ai/server';
import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';

export const QUEUED_COMPACTION_PROMPT_ORIGIN = 'agent_compaction';

export interface QueuedCompactionPromptLike {
  prompt: string;
  documentContext?: DocumentContext | null;
}

/** Only an explicitly tagged, exact action can bypass the normal model turn. */
export function isQueuedCompactionAction(prompt: QueuedCompactionPromptLike): boolean {
  return prompt.prompt === '/compact'
    && prompt.documentContext?.promptOrigin === QUEUED_COMPACTION_PROMPT_ORIGIN;
}

/**
 * Execute a tagged compaction action through the provider-native path. Returns
 * false for ordinary prompts so the queue dispatcher can send them normally.
 */
export async function dispatchQueuedCompactionAction(
  prompt: QueuedCompactionPromptLike,
  compact: () => Promise<ContextCompactionResult>,
): Promise<boolean> {
  if (!isQueuedCompactionAction(prompt)) return false;

  const result = await compact();
  if (!result.supported || !result.compacted) {
    throw new Error(result.error || 'Provider-native compaction did not complete');
  }
  return true;
}
