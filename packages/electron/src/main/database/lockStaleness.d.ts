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
   * assumed to belong to a genuinely-competing sibling instance;
   * anything older is treated as PID reuse. Default 60_000 ms.
   */
  staleGraceMs?: number;
}

export interface DecideLockIsRunningResult {
  /** True iff the prior lock holder is presumed alive. */
  isRunning: boolean;
  /** Human-readable explanation. Caller logs this verbatim. */
  reason: string;
}

export function decideLockIsRunning(
  args: DecideLockIsRunningArgs
): DecideLockIsRunningResult;

export const DEFAULT_STALE_LOCK_GRACE_MS: number;
