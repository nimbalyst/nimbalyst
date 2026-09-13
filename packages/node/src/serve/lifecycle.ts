/**
 * The two loops that decide when `serve` rotates and when it stops.
 *
 * They live here rather than inline in `startServe.ts` for the same reason
 * `serveRuntime.ts` does: both are decisions, and a decision wired directly to a
 * socket and a `setInterval` is one that can only be exercised by running the
 * real thing against the real server and waiting twelve minutes.
 *
 * The distinction they exist to protect is between a credential that is GONE and
 * one that is merely unreachable:
 *
 *  - HTTP 400 from `/auth/device/refresh` is terminal. The server has discarded
 *    the credential; every further attempt is another chance to destroy a
 *    replacement the desktop has since issued. Stop, exit 3, let the desktop
 *    re-provision.
 *  - A network error or a 5xx is not. Exiting 3 on a blip would send the user
 *    through a re-provisioning flow they did not need.
 *
 * A transient failure therefore retries on its OWN schedule, not on the next
 * rotation tick. The access token lives fifteen minutes and rotation runs at
 * twelve, so "wait for the next cycle" means the token expires at minute fifteen
 * and the node sits disconnected until minute twenty-four -- nine minutes of a
 * node that is up, healthy, and answering nothing.
 */

import { CredentialRevokedError } from './credentials.js';
import type { Logger } from './log.js';

/** Opaque to this module: whatever the injected timer returns. */
export type TimerHandle = unknown;

/**
 * Rotate this far ahead of the 15-minute access token's expiry.
 *
 * The server closes a node socket with code 4003 the instant the token expires,
 * mid-turn if that is where it lands.
 */
export const DEFAULT_REFRESH_INTERVAL_MS = 12 * 60 * 1000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

export interface RefreshLoopDeps {
  /**
   * Rotate the credential and put the new token on a fresh socket. Rejects with
   * `CredentialRevokedError` when the credential is gone, anything else when the
   * server or the network is having a bad minute.
   */
  rotate(): Promise<void>;
  /** Called at most once, and only for a terminal rejection. */
  onRevoked(reason: string): void;
  log: Logger;
  intervalMs?: number;
  /** First retry delay after a transient failure; doubles up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Injected in tests, so backoff is asserted rather than waited out. */
  setTimer?(fn: () => void, ms: number): TimerHandle;
  clearTimer?(handle: TimerHandle): void;
}

export interface RefreshLoop {
  start(): void;
  stop(): void;
  /** Milliseconds until the next attempt, or undefined when nothing is scheduled. */
  nextDelayMs(): number | undefined;
}

