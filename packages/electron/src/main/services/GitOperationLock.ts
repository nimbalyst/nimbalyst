/**
 * GitOperationLock - Centralized lock manager for git operations
 *
 * Prevents concurrent destructive git operations on the same repository
 * that could corrupt git state (e.g., merge + commit, rebase + stage).
 *
 * Read-only operations (status, log, diff) do NOT require locks.
 *
 * Uses a proper queue: each waiter chains onto the tail of the queue,
 * so operations execute strictly one at a time per repository.
 */

import log from 'electron-log/main';

const logger = log.scope('GitOperationLock');

export interface LockOptions {
  /** Timeout in milliseconds waiting for lock (default: 30000) */
  timeout?: number;
}

/**
 * Centralized lock manager for git operations.
 *
 * Prevents concurrent destructive git operations on the same repository
 * that could corrupt git state (e.g., merge + commit, rebase + stage).
 *
 * Read-only operations (status, log, diff) do NOT require locks.
 */
class GitOperationLockService {
  /**
   * Per-repository queue tail.
   * Each new operation chains onto the current tail, then becomes the new tail.
   * This guarantees strict serialization even with multiple concurrent waiters.
   */
  private queueTails: Map<string, Promise<void>> = new Map();

  /**
   * Track pending waiters for debugging/metrics
   */
  private waitingCount: Map<string, number> = new Map();

  /**
   * Execute an operation with a lock on the repository.
   * Operations are strictly serialized per repository path.
   *
   * @param repoPath - Path to the repository (normalized)
   * @param operationName - Name of the operation (for logging)
   * @param operation - The async operation to execute
   * @param options - Lock options (timeout)
   * @returns The result of the operation
   * @throws Error if timeout exceeded waiting for lock
   */
  async withLock<T>(
    repoPath: string,
    operationName: string,
    operation: () => Promise<T>,
    options: LockOptions = {}
  ): Promise<T> {
    const { timeout = 30000 } = options;

    // Capture the current tail of the queue (the operation we need to wait for)
    const predecessor = this.queueTails.get(repoPath);

    // Create our own lock promise that will resolve when we finish
    let releaseLock: () => void;
    const ourLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    // Install ourselves as the new tail BEFORE awaiting anything.
    // This ensures the next caller after us will wait for us, not our predecessor.
    this.queueTails.set(repoPath, ourLock);

    // Wait for the predecessor to finish (if any)
    if (predecessor) {
      const currentWaiting = (this.waitingCount.get(repoPath) || 0) + 1;
      this.waitingCount.set(repoPath, currentWaiting);

      logger.info('Waiting for existing operation to complete', {
        repoPath,
        operationName,
        waitingCount: currentWaiting,
      });

      const startWait = Date.now();

      try {
        await Promise.race([
          predecessor,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Lock timeout after ${timeout}ms`)), timeout)
          ),
        ]);
      } catch (error) {
        // Decrement waiting count
        this.waitingCount.set(repoPath, (this.waitingCount.get(repoPath) || 1) - 1);

        if (error instanceof Error && error.message.includes('Lock timeout')) {
          // We're bailing out, but we MUST NOT resolve our lock until the
          // predecessor finishes. Otherwise downstream waiters (op3, op4, ...)
          // that are chained on ourLock would start while the predecessor is
          // still running, breaking serialization.
          //
          // Chain our lock resolution onto the predecessor's eventual completion.
          // This removes us from the queue without creating a gap.
          predecessor.then(
            () => releaseLock!(),
            () => releaseLock!()
          );
          logger.error('Lock timeout exceeded', { repoPath, operationName, timeout });
          throw new Error(`Git operation '${operationName}' timed out waiting for lock on ${repoPath}`);
        }
        // Ignore errors from previous operation - we still want to proceed
      }

      // Decrement waiting count
      const newCount = (this.waitingCount.get(repoPath) || 1) - 1;
      if (newCount <= 0) {
        this.waitingCount.delete(repoPath);
      } else {
        this.waitingCount.set(repoPath, newCount);
      }

      const waitTime = Date.now() - startWait;
      if (waitTime > 1000) {
        logger.warn('Long wait for git lock', { repoPath, operationName, waitTimeMs: waitTime });
      }
    }

    // We now hold the lock - execute the operation
    try {
      const result = await operation();
      return result;
    } finally {
      // Release the lock (wakes the next waiter, if any)
      releaseLock!();
      // Clean up the map entry if we're still the tail (no one queued after us)
      if (this.queueTails.get(repoPath) === ourLock) {
        this.queueTails.delete(repoPath);
      }
    }
  }

  /**
   * Check if a repository currently has an active lock
   */
  isLocked(repoPath: string): boolean {
    return this.queueTails.has(repoPath);
  }

  /**
   * Get the number of operations waiting for a lock on a repository
   */
  getWaitingCount(repoPath: string): number {
    return this.waitingCount.get(repoPath) || 0;
  }
}

// Export singleton instance
export const gitOperationLock = new GitOperationLockService();
