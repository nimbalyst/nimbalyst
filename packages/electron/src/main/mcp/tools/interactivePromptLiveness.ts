// NIM-2208: a per-session count of interactive prompts that are RIGHT NOW
// blocking a turn, used to decide whether a persisted
// `ai_sessions.metadata.hasPendingPrompt` bit is stale.
//
// The bit is written by every prompt type that blocks on user input, but it was
// only ever cleared by an explicit answer/cancel or a live terminal turn event.
// A process killed by app exit emits neither, so the "awaiting input" indicator
// in AgentSessionsPopover stuck for weeks on sessions whose process was long
// gone. This registry is the "is anything actually blocked?" signal the reconcile
// needs.
//
// Deliberately SEPARATE from the NIM-1981 waiter registry in
// `interactivePromptFallback.ts`, which must keep counting RequestUserInput
// waiters only: `shouldSettleFromSessionFallback` reads "count <= 1" as "sole
// pending prompt for this session, so an unmatched response id is unambiguous".
// Folding the other prompt types into that counter would push it past 1 and
// reject a correct answer, hanging the turn.
//
// Note this covers the MCP-handler path only. Provider-driven prompts
// (ExitPlanMode and friends in `MessageStreamingHandler`) set the bit without
// registering an MCP waiter, so the reconcile pairs this with a
// session-is-tracked-in-memory check rather than trusting it alone.

/** Per-session count of interactive prompts currently blocking a turn. */
const liveInteractivePrompts = new Map<string, number>();
const clearedListeners = new Map<string, Set<() => void>>();

/** Subscribe to the last live prompt settling, including late abort cleanup. */
export function onInteractivePromptsCleared(sessionKey: string, listener: () => void): () => void {
  const listeners = clearedListeners.get(sessionKey) ?? new Set<() => void>();
  listeners.add(listener);
  clearedListeners.set(sessionKey, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && clearedListeners.get(sessionKey) === listeners) {
      clearedListeners.delete(sessionKey);
    }
  };
}

/** Record that an interactive prompt has begun blocking a session's turn. */
export function noteLiveInteractivePrompt(sessionKey: string): void {
  if (!sessionKey) return;
  liveInteractivePrompts.set(sessionKey, (liveInteractivePrompts.get(sessionKey) ?? 0) + 1);
}

/** Record that an interactive prompt has settled (answered, cancelled, or timed out). */
export function clearLiveInteractivePrompt(sessionKey: string): void {
  if (!sessionKey) return;
  const previous = liveInteractivePrompts.get(sessionKey) ?? 0;
  const next = previous - 1;
  if (next <= 0) {
    liveInteractivePrompts.delete(sessionKey);
    if (previous > 0) {
      for (const listener of [...(clearedListeners.get(sessionKey) ?? [])]) listener();
    }
  } else {
    liveInteractivePrompts.set(sessionKey, next);
  }
}

/** How many interactive prompts are currently blocking this session's turn. */
export function countLiveInteractivePrompts(sessionKey: string): number {
  return liveInteractivePrompts.get(sessionKey) ?? 0;
}

/** Whether any interactive prompt is currently blocking this session's turn. */
export function hasLiveInteractivePrompt(sessionKey: string): boolean {
  return countLiveInteractivePrompts(sessionKey) > 0;
}
