/**
 * PGLite worker lock-staleness decision.
 *
 * Extracted from worker.js so unit tests can exercise the
 * Windows-pid-reuse gate (nimbalyst#272) without spawning a real worker
 * thread or touching the filesystem. worker.js is CommonJS and runs as a
 * `new Worker(...)` payload, so it cannot be loaded directly under vitest;
 * the inline gate logic was previously untestable.
 *
 * Decision rule:
 *   - If `process.kill(lockPid, 0)` does NOT throw -> the lock holder is
 *     alive and we own it; another instance is running.
 *   - If it throws ESRCH -> no such process; the lock is stale, the prior
 *     instance crashed without releasing.
 *   - If it throws EPERM -> ambiguous on Windows. Either a sibling
 *     Nimbalyst we cannot signal (e.g. different user, different
 *     privilege level) OR a system / service process that happened to
 *     reuse the PID after the original Nimbalyst process died (the
 *     #272 case). Disambiguate by lock age:
 *       * Lock timestamp younger than `staleGraceMs` (default 60s):
 *         treat as alive. A genuine competing instance just acquired the
 *         lock during the current launch attempt.
 *       * Lock timestamp older than `staleGraceMs`: treat as stale. The
 *         original lock holder is long dead; PID has been reused.
 *   - Any other thrown error code: fail closed (treat as running) so we
 *     never clobber a potentially-live sibling's lock on an
 *     unrecognised failure.
 *
 * Returns `{ isRunning, reason }`. `reason` is informational and is
 * logged by the caller. Pure function: no fs, no os, no global state.
 */

const DEFAULT_STALE_LOCK_GRACE_MS = 60_000;

function decideLockIsRunning({ lockPid, lockTimestamp, killFn, now = Date.now(), staleGraceMs = DEFAULT_STALE_LOCK_GRACE_MS }) {
  try {
    killFn(lockPid, 0);
    return { isRunning: true, reason: 'kill(0) succeeded; lock holder is alive and signalable' };
  } catch (e) {
    if (e && e.code === 'ESRCH') {
      return { isRunning: false, reason: 'ESRCH: no such process; lock is stale' };
    }
    if (e && e.code === 'EPERM') {
      const parsedLockTime =
        lockTimestamp && lockTimestamp !== 'unknown'
          ? new Date(lockTimestamp).getTime()
          : NaN;
      const lockAgeMs = Number.isFinite(parsedLockTime) ? now - parsedLockTime : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(lockAgeMs) || lockAgeMs > staleGraceMs) {
        return {
          isRunning: false,
          reason:
            `EPERM on PID ${lockPid} but lock timestamp is ${Math.round(lockAgeMs / 1000)}s old ` +
            `(> ${staleGraceMs / 1000}s grace). Treating as stale (Windows pid-reuse hazard).`,
        };
      }
      return {
        isRunning: true,
        reason:
          `EPERM on PID ${lockPid} and lock timestamp is ${Math.round(lockAgeMs / 1000)}s old ` +
          `(within ${staleGraceMs / 1000}s grace). Treating as a live sibling instance.`,
      };
    }
    return {
      isRunning: true,
      reason: `unrecognised process.kill error (${e && e.code}); failing closed to protect live sibling`,
    };
  }
}

module.exports = {
  decideLockIsRunning,
  DEFAULT_STALE_LOCK_GRACE_MS,
};