function defaultSetTimer(fn: () => void, ms: number): TimerHandle {
  const timer = setTimeout(fn, ms);
  // A pending rotation must never be the only thing holding the process open.
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: TimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export function createRefreshLoop(deps: RefreshLoopDeps): RefreshLoop {
  const intervalMs = deps.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const retryBaseMs = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = deps.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const setTimer = deps.setTimer ?? defaultSetTimer;
  const clearTimer = deps.clearTimer ?? defaultClearTimer;

  let handle: TimerHandle | undefined;
  let nextDelay: number | undefined;
  let consecutiveFailures = 0;
  let stopped = false;
  let running = false;

  function schedule(delayMs: number): void {
    if (stopped) return;
    nextDelay = delayMs;
    handle = setTimer(() => {
      handle = undefined;
      nextDelay = undefined;
      void tick();
    }, delayMs);
  }

  function stop(): void {
    stopped = true;
    if (handle !== undefined) clearTimer(handle);
    handle = undefined;
    nextDelay = undefined;
  }

  async function tick(): Promise<void> {
    // A self-scheduling timeout rather than an interval: an interval would stack
    // a second rotation on top of one that is still waiting on the network, and
    // the loser would present a refresh token the winner had already retired.
    if (stopped || running) return;
    running = true;
    try {
      await deps.rotate();
      consecutiveFailures = 0;
      schedule(intervalMs);
    } catch (error) {
      if (error instanceof CredentialRevokedError) {
        // Terminal. Stop BEFORE the callback: `onRevoked` starts a shutdown, and
        // a rotation scheduled behind it would fire against a dead socket.
        stop();
        deps.onRevoked(error.reason);
        return;
      }

      consecutiveFailures += 1;
      const delayMs = Math.min(
        retryBaseMs * 2 ** (consecutiveFailures - 1),
        retryMaxMs,
      );
      deps.log('credential-refresh-failed', {
        error: error instanceof Error ? error.message : String(error),
        attempt: consecutiveFailures,
        retryInMs: delayMs,
        note: 'transient, not a revocation; retrying',
      });
      schedule(delayMs);
    } finally {
      running = false;
    }
  }

  return {
    start(): void {
      if (handle !== undefined) return;
      stopped = false;
      schedule(intervalMs);
    },
    stop,
    nextDelayMs: () => nextDelay,
  };
}

export interface ShutdownRuntime {
  stopIntake(): void;
  cancelAll(): Promise<void>;
  idle(): Promise<void>;
}

export interface ShutdownDeps {
  runtime: ShutdownRuntime;
  /** Listener unsubscribes. One that throws must not skip the others. */
  unsubscribes: Array<() => void>;
  disconnect(): void;
  /** True when the credential is gone: nothing can be streamed, so do not wait. */
  revoked: boolean;
  /**
   * Total time in-flight work gets. Bounded on purpose: a container's SIGTERM
   * grace period is finite, and being SIGKILLed mid-write is worse than giving
   * up cleanly and saying so.
   */
  graceMs?: number;
  log: Logger;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 15_000;

/**
 * Stop serving, in an order that is load-bearing.
 *
 * Intake is closed at the source first, so a broadcast arriving mid-shutdown
 * cannot start a turn we are about to abandon. Then the drain runs BEFORE the
 * socket closes: a turn that is still streaming has transcript rows that have
 * not reached the session room, and disconnecting first strands them locally --
 * correct in this container's database, invisible on every device the user owns.
 */
export async function shutdownServe(deps: ShutdownDeps): Promise<void> {
  const graceMs = deps.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  deps.runtime.stopIntake();
  for (const unsubscribe of deps.unsubscribes) {
    try { unsubscribe(); } catch { /* a listener that is already gone is fine */ }
  }

  // ONE deadline, covering cancellation and draining together.
  //
  // Cancelling used to sit outside the race, which made the bound a lie: a
  // `cancel()` that never settles -- an SDK generator wedged on a socket read is
  // the realistic one -- held shutdown open indefinitely, and the container's
  // grace period ran out into a SIGKILL mid-write. Anything that has not
  // finished when this expires does not get more time.
  let expire: (() => void) | undefined;
  const deadline = new Promise<'expired'>((resolve) => {
    const timer = setTimeout(() => resolve('expired'), graceMs);
    timer.unref?.();
    expire = () => clearTimeout(timer);
  });

  deps.log('draining', { timeoutMs: graceMs, revoked: deps.revoked });
  const outcome = await Promise.race([
    (async () => {
      if (deps.revoked) {
        // A revoked credential cannot stream anything: the socket is dead and
        // every reconnect is refused. Waiting for turns would burn the grace
        // period on a publication that provably cannot happen.
        await deps.runtime.cancelAll();
      }
      await deps.runtime.idle();
      return 'drained' as const;
    })().catch((error: unknown) => {
      deps.log('drain-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 'drained' as const;
    }),
    deadline,
  ]);
  expire?.();

  if (outcome !== 'drained') {
    deps.log('drain-timeout', {
      timeoutMs: graceMs,
      note: 'giving up on in-flight work; local rows are persisted but may be unpublished',
    });
    // Issued, but deliberately NOT awaited. The deadline has already passed; a
    // cancel that is itself stuck must not extend it. Best effort, then go.
    try {
      void Promise.resolve(deps.runtime.cancelAll())
        .catch(() => { /* shutting down anyway */ });
    } catch { /* a synchronous throw from cancelAll is not worth blocking on */ }
  }

  deps.log('disconnecting');
  try {
    deps.disconnect();
  } catch (error) {
    deps.log('disconnect-failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
