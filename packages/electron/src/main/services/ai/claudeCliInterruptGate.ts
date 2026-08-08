/**
 * "A stop press is still escalating" gate for `claude-code-cli` sessions.
 *
 * `interruptClaudeCliTurn` escalates: Ctrl-C, settle 1500ms, re-check, maybe
 * Ctrl-C again, maybe SIGINT (see `claudeCliInterrupt`). The first Ctrl-C
 * usually ends the turn in a few hundred milliseconds, which fires the PID
 * watcher's idle edge, which flushes the next queued prompt, which starts a NEW
 * turn — all inside the escalation's settle window. The escalation's re-check
 * then reads `running`, cannot tell the new turn from the old one refusing to
 * die, and its second Ctrl-C kills the queued prompt; the TUI restores the
 * interrupted text into the prompt box, where it sits unsent.
 *
 * The queue flusher therefore holds off while this gate is marked, and retries
 * once it clears (`waitUntilClear`). Same shape as `claudeCliSubmitLatch`, which
 * guards the other half of the same one-keyboard problem: only one writer may
 * own the CLI's input at a time.
 */

const inFlight = new Set<string>();
const waiters = new Map<string, Array<() => void>>();

export const claudeCliInterruptGate = {
  /** Record that an interrupt escalation for this session has started. */
  mark(sessionId: string): void {
    inFlight.add(sessionId);
  },

  /** True while a stop press is still escalating for this session. */
  isInFlight(sessionId: string): boolean {
    return inFlight.has(sessionId);
  },

  /** Release the gate and wake anything waiting to flush. */
  clear(sessionId: string): void {
    inFlight.delete(sessionId);
    const pending = waiters.get(sessionId);
    if (pending) {
      waiters.delete(sessionId);
      for (const resolve of pending) resolve();
    }
  },

  /** Resolves when the gate is clear for this session (immediately if it is). */
  waitUntilClear(sessionId: string): Promise<void> {
    if (!inFlight.has(sessionId)) return Promise.resolve();
    return new Promise((resolve) => {
      const pending = waiters.get(sessionId) ?? [];
      pending.push(resolve);
      waiters.set(sessionId, pending);
    });
  },
};
