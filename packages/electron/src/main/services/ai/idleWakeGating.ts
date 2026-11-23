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

/** The messages held for a session, oldest first, without removing them. */
export function peekDeferredIdleWakeMessages(sessionId: string): string[] {
  return [...(deferred.get(sessionId) ?? [])];
}

/** Remove the oldest `count` held messages; ones held since stay queued. */
function removeDeferredIdleWakeMessages(sessionId: string, count: number): void {
  const queue = deferred.get(sessionId);
  if (!queue) return;
  queue.splice(0, count);
  if (queue.length === 0) deferred.delete(sessionId);
}

export function resetDeferredIdleWakes(): void {
  deferred.clear();
}

export interface HeldIdleWakeReleaseDeps {
  isBlockedOnUser: (sessionId: string) => boolean;
  isSessionActive: (sessionId: string) => boolean;
  /**
   * Hand the held results to the session. Resolves true once they are handed
   * off (a wake started, or a queued-prompt row persisted behind a live turn),
   * false to keep holding them. A rejection also keeps them.
   */
  deliver: (sessionId: string, message: string) => Promise<boolean>;
  logInfo: (message: string) => void;
  logWarn: (message: string, error?: unknown) => void;
}

/**
 * Release what the idle-wake guard held once the prompt that blocked the
 * session is cleared.
 *
 * Calls for one session run one after another, and a held message is removed
 * only after `deliver` handed it off: two clears in quick succession cannot
 * deliver the same result twice, and a failed hand-off keeps the result for the
 * next clear. Each pass re-checks the prompt state, so a release that races a
 * newly opened prompt keeps holding.
 */
export function createHeldIdleWakeRelease(deps: HeldIdleWakeReleaseDeps) {
  const chains = new Map<string, Promise<void>>();

  const releaseHeld = async (sessionId: string): Promise<void> => {
    for (;;) {
      const held = peekDeferredIdleWakeMessages(sessionId);
      if (held.length === 0) return;
      if (deps.isBlockedOnUser(sessionId)) {
        deps.logInfo(`[AIService] Still holding ${held.length} teammate message(s) for session ${sessionId}: another prompt is open`);
        return;
      }
      if (!deps.isSessionActive(sessionId)) {
        // Same rule as an unheld wake: a session that ended (stopped, or its
        // deferred end ran) is not woken by a late background result.
        removeDeferredIdleWakeMessages(sessionId, held.length);
        deps.logInfo(`[AIService] Dropping ${held.length} held teammate message(s) for ended session ${sessionId}`);
        return;
      }
      let delivered = false;
      try {
        delivered = await deps.deliver(sessionId, held.join('\n\n'));
      } catch (error) {
        deps.logWarn(`[AIService] Failed to deliver ${held.length} held teammate message(s) for session ${sessionId}; keeping them for the next release`, error);
        return;
      }
      if (!delivered) {
        deps.logWarn(`[AIService] Could not deliver ${held.length} held teammate message(s) for session ${sessionId}; keeping them for the next release`);
        return;
      }
      removeDeferredIdleWakeMessages(sessionId, held.length);
      deps.logInfo(`[AIService] Released ${held.length} held teammate message(s) for session ${sessionId}`);
    }
  };

  return (sessionId: string): Promise<void> => {
    const previous = chains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => releaseHeld(sessionId)).catch((error) => {
      deps.logWarn(`[AIService] Held teammate message release failed for session ${sessionId}`, error);
    });
    chains.set(sessionId, next);
    void next.then(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId);
    });
    return next;
  };
}
