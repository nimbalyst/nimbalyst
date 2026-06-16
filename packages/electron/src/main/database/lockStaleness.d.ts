/**
 * Type declarations for the CJS lockStaleness.js helper.
 *
 * The implementation lives in a plain JS file because worker.js (the
 * PGLite worker payload) is itself untranspiled CommonJS and needs to
 * `require()` it at runtime without going through the TS build.
 * This .d.ts gives TypeScript callers (the unit tests, primarily)
 * compile-time types without breaking the CJS load path.
 */

export interface DecideLockIsRunningArgs {
  /** PID written into the .pid lock file by the previous instance. */
  lockPid: number;
  /**
   * ISO 8601 timestamp string recorded inside the lock file when it was
   * acquired (e.g. `"2026-05-13T21:09:49.396Z"`). May be `'unknown'` or
   * undefined for legacy lock files written before timestamping was
   * added; the implementation parses via `new Date(...).getTime()` and
   * falls back to the fail-closed branch for unknown / unparseable
   * values.
   */
  lockTimestamp: string | undefined;
  /**
   * Liveness probe. In production this is `process.kill.bind(process)`;
   * tests pass a stub that throws the relevant errno (ESRCH / EPERM)
   * synchronously.
   */
  killFn: (pid: number, signal: number) => void;
  /** Wall-clock "now" in ms. Defaults to Date.now(). Injectable for tests. */
  now?: number;
  /**
   * Grace window inside the EPERM branch. A lock younger than this is
   * routed to 'ambiguous' (caller asks the user) instead of being
   * assumed stale; anything older is treated as PID reuse. Default
   * 60_000 ms.
   */
  staleGraceMs?: number;
  /**
   * Optional process-identity probe. Given a PID, returns a short identity
   * string (e.g. the executable name) or `null` if it cannot be determined.
   * When the `kill(0)` liveness check succeeds and this returns an identity
   * that does NOT match the app, the lock is treated as stale (the PID was
   * reused by an unrelated process). Unknown identity fails closed to
   * 'running' so a live sibling is never clobbered.
   */
  processIdentityFn?: (pid: number) => string | null;
  /**
   * Lowercased substrings that mark a probed identity as belonging to this
   * app. Default `['electron', 'nimbalyst']`. A matching identity is a live
   * sibling; a non-matching one is stale PID reuse.
   */
  appProcessSignatures?: string[];
  /**
   * This process's own PID. Defaults to `process.pid`. If the lock file's
   * PID equals this, the dead holder's PID was reused for us and the lock is
   * stale (we have not acquired it yet this run). Injectable for tests.
   */
  selfPid?: number;
}

/**
 * Ternary decision surface. Caller maps each value to behaviour:
 *   'running'   -> refuse to open the database; show DATABASE_LOCKED error
 *   'stale'     -> proceed; remove the stale lock file and re-acquire
 *   'ambiguous' -> ask the user (the lock is fresh but we cannot signal
 *                  the PID owner; could be a real sibling or a fast PID
 *                  reuse). Per @ghinkle's review on closed PR #316.
 */
export type LockLivenessDecision = 'running' | 'stale' | 'ambiguous';

export interface DecideLockIsRunningResult {
  /** Ternary decision the caller routes on. */
  decision: LockLivenessDecision;
  /**
   * Backwards-compatible boolean for callers that have not yet been
   * updated to consume `decision`. True for both 'running' and
   * 'ambiguous' (matches the historical conservative default before
   * the ambiguous branch existed). New code should use `decision`.
   */
  isRunning: boolean;
  /** Human-readable explanation. Caller logs this verbatim. */
  reason: string;
  /** Echoed from the input for dialog rendering. */
  lockPid: number;
  /** How long ago the lock was written, in ms. `Infinity` if unknown. */
  lockAgeMs: number;
}

export function decideLockIsRunning(
  args: DecideLockIsRunningArgs
): DecideLockIsRunningResult;

export const DEFAULT_STALE_LOCK_GRACE_MS: number;
