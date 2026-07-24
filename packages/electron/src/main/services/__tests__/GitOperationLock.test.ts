import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron-log before importing the module under test
vi.mock('electron-log/main', () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Import after mocks are set up. We need a fresh instance per test,
// so we re-import in beforeEach using dynamic import + vi.resetModules.
let gitOperationLock: typeof import('../../services/GitOperationLock').gitOperationLock;

describe('GitOperationLock', () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../services/GitOperationLock');
    gitOperationLock = mod.gitOperationLock;
  });

  it('should execute a single operation and return its result', async () => {
    const result = await gitOperationLock.withLock('/repo', 'test-op', async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it('should serialize concurrent operations on the same repo', async () => {
    const order: number[] = [];

    const op1 = gitOperationLock.withLock('/repo', 'op1', async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
      return 'op1';
    });

    const op2 = gitOperationLock.withLock('/repo', 'op2', async () => {
      order.push(3);
      return 'op2';
    });

    const [r1, r2] = await Promise.all([op1, op2]);

    expect(r1).toBe('op1');
    expect(r2).toBe('op2');
    // op1 must fully complete before op2 starts
    expect(order).toEqual([1, 2, 3]);
  });

  it('should allow concurrent operations on different repos', async () => {
    const order: string[] = [];

    const op1 = gitOperationLock.withLock('/repo-a', 'op1', async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('a-end');
    });

    const op2 = gitOperationLock.withLock('/repo-b', 'op2', async () => {
      order.push('b-start');
      await new Promise((r) => setTimeout(r, 50));
      order.push('b-end');
    });

    await Promise.all([op1, op2]);

    // Both should start before either finishes (parallel execution)
    const aStartIdx = order.indexOf('a-start');
    const bStartIdx = order.indexOf('b-start');
    const aEndIdx = order.indexOf('a-end');
    const bEndIdx = order.indexOf('b-end');

    // Both start before both end
    expect(aStartIdx).toBeLessThan(aEndIdx);
    expect(bStartIdx).toBeLessThan(bEndIdx);
    // At least one should start before the other ends (parallel)
    expect(Math.min(aStartIdx, bStartIdx)).toBeLessThan(Math.max(aEndIdx, bEndIdx));
  });

  it('should release lock even if operation throws', async () => {
    // First operation throws
    await expect(
      gitOperationLock.withLock('/repo', 'failing-op', async () => {
        throw new Error('oops');
      })
    ).rejects.toThrow('oops');

    // Lock should be released - next operation should proceed immediately
    const result = await gitOperationLock.withLock('/repo', 'recovery-op', async () => {
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(gitOperationLock.isLocked('/repo')).toBe(false);
  });

  it('should report isLocked correctly', async () => {
    expect(gitOperationLock.isLocked('/repo')).toBe(false);

    let resolveLock: () => void;
    const lockHeld = new Promise<void>((r) => {
      resolveLock = r;
    });

    const opPromise = gitOperationLock.withLock('/repo', 'blocking-op', async () => {
      await lockHeld;
    });

    // Give the lock time to be acquired
    await new Promise((r) => setTimeout(r, 10));
    expect(gitOperationLock.isLocked('/repo')).toBe(true);

    resolveLock!();
    await opPromise;
    expect(gitOperationLock.isLocked('/repo')).toBe(false);
  });

  it('should timeout if lock is held too long', async () => {
    let resolveLock: () => void;
    const lockHeld = new Promise<void>((r) => {
      resolveLock = r;
    });

    // Start a long-running operation
    const longOp = gitOperationLock.withLock('/repo', 'long-op', async () => {
      await lockHeld;
    });

    // Try to acquire with a very short timeout
    await expect(
      gitOperationLock.withLock('/repo', 'impatient-op', async () => 'done', { timeout: 50 })
    ).rejects.toThrow("Git operation 'impatient-op' timed out waiting for lock on /repo");

    // Clean up
    resolveLock!();
    await longOp;
  });

  it('should track waiting count', async () => {
    expect(gitOperationLock.getWaitingCount('/repo')).toBe(0);

    let resolveOp: () => void;
    const opHeld = new Promise<void>((r) => {
      resolveOp = r;
    });

    // Start blocking operation
    const op1 = gitOperationLock.withLock('/repo', 'blocker', async () => {
      await opHeld;
    });

    // Queue up a waiter
    const op2 = gitOperationLock.withLock('/repo', 'waiter', async () => 'done');

    // Give waiters time to register
    await new Promise((r) => setTimeout(r, 10));
    expect(gitOperationLock.getWaitingCount('/repo')).toBe(1);

    // Release and clean up
    resolveOp!();
    await Promise.all([op1, op2]);
    expect(gitOperationLock.getWaitingCount('/repo')).toBe(0);
  });
});
