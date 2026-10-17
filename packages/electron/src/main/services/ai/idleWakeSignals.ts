/**
 * Which signal tells the idle-wake guard that a session is blocked on the user,
 * and which one says it has stopped being blocked.
 *
 * The per-session pending-prompt bit is the only signal every prompt path
 * writes. Provider-event prompts reach it through `openPromptRegistry`; the MCP
 * tool prompts (AskUserQuestion, RequestUserInput, the commit proposal, tool
 * permission) write it directly and never touch the registry. Guarding on the
 * registry alone let a drain wake preempt a lead parked on
 * `mcp__nimbalyst__AskUserQuestion`, which is the case #1557 reports.
 */

import { hasSessionPendingPrompt, onPendingPromptCleared } from './pendingPromptPersistence';

/** True while the session is waiting on an interactive prompt. */
export function isSessionBlockedOnUser(sessionId: string): boolean {
  return hasSessionPendingPrompt(sessionId);
}

/** Subscribe to "this session is no longer waiting on the user". */
export function onSessionUnblocked(listener: (sessionId: string) => void): () => void {
  return onPendingPromptCleared(listener);
}
