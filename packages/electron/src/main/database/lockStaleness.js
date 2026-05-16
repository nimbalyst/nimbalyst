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
 *     alive and we own it; another instance is running. Decision: 'running'.
 *   - If it throws ESRCH -> no such process; the lock is stale, the prior
 *     instance crashed without releasing. Decision: 'stale'.
 *   - If it throws EPERM -> ambiguous on Windows. Either a sibling
 *     Nimbalyst we cannot signal (e.g. different user, different
 *     privilege level) OR a system / service process that happened to
 *     reuse the PID after the original Nimbalyst process died (the
 *     #272 case). Disambiguate by lock age:
 *       * Lock timestamp older than `staleGraceMs` (default 60s):
 *         decision: 'stale'. The original lock holder is long dead;
 *         PID has been reused.
 *       * Lock timestamp younger than `staleGraceMs`: decision:
 *         'ambiguous'. Could be a genuine sibling that just acquired
 *         the lock OR PID reuse on a slow-disk machine where the
 *         original lock was written less than 60s before crash.
 *         Caller should ask the user. Per @ghinkle's review on the
 *         closed PR #316.
 *       * No timestamp / unparseable: decision: 'stale' (legacy lock
 *         files predate the timestamp field and are by definition old).
 *   - Any other thrown error code: decision: 'running'. Fail closed so
 *     we never clobber a potentially-live sibling's lock on an
 *     unrecognised failure.
 *
 * Returns `{ decision, reason, lockPid, lockAgeMs }`. `reason` is
 * informational and is logged by the caller. `lockPid` and `lockAgeMs`
 * are surfaced so a dialog can show them to the user when the decision
 * is 'ambiguous'. Pure function: no fs, no os, no global state.
 *
 * `isRunning` is also returned for backwards compatibility with callers
 * that haven't been updated to consume the new ternary decision; it is
 * `true` for both 'running' and 'ambiguous' (the historical conservative
 * default before the dialog branch existed). New code should use
 * `decision` directly.
 */

const DEFAULT_STALE_LOCK_GRACE_MS = 60_000;

function decideLockIsRunning({ lockPid, lockTimestamp, killFn, now = Date.now(), staleGraceMs = DEFAULT_STALE_LOCK_GRACE_MS }) {
  const parsedLockTime =
    lockTimestamp && lockTimestamp !== 'unknown'
      ? new Date(lockTimestamp).getTime()
      : NaN;
  const lockAgeMs = Number.isFinite(parsedLockTime) ? now - parsedLockTime : Number.POSITIVE_INFINITY;

  try {
    killFn(lockPid, 0);
    return {
      decision: 'running',
      isRunning: true,
      reason: 'kill(0) succeeded; lock holder is alive and signalable',
      lockPid,
      lockAgeMs,
    };
  } catch (e) {
    if (e && e.code === 'ESRCH') {
      return {
        decision: 'stale',
        isRunning: false,
        reason: 'ESRCH: no such process; lock is stale',
        lockPid,
        lockAgeMs,
      };
    }
    if (e && e.code === 'EPERM') {
      if (!Number.isFinite(lockAgeMs) || lockAgeMs > staleGraceMs) {
        return {
          decision: 'stale',
          isRunning: false,
          reason:
            `EPERM on PID ${lockPid} but lock timestamp is ${Math.round(lockAgeMs / 1000)}s old ` +
            `(> ${staleGraceMs / 1000}s grace). Treating as stale (Windows pid-reuse hazard).`,
          lockPid,
          lockAgeMs,
        };
      }
      return {
        decision: 'ambiguous',
        isRunning: true,
        reason:
          `EPERM on PID ${lockPid} and lock timestamp is ${Math.round(lockAgeMs / 1000)}s old ` +
          `(within ${staleGraceMs / 1000}s grace). Ambiguous: could be a live sibling or a fast PID reuse. ` +
          `Asking the user.`,
        lockPid,
        lockAgeMs,
      };
    }
    return {
      decision: 'running',
      isRunning: true,
      reason: `unrecognised process.kill error (${e && e.code}); failing closed to protect live sibling`,
      lockPid,
      lockAgeMs,
    };
  }
}

module.exports = {
  decideLockIsRunning,
  DEFAULT_STALE_LOCK_GRACE_MS,
};
