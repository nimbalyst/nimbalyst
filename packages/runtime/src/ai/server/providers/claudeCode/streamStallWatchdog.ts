/**
 * Stream stall watchdog for the Claude Code streaming loop.
 *
 * The SDK subprocess can go silent mid-turn -- e.g. during a long extended
 * thinking phase the model stream stalls and the SDK stops yielding chunks
 * WITHOUT emitting a `result`, an error, or ending the iterator. The provider's
 * streaming loop is a `for await (iterator.next())`; when the SDK stops yielding
 * that await blocks forever. Every existing completion path (result-chunk grace
 * timer, iterator-done, catch/error, abort) requires the stream to DO something,
 * so a silent stall trips none of them and the turn hangs (stuck spinner). See
 * NIM-1481.
 *
 * This watchdog races each `iterator.next()` against a stall timer. If no chunk
 * (and no interrupt) arrives within the window, it reports `stalled` so the loop
 * can abort the wedged subprocess and surface an error instead of hanging.
 *
 * It is deliberately only armed when the model -- not a tool or user prompt -- is
 * expected to be producing output (the caller passes `watchdogActive`). During
 * legitimate long silences (a foreground tool executing, a background sub-agent
 * draining, or a user permission/input prompt waiting) the caller leaves it
 * disarmed so long-running work is never reaped.
 */

/**
 * Default silence window before a pre-result stream is declared stalled.
 *
 * Sized to sit above the SDK's real heartbeat jitter. The watchdog relies on the
 * `thinking_tokens` chunk to keep an armed pre-result stream alive, but that chunk is a
 * variable-cadence estimated-token PROGRESS TICK, not a ~1Hz wall-clock keepalive.
 * Measured against real persisted chunks, intra-turn tick gaps averaged ~5s but reached
 * ~589s. The original 120s window had almost no margin over that jitter and reaped
 * legitimate long extended-thinking turns (#802). 10 minutes clears the observed max
 * while still eventually reaping a genuinely dead stream (the NIM-1481 case).
 */
export const DEFAULT_STREAM_STALL_MS = 600_000;

/**
 * Resolve the stall window, allowing an env override so tests can use a short
 * window without waiting two minutes. Invalid / non-positive values fall back to
 * the default.
 */
export function resolveStreamStallMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.NIMBALYST_CC_STREAM_STALL_MS;
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STREAM_STALL_MS;
}

export type ChunkRaceOutcome<T> =
  | { kind: 'chunk'; result: IteratorResult<T> }
  | { kind: 'chunk-error'; error: unknown }
  | { kind: 'interrupted' }
  | { kind: 'stalled' };

export function shouldArmStreamStallWatchdog(params: {
  resultReceivedTime: number | null;
  outstandingToolCalls: number;
  hasRunningTasks: boolean;
  hasPendingUserInteraction: boolean;
}): boolean {
  return params.resultReceivedTime === null
    && params.outstandingToolCalls === 0
    && !params.hasRunningTasks
    && !params.hasPendingUserInteraction;
}

/**
 * Race the next SDK chunk against the interrupt signal and, when armed, a stall
 * timer.
 *
 * - Resolves to `chunk` with the iterator result on the next yield.
 * - Resolves to `chunk-error` if `iterator.next()` rejects (the caller rethrows,
 *   preserving the pre-existing "iterator threw" behavior). Handling the
 *   rejection here means a losing chunk promise never becomes an unhandled
 *   rejection when a stall/interrupt wins the race.
 * - Resolves to `interrupted` when the interrupt promise fires.
 * - Resolves to `stalled` when `watchdogActive` and neither of the above happens
 *   within `stallMs`.
 *
 * The stall timer is always cleared before returning so it can't leak or fire
 * after the loop moved on.
 */
export async function raceNextChunkWithStallWatchdog<T>(params: {
  nextPromise: Promise<IteratorResult<T>>;
  interruptPromise: Promise<'interrupted'>;
  watchdogActive: boolean;
  stallMs: number;
}): Promise<ChunkRaceOutcome<T>> {
  const { nextPromise, interruptPromise, watchdogActive, stallMs } = params;

  // Absorb both settle paths so the chunk racer never rejects; if it loses the
  // race its resolved value is simply discarded (no unhandled rejection).
  const chunkRacer: Promise<ChunkRaceOutcome<T>> = nextPromise.then(
    result => ({ kind: 'chunk', result }),
    error => ({ kind: 'chunk-error', error }),
  );
  const interruptRacer: Promise<ChunkRaceOutcome<T>> = interruptPromise.then(
    () => ({ kind: 'interrupted' }),
  );

  const racers: Array<Promise<ChunkRaceOutcome<T>>> = [chunkRacer, interruptRacer];

  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  if (watchdogActive) {
    racers.push(
      new Promise<ChunkRaceOutcome<T>>(resolve => {
        stallTimer = setTimeout(() => resolve({ kind: 'stalled' }), stallMs);
      }),
    );
  }

  try {
    return await Promise.race(racers);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }
}
