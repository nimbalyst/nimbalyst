/**
 * "A prompt is on its way to the CLI" latch for `claude-code-cli` sessions.
 *
 * Writing to the PTY is not the same as the CLI having received it. ConPTY hands
 * input to the child at roughly 31,000 characters per second (measured on
 * Windows against claude 2.1.220), so a 250k-character paste is still arriving
 * about eight seconds after `writeToTerminal` returns. Throughout that window the
 * CLI has not started a turn, so its PID file still reads `idle`.
 *
 * Every queue-flush trigger keys off that idle signal — the PID watcher's
 * running->idle transition, `ai:createQueuedPrompt`, and
 * `dispatchQueuedPromptToClaudeCli`. Without this latch they would each treat a
 * mid-delivery session as ready and write a SECOND prompt into the same terminal.
 * The second prompt queues behind the first one's Enter, so it lands in the
 * prompt box after the first turn has already started and simply sits there
 * unsent until someone presses Enter by hand.
 *
 * The latch is set when we submit and released when the PID watcher reports the
 * turn actually started. The deadline is only a safety valve: if the CLI never
 * picks the prompt up, the queue must not stay blocked forever.
 */

/** Conservative delivery rate: 20k chars/sec, well under the ~31k measured. */
const ASSUMED_PTY_CHARS_PER_SECOND = 20_000;
/** Even a tiny prompt needs a moment to reach the CLI and flip its PID file. */
const MIN_DEADLINE_MS = 3_000;
/** Hard ceiling so a pathological payload can't stall the queue indefinitely. */
const MAX_DEADLINE_MS = 120_000;

/** How long to hold the latch for a payload of this size, absent a turn signal. */
export function submitDrainDeadlineMs(payloadLength: number): number {
  const drainMs = Math.ceil((payloadLength / ASSUMED_PTY_CHARS_PER_SECOND) * 1000);
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, drainMs));
}

export interface ClaudeCliSubmitLatch {
  /** Record that `payloadLength` characters were just written to this session's PTY. */
  mark(sessionId: string, payloadLength: number): void;
  /** True while a submit is still expected to be in transit. */
  isInFlight(sessionId: string): boolean;
  /** Milliseconds until the latch lifts on its own; 0 when it is not held. */
  remainingMs(sessionId: string): number;
  /** Release the latch — the CLI has demonstrably picked the prompt up. */
  clear(sessionId: string): void;
}

export function createClaudeCliSubmitLatch(
  options: { now?: () => number } = {},
): ClaudeCliSubmitLatch {
  const now = options.now ?? (() => Date.now());
  const deadlines = new Map<string, number>();

  return {
    mark(sessionId, payloadLength) {
      // One submit is several writes (payload, then Enter — the slash-command
      // path is more). Extend, never shorten: the trailing one-character Enter
      // must not replace the big payload's deadline with the 3s floor.
      const next = now() + submitDrainDeadlineMs(payloadLength);
      const existing = deadlines.get(sessionId);
      deadlines.set(sessionId, existing === undefined ? next : Math.max(existing, next));
    },
    isInFlight(sessionId) {
      const deadline = deadlines.get(sessionId);
      if (deadline === undefined) return false;
      if (now() > deadline) {
        deadlines.delete(sessionId);
        return false;
      }
      return true;
    },
    remainingMs(sessionId) {
      const deadline = deadlines.get(sessionId);
      if (deadline === undefined) return 0;
      return Math.max(0, deadline - now());
    },
    clear(sessionId) {
      deadlines.delete(sessionId);
    },
  };
}

/** Process-wide latch shared by the submit path, the PID watcher, and the flusher. */
export const claudeCliSubmitLatch = createClaudeCliSubmitLatch();
