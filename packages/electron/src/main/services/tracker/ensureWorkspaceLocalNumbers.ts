/**
 * The one full sweep that gives every item in a workspace a local number.
 *
 * `assignLocalKeysFrom` in `ElectronDocumentService` numbers whatever rows a
 * list query happened to read. That is the right cost for the steady state and
 * the wrong shape for a backfill: a workspace whose lists are type-scoped or
 * limited leaves rows unnumbered indefinitely, and which ones survive depends
 * on which tracker the user opened. Measured on a real database mid-2026: 45 of
 * 1007 `bug` rows and 40 of 41 `feedback` rows had no number, months after the
 * feature landed.
 *
 * Deliberately NOT inside `initializeTrackerSync`. That function returns early
 * when the user is unauthenticated, when the workspace has no team, or when the
 * team predates `teamProjectId` -- and "no team" is precisely the case this
 * exists to serve. Local numbers are the answer for a workspace that will never
 * have a room; gating them on the room would be circular (#1346).
 */

import { database } from '../../database/PGLiteDatabaseWorker';
import { logger } from '../../utils/logger';
import { assignMissingLocalKeys } from './localKeyAllocator';
import { typeHasLocalNumbers } from './localNumberTypes';
import { repairTrackerIdentityKeys } from './trackerIdentityKeyRepair';
import { workspaceLocalKeyStore } from './workspaceLocalKeyStore';

/**
 * One sweep per workspace per process. The allocator is idempotent, so a repeat
 * is harmless rather than wrong -- this guard is about not paying for a full
 * table scan every time a window opens on a workspace already covered.
 */
const sweptWorkspaces = new Set<string>();

/**
 * Number every unnumbered item in the workspace whose type opts in to local
 * numbers.
 *
 * Never throws: a workspace whose numbers cannot be assigned still works
 * everywhere, so a failed sweep must not take window creation down with it.
 * Callers should not await this — see `ensureWorkspaceLocalNumbersInBackground`.
 */
export async function ensureWorkspaceLocalNumbers(workspacePath: string): Promise<number> {
  if (!workspacePath || sweptWorkspaces.has(workspacePath)) return 0;
  sweptWorkspaces.add(workspacePath);

  try {
    const assigned = await assignMissingLocalKeys(
      database, workspaceLocalKeyStore, workspacePath, typeHasLocalNumbers,
    );
    if (assigned > 0) {
      logger.main.info(
        '[LocalNumbers] assigned', assigned, 'local tracker numbers for', workspacePath,
      );
    }
    return assigned;
  } catch (error) {
    // Allow a retry on the next window rather than pinning the failure for the
    // lifetime of the process.
    sweptWorkspaces.delete(workspacePath);
    logger.main.error('[LocalNumbers] sweep failed for', workspacePath, error);
    return 0;
  }
}

/**
 * One identity-key repair per workspace per process, for the same reason the
 * number sweep has one: the pass is idempotent, so a repeat is harmless rather
 * than wrong, but it is a full scan of the workspace's rows.
 */
const repairedWorkspaces = new Set<string>();

/**
 * Fire and forget. The sweep reserves numbers a chunk at a time and each
 * reservation re-persists the workspace settings store, so a large tracker is
 * seconds of work that must not sit on the startup critical path.
 *
 * This is the workspace-open tracker maintenance lane, so the identity-key
 * repair rides along here rather than adding a second scheduler and a second
 * thing for a new window entry point to forget to call. The two are
 * independent: each has its own catch, and neither failure blocks the other.
 */
export function ensureWorkspaceLocalNumbersInBackground(workspacePath: string): void {
  void ensureWorkspaceLocalNumbers(workspacePath);

  if (!workspacePath || repairedWorkspaces.has(workspacePath)) return;
  repairedWorkspaces.add(workspacePath);
  void repairTrackerIdentityKeys(database, workspacePath).catch((error) => {
    // Hygiene on rows no reader consults. Allow a retry next launch rather than
    // letting a failed repair surface anywhere the user can see it.
    repairedWorkspaces.delete(workspacePath);
    logger.main.warn('[TrackerIdentityKeyRepair] repair failed for', workspacePath, error);
  });
}

/** Test seam: forget which workspaces have been swept. */
export function resetLocalNumberSweepStateForTests(): void {
  sweptWorkspaces.clear();
  repairedWorkspaces.clear();
}
