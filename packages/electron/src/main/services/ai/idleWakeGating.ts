/**
 * Should a background-task drain be allowed to wake an idle lead right now?
 *
 * `finalizeBackgroundDrain` emits `teammate:messageWhileIdle` when background
 * tasks settle after the lead's turn ended, so their results reach the agent.
 * The decision of whether that wake may start a turn lives here, out of the
 * Electron handler, so it can be tested without a provider or a window.
 */

export type IdleWakeDecision =
  | { action: 'deliver' }
  | { action: 'defer'; reason: 'pending-prompt' }
  | { action: 'drop'; reason: 'session-ended' };

export function decideIdleWake(params: {
  sessionActive: boolean;
  hasPendingPrompt: boolean;
}): IdleWakeDecision {
  if (!params.sessionActive) return { action: 'drop', reason: 'session-ended' };
  // A lead parked on an interactive prompt is blocked on the user, not idle.
  // Starting a turn here tears down the MCP transport holding the open call, and
  // the agent receives a transport error in place of the answer, so the question
  // is destroyed and never re-asked (#1557).
  if (params.hasPendingPrompt) return { action: 'defer', reason: 'pending-prompt' };
  return { action: 'deliver' };
}

const deferred = new Map<string, string[]>();

export function deferIdleWakeMessage(sessionId: string, message: string): void {
  const queue = deferred.get(sessionId);
  if (queue) queue.push(message);
  else deferred.set(sessionId, [message]);
}

export function takeDeferredIdleWakeMessages(sessionId: string): string[] {
  const queue = deferred.get(sessionId);
  if (!queue) return [];
  deferred.delete(sessionId);
  return queue;
}

export function resetDeferredIdleWakes(): void {
  deferred.clear();
}
