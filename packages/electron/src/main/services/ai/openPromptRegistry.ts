/**
 * Correlates the per-session `hasPendingPrompt` bit with the individual
 * interactive prompts that are actually open.
 *
 * `setSessionPendingPrompt` writes one boolean per SESSION, but a session can
 * have several prompts open at once — two questions, or a question and a tool
 * permission. Every callsite used to write that boolean directly, so whichever
 * prompt settled first cleared the bit for all of them and the sidebar, menu
 * bar, and mobile client stopped advertising a prompt the user still had to
 * answer. Cancelling Q1 while Q2 was open is the reproducible case. Refs #1549.
 *
 * This is not a second storage authority: `pendingPromptPersistence` remains
 * the single writer of the bit, and this module is the arithmetic that decides
 * when to ask it for a change. The ids live in memory only, which is the same
 * lifetime the prompts themselves have — a restart drops both, and the startup
 * sweep clears the persisted bits.
 */

import { setSessionPendingPrompt } from './pendingPromptPersistence';
import type { PromptKind } from '../../tray/fleetSnapshot';

const openPromptIdsBySession = new Map<string, Set<string>>();

/** Register a newly opened prompt and block the session if it is the first. */
export function openPrompt(sessionId: string, promptId: string, kind: PromptKind = 'approval'): void {
  if (!sessionId || !promptId) return;
  let ids = openPromptIdsBySession.get(sessionId);
  if (!ids) {
    ids = new Set<string>();
    openPromptIdsBySession.set(sessionId, ids);
  }
  ids.add(promptId);
  // Unconditional: `setSessionPendingPrompt` already suppresses a duplicate
  // mobile page, and re-asserting the bit heals a session whose state drifted.
  void setSessionPendingPrompt(sessionId, true, kind);
}

/**
 * Settle one prompt — answered, cancelled, aborted, denied, all the same here.
 * The bit is cleared only once nothing else is waiting on the user.
 */
export function resolvePrompt(sessionId: string, promptId: string): void {
  if (!sessionId || !promptId) return;
  const ids = openPromptIdsBySession.get(sessionId);
  // Not tracked: either already settled, or dropped by terminal cleanup. Either
  // way the bit is not ours to touch — clearing here is what would resurrect
  // state on a stopped session.
  if (!ids || !ids.delete(promptId)) return;
  if (ids.size === 0) {
    openPromptIdsBySession.delete(sessionId);
    void setSessionPendingPrompt(sessionId, false);
  }
}

/** True while the session is still waiting on at least one prompt. */
export function hasOpenPrompts(sessionId: string): boolean {
  return (openPromptIdsBySession.get(sessionId)?.size ?? 0) > 0;
}

/**
 * Drop every prompt for a session at once — the session stopped, completed, or
 * errored, so nothing it was waiting on can still be answered.
 */
export function clearOpenPrompts(sessionId: string): void {
  if (!sessionId) return;
  const had = openPromptIdsBySession.delete(sessionId);
  if (had) void setSessionPendingPrompt(sessionId, false);
}

/** Test seam: drop all tracked state. */
export function __resetOpenPromptRegistry(): void {
  openPromptIdsBySession.clear();
}
