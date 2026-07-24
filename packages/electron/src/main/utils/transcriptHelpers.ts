import { TranscriptMigrationRepository } from '@nimbalyst/runtime';
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
