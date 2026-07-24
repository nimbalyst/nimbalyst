/**
 * Persist the per-session "interactive prompt is open" bit to
 * `ai_sessions.metadata.hasPendingPrompt` and push the same change to
 * connected mobile clients.
 *
 * This is the authoritative source for "Waiting for your response" sidebar
 * indicators across desktop ↔ mobile. The renderer reads it on session list
 * load via `hasPendingInteractivePrompt`, so a stuck atom from a missed
 * resolve event is healed on the next session list refresh.
 *
 * Callers: every place that opens or resolves an interactive prompt
 * (AskUserQuestion, ExitPlanMode, ToolPermission, GitCommitProposal,
 * RequestUserInput / PromptForUserInput).
 */

import { AISessionsRepository } from '@nimbalyst/runtime';
import { getSyncProvider } from '../SyncManager';
import { logger } from '../../utils/logger';

export async function setSessionPendingPrompt(
  sessionId: string,
  hasPendingPrompt: boolean,
): Promise<void> {
  if (!sessionId) return;

  try {
    await AISessionsRepository.updateMetadata(sessionId, {
      metadata: { hasPendingPrompt },
    });
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to persist hasPendingPrompt=${hasPendingPrompt} for session ${sessionId}:`,
      err,
    );
  }

  try {
    const sp = getSyncProvider();
    if (sp) {
      sp.pushChange(sessionId, {
        type: 'metadata_updated',
        metadata: { hasPendingPrompt, updatedAt: Date.now() } as any,
      });
    }
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to push hasPendingPrompt sync change for session ${sessionId}:`,
      err,
    );
  }
}
