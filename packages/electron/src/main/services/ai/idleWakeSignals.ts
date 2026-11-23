/**
 * Which signal tells the idle-wake guard that a session is blocked on the user,
 * and which one says it has stopped being blocked.
 *
 * Three in-memory records say a prompt is open, and each prompt path writes a
 * different subset of them:
 *
 *  - the per-session pending-prompt bit, which every path writes (provider-event
 *    prompts through `openPromptRegistry`, the MCP tool prompts directly);
 *  - `openPromptRegistry`, which counts provider-event prompts only;
 *  - `interactivePromptLiveness`, which counts MCP handler waits only
 *    (AskUserQuestion, RequestUserInput, the commit proposal, tool permission).
 *
 * The bit alone is per session, so the first of two prompts to settle can clear
 * it while the other is still open. Reading all three means a wake stays held
 * until nothing is waiting on the user. Guarding on the registry alone let a
 * drain wake preempt a lead parked on `mcp__nimbalyst__AskUserQuestion`, which
 * is the case #1557 reports.
 */

import { hasSessionPendingPrompt, onPendingPromptCleared } from './pendingPromptPersistence';
import { hasOpenPrompts } from './openPromptRegistry';
import { hasLiveInteractivePrompt } from '../../mcp/tools/interactivePromptLiveness';

/** True while the session is waiting on an interactive prompt. */
export function isSessionBlockedOnUser(sessionId: string): boolean {
  return hasSessionPendingPrompt(sessionId)
    || hasOpenPrompts(sessionId)
    || hasLiveInteractivePrompt(sessionId);
}

/**
 * Subscribe to "a prompt on this session was cleared". Fires on every clear, so
 * the session may still be blocked by another open prompt; listeners re-check
 * `isSessionBlockedOnUser`.
 */
export function onSessionUnblocked(listener: (sessionId: string) => void): () => void {
  return onPendingPromptCleared(listener);
}
