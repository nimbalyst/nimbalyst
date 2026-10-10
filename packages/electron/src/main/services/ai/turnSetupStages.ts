/**
 * Timing and cancellation for the awaited setup a turn runs before the
 * provider is called (inbox, question supersede, provider init, file watcher,
 * Codex workflow exports).
 *
 * Two prompts were lost after their sessions showed Running for minutes and
 * never reached the provider, and nothing in the log said which step they
 * were stuck in. Each stage now warns while it is still running past a
 * threshold, so a stall names itself even if it never finishes, and the turn
 * logs one summary line when setup completes.
 *
 * Cancel used to reach only the provider's abort controller, which does not
 * exist until setup finishes, so a cancelled turn went on to call the
 * provider anyway. `cancelTurnSetup` marks the in-flight setup, and the next
 * stage boundary throws `TurnSetupCancelledError` instead of continuing.
 */

import { logger } from '../../utils/logger';

export class TurnSetupCancelledError extends Error {
  constructor() {
    super('Stopped before the agent started. Your message is back in the composer.');
    this.name = 'TurnSetupCancelledError';
  }
}

export const SLOW_STAGE_WARN_MS = [10_000, 60_000] as const;

interface ActiveSetup {
  cancelled: boolean;
}

const activeSetups = new Map<string, ActiveSetup>();

/**
 * Marks the session's in-flight setup cancelled. Returns true when a setup
 * was in progress, so the caller knows the provider was never reached.
 */
export function cancelTurnSetup(sessionId: string): boolean {
  const setup = activeSetups.get(sessionId);
  if (!setup) return false;
  setup.cancelled = true;
  return true;
}

export interface TurnSetup {
  stage<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** Ends tracking and logs the summary. Call right before the provider. */
  finish(): void;
}

export function beginTurnSetup(
  sessionId: string,
  options: {
    submissionId?: string;
    now?: () => number;
    log?: { info: (message: string) => void; warn: (message: string) => void };
    schedule?: (fn: () => void, ms: number) => unknown;
    unschedule?: (handle: unknown) => void;
  } = {},
): TurnSetup {
  const now = options.now ?? Date.now;
  const log = options.log ?? { info: m => logger.main.info(m), warn: m => logger.main.warn(m) };
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const unschedule = options.unschedule ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const label = options.submissionId ? `${sessionId} (submission ${options.submissionId})` : sessionId;

  const state: ActiveSetup = { cancelled: false };
  activeSetups.set(sessionId, state);
  const startedAt = now();
  const timings: string[] = [];
  let finished = false;

  const throwIfCancelled = () => {
    if (state.cancelled) {
      release();
      throw new TurnSetupCancelledError();
    }
  };

  const release = () => {
    finished = true;
    if (activeSetups.get(sessionId) === state) activeSetups.delete(sessionId);
  };

  return {
    async stage(name, run) {
      throwIfCancelled();
      const stageStart = now();
      const timers = SLOW_STAGE_WARN_MS.map(threshold => schedule(() => {
        log.warn(`[TurnSetup] ${label}: stage '${name}' still running after ${threshold}ms`);
      }, threshold));
      try {
        return await run();
      } catch (error) {
        release();
        throw error;
      } finally {
        timers.forEach(unschedule);
        timings.push(`${name}=${now() - stageStart}ms`);
        throwIfCancelled();
      }
    },
    finish() {
      if (finished) return;
      release();
      log.info(`[TurnSetup] ${label}: setup ${now() - startedAt}ms (${timings.join(', ')})`);
    },
  };
}
