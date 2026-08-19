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
 *
 * This also notifies `TrayManager`, so the menu bar can never disagree with the
 * sidebar about whether a session is blocked. It used to be a second call every
 * callsite had to remember, and the MCP AskUserQuestion path made neither call
 * for SDK sessions -- a session waiting on a question showed as "Running" in the
 * menu bar panel. Notify here and there is nothing left to forget.
 */

import { AISessionsRepository } from '@nimbalyst/runtime';
import { getSyncProvider } from '../SyncManager';
import { requestMobilePush } from './mobilePushRequest';
import { TrayManager } from '../../tray/TrayManager';
import { logger } from '../../utils/logger';

/**
 * NIM-2208: session ids whose bit this process has set since startup.
 *
 * The stale-prompt reconcile needs the (normally empty) set of sessions carrying
 * the bit. Reading it back from the DB meant a `SELECT id, metadata FROM
 * ai_sessions` scan over every session row — 5k+ on a working install — on every
 * pass. This function is the single writer of the bit, and the startup sweep
 * clears every row before anything can set one, so an in-memory mirror is
 * authoritative for the running process and costs no query at all.
 */
const sessionsWithPendingPrompt = new Set<string>();

/** Sessions currently carrying a pending-prompt bit set by this process. */
export function getSessionsWithPendingPrompt(): string[] {
  return [...sessionsWithPendingPrompt];
}

/** Reset the mirror; called by the startup sweep once every row is cleared. */
export function resetPendingPromptTracking(): void {
  sessionsWithPendingPrompt.clear();
}

export async function setSessionPendingPrompt(
  sessionId: string,
  hasPendingPrompt: boolean,
): Promise<void> {
  if (!sessionId) return;

  // A prompt that is already open must not push again -- repeated sets would
  // burn the server's forced-push budget on a single blocked session.
  const wasAlreadyPending = sessionsWithPendingPrompt.has(sessionId);

  // Before the awaits: the tray is in-memory, so a slow or failed row update
  // must not leave the menu bar showing a blocked session as merely running.
  if (hasPendingPrompt) {
    TrayManager.getInstance().onPromptCreated(sessionId);
  } else {
    TrayManager.getInstance().onPromptResolved(sessionId);
  }

  try {
    await AISessionsRepository.updateMetadata(sessionId, {
      metadata: { hasPendingPrompt },
    });
    if (hasPendingPrompt) {
      sessionsWithPendingPrompt.add(sessionId);
    } else {
      sessionsWithPendingPrompt.delete(sessionId);
    }
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

  if (hasPendingPrompt && !wasAlreadyPending) {
    void notifyMobileOfBlockedSession(sessionId);
  }
}

/**
 * Page the user's phone when a session blocks on a human answer.
 *
 * Forced (#1268): a blocked agent is the case where "notify me even though I
 * appear to be at my desk" is the whole point, so the server's presence
 * suppression is deliberately bypassed and the decision is left to its
 * targeting rules. Never gate this on local presence -- doing so stops the
 * `force` flag from ever reaching the server.
 */
async function notifyMobileOfBlockedSession(sessionId: string): Promise<void> {
  try {
    const session = await AISessionsRepository.get(sessionId);
    const title = session?.title || 'AI Session';
    await requestMobilePush(sessionId, title, 'Waiting for your response', {
      force: true,
      reason: 'awaiting_human',
    });
  } catch (err) {
    logger.main.warn(
      `[pendingPromptPersistence] Failed to request mobile push for blocked session ${sessionId}:`,
      err,
    );
  }
}
