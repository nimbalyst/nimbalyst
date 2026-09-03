/**
 * One main-process lock covering every destructive database operation.
 *
 * Recovery, migration, adoption, dry-run adoption, rollback and backup restore
 * all close the engine, rename directories, and reopen. Each one assumes it is
 * the only thing doing that. Nothing enforced it: `db:recovery:recover` and
 * `db:migration:start` could be invoked in the same tick, and the second one's
 * `close()` would resolve against an engine the first one had already closed
 * and renamed out from under it. The worker's own `migrationRunning` flag only
 * excludes migrations from other migrations.
 *
 * Two deliberate properties:
 *
 *   - **It refuses rather than queues.** A caller that waits for the lock would
 *     resume against paths and facts gathered before the other operation moved
 *     them. Every one of these operations re-gathers its own facts at the
 *     start, so being told "no, something else is running" is the only answer
 *     that stays true.
 *   - **It is not reentrant.** An operation that needs to run another one is
 *     two operations, and nesting them would hide exactly the ownership
 *     confusion this exists to prevent.
 *
 * The lock is advisory in the sense that only code that asks for it is
 * excluded, so every destructive entry point has to take it. The list on
 * `DatabaseOperationKind` is the checklist.
 */

export type DatabaseOperationKind =
  /** Selected-artifact recovery from Settings or the failure dialog. */
  | 'recovery'
  /** Restore from a rolling backup, either backup service. */
  | 'backup-restore'
  /** PGLite -> SQLite migration, automatic or user-started. */
  | 'migration'
  /** Adopting a completed dry-run SQLite target. */
  | 'adoption'
  /** Building a dry-run SQLite copy. Reads the source, writes a target. */
  | 'dry-run'
  /** Reverting to the preserved PGLite source. */
  | 'rollback';

export interface DatabaseOperationLease {
  kind: DatabaseOperationKind;
  /** ISO timestamp, for the "already running" message and the log. */
  startedAt: string;
}

export type DatabaseOperationResult<T> =
  | { acquired: true; value: T }
  | { acquired: false; heldBy: DatabaseOperationKind; heldSince: string };

let held: DatabaseOperationLease | null = null;

/** What is running right now, if anything. Read-only; never gates on this. */
export function currentDatabaseOperation(): DatabaseOperationLease | null {
  return held ? { ...held } : null;
}

/**
 * Run `fn` with the destructive-operation lock held, or refuse immediately if
 * another operation already holds it.
 *
 * The lock is released whether `fn` resolves or throws — an operation that
 * failed has still finished, and leaving the lock held would wedge every later
 * recovery attempt for the life of the process.
 */
export async function withDatabaseOperationLock<T>(
  kind: DatabaseOperationKind,
  fn: () => Promise<T>,
): Promise<DatabaseOperationResult<T>> {
  if (held) {
    return { acquired: false, heldBy: held.kind, heldSince: held.startedAt };
  }
  held = { kind, startedAt: new Date().toISOString() };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    held = null;
  }
}

/** Human-readable refusal, so every caller words it the same way. */
export function describeOperationConflict(
  heldBy: DatabaseOperationKind,
  heldSince: string,
): string {
  return `Another database operation (${heldBy}, started ${heldSince}) is in progress. `
    + 'Wait for it to finish and try again.';
}

/** Test seam. Production never releases the lock any way but the `finally`. */
export function resetDatabaseOperationLockForTests(): void {
  held = null;
}
