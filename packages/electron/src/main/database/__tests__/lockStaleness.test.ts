import { describe, it, expect, vi } from 'vitest';
// CJS module loaded with ESM interop.
import { decideLockIsRunning, DEFAULT_STALE_LOCK_GRACE_MS } from '../lockStaleness.js';

// Regression coverage for nimbalyst#272. AnisminC reported the PGLite
// lock file was NOT self-healing after a main-process crash on Windows:
// the original Nimbalyst process crashed at 21:09Z, the user relaunched
// at 00:56Z (3h47m later, no reboot), and Windows had recycled PID 6732
// onto a system / service process. process.kill(6732, 0) then threw
// EPERM, the prior code interpreted EPERM as "still running", and the
// launch was blocked with DATABASE_LOCKED until the user manually
// deleted the lock file. The original Nimbalyst process had been dead
// for almost four hours.
//
// The fix gates the "EPERM means running" interpretation on lock age.
// These tests pin the boundary cases.

function makeKillError(code: string): Error & { code: string } {
  const err = new Error(`mock kill ${code}`) as Error & { code: string };
  err.code = code;
  return err;
}

const NOW = Date.parse('2026-05-14T00:56:00Z');

describe('decideLockIsRunning (issue #272)', () => {
  describe('clean ESRCH path', () => {
    it('returns not-running when process.kill throws ESRCH (no such process)', () => {
      const killFn = vi.fn(() => {
        throw makeKillError('ESRCH');
      });
      const result = decideLockIsRunning({
        lockPid: 6732,
        lockTimestamp: '2026-05-13T21:09:49.396Z',
        killFn,
        now: NOW,
      });
      expect(result.isRunning).toBe(false);
      expect(result.reason).toContain('ESRCH');
    });
  });

  describe('clean alive path', () => {
    it('returns running when process.kill succeeds (we own the lock holder)', () => {
      const killFn = vi.fn(); // does not throw
      const result = decideLockIsRunning({
        lockPid: 12345,
        lockTimestamp: new Date(NOW - 5_000).toISOString(),
        killFn,
        now: NOW,
      });
      expect(result.isRunning).toBe(true);
      expect(killFn).toHaveBeenCalledWith(12345, 0);
    });
  });

  describe('EPERM + stale timestamp (the #272 case)', () => {
    it('treats EPERM as STALE when lock is older than the grace window', () => {
      // AnisminC's exact scenario: lock acquired 21:09Z, relaunch 00:56Z,
      // ~13,565 seconds old. Grace is 60 s. Treat as stale.
      const killFn = vi.fn(() => {
        throw makeKillError('EPERM');
      });
      const result = decideLockIsRunning({
        lockPid: 6732,
        lockTimestamp: '2026-05-13T21:09:49.396Z',
        killFn,
        now: NOW,
      });
      expect(result.isRunning).toBe(false);
      expect(result.reason).toContain('EPERM');
      expect(result.reason).toMatch(/pid-reuse hazard/);
      // 21:09:49.396Z to 00:56:00Z = 3h46m10.6s = ~13571s rounded.
      expect(result.reason).toMatch(/13571s old/);
    });

    it('treats EPERM as STALE when lockTimestamp is "unknown" (no timestamp at all)', () => {
      // Old lock files predating the timestamp field. With no
      // timestamp we cannot compute age, so default to stale. This is
      // safe because a genuine sibling instance always writes a
      // current timestamp.
      const killFn = vi.fn(() => {
        throw makeKillError('EPERM');
      });
      const result = decideLockIsRunning({
        lockPid: 6732,
        lockTimestamp: 'unknown',
        killFn,
        now: NOW,
      });
      expect(result.isRunning).toBe(false);
    });
  });

  describe('EPERM + fresh timestamp (ambiguous - ask the user)', () => {
    it('returns decision=ambiguous when lock is younger than the grace window (Greg #316 review)', () => {
      // A sibling Nimbalyst running under another user/profile that
      // happens to share this PGLite path. Lock was acquired 10s ago,
      // within the 60s grace. Could also be a fast PID reuse if the
      // original Nimbalyst wrote the lock <60s before crash. Cannot
      // tell from kill(0) alone - ask the user via dialog.
      const killFn = vi.fn(() => {
        throw makeKillError('EPERM');
      });
      const result = decideLockIsRunning({
        lockPid: 9999,
        lockTimestamp: new Date(NOW - 10_000).toISOString(),
        killFn,
        now: NOW,
      });
      expect(result.decision).toBe('ambiguous');
      // isRunning stays true for backwards compatibility with callers
      // that have not yet been updated to consume `decision`.
      expect(result.isRunning).toBe(true);
      expect(result.reason).toMatch(/Ambiguous/);
      expect(result.lockPid).toBe(9999);
      expect(result.lockAgeMs).toBe(10_000);
    });

    it('uses a custom grace window when caller overrides it', () => {
      // 30s old, custom grace of 5s -> stale.
      const killFn = vi.fn(() => {
        throw makeKillError('EPERM');
      });
      const result = decideLockIsRunning({
        lockPid: 9999,
        lockTimestamp: new Date(NOW - 30_000).toISOString(),
        killFn,
        now: NOW,
        staleGraceMs: 5_000,
      });
      expect(result.isRunning).toBe(false);
    });
  });

  describe('unknown error code', () => {
    it('fails CLOSED when process.kill throws an unrecognised code', () => {
      // Don't accidentally clobber a live sibling's lock on a weird
      // error like EFAULT, EINVAL, or some platform-specific code.
      const killFn = vi.fn(() => {
        throw makeKillError('EFAULT');
      });
      const result = decideLockIsRunning({
        lockPid: 6732,
        lockTimestamp: '2026-05-13T21:09:49.396Z',
        killFn,
        now: NOW,
      });
      expect(result.isRunning).toBe(true);
      expect(result.reason).toContain('unrecognised');
    });
  });

  describe('constants', () => {
    it('exports the default grace window so callers can reference it', () => {
      expect(DEFAULT_STALE_LOCK_GRACE_MS).toBe(60_000);
    });
  });
});
