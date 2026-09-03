/**
 * IPC for the Settings > Database recovery surface.
 *
 * This file owns no recovery logic and no wiring. `database/recovery/` decides
 * what a candidate is, what may be said about it, and what happens during a
 * restore, and `productionRecovery.ts` builds the service; everything here does
 * is hand the renderer a flat view of the result and refuse anything the
 * renderer asks for that is not one of the artifacts discovery found.
 *
 * Three properties the renderer depends on and cannot enforce itself:
 *
 *   - Every path in a request is a *name*, matched against a freshly-scanned
 *     allowlist. There is no argument the renderer can construct that points
 *     recovery, reveal, or delete at an arbitrary directory.
 *   - Nothing here deletes on its own initiative, and no caller can assert
 *     consent on the user's behalf. `db:recovery:delete-migrated` is the only
 *     destructive channel and main asks the user itself before it acts.
 *   - Destructive channels take the shared database-operation lock, so a
 *     recovery cannot start while a migration, adoption or rollback is
 *     closing and renaming the same engine.
 *
 * Channels:
 *   db:recovery:list-candidates   -> discovered artifacts, each with a verdict
 *   db:recovery:proactive-offer   -> the at-most-one artifact worth raising
 *   db:recovery:recover           -> restore from a chosen candidate
 *   db:recovery:mark-resolved     -> "I have dealt with this" (never deletes)
 *   db:recovery:list-migrated     -> pglite-db.migrated-* copies
 *   db:recovery:delete-migrated   -> explicit, user-directed deletion
 *   db:recovery:reveal            -> show an allowlisted copy in the file manager
 */

import { dialog, shell } from 'electron';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { readBackendState } from '../database/sqlite/BackendSelector';
import { readCutoverJournal } from '../database/sqlite/cutoverJournal';
import { findRecoveryArtifacts, formatBytes } from '../database/sqlite/recoveryArtifacts';
import { dirSizeBytes } from '../database/sqlite/dirSize';
import {
  describeOperationConflict,
  withDatabaseOperationLock,
} from '../database/databaseOperationLock';
import {
  activeBackend,
  buildProductionRecoveryService,
  getUserDataPath,
  liveDatabasePath,
  pgliteWorkerPath,
  sizeBucketFor,
  timestampFromArtifactName,
  type ActiveBackend,
  type RecoveryCandidate,
} from '../database/recovery';

const MIGRATED_DIR_PREFIX = 'pglite-db.migrated-';

/**
 * Flat, renderer-safe view of a candidate. Mirrored by `RecoveryCandidateView`
 * in `renderer/store/atoms/dbMigration.ts` — the renderer cannot import from
 * main, so the two shapes are kept in step by hand, as the rest of the
 * `db:migration:*` surface already is.
 */
interface CandidateView {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  sizeBucket: string;
  createdAt: string | null;
  verdict: string;
  reasonCode: string;
  mayOfferProactively: boolean;
  factsFingerprint: string;
  /**
   * False when this build has no way to put the candidate back. A PGLite
   * artifact on a SQLite-active install is migrated into a fresh SQLite target
   * by `createPgliteArtifactMaterializer`, which needs the PGLite worker
   * bundle; a packaging miss is the only thing that can take that away now.
   * Saying so up front beats a refusal in the middle of a destructive-looking
   * flow.
   */
  restoreAvailable: boolean;
  restoreUnavailableReason: 'pglite_worker_bundle_missing' | null;
}

interface MigratedCopyView {
  name: string;
  path: string;
  sizeBytes: number;
  createdAt: string | null;
  /** This is the directory `db:migration:rollback` would restore from. */
  isRollbackSource: boolean;
}

function toCandidateView(candidate: RecoveryCandidate, backend: ActiveBackend): CandidateView {
  const isDirectoryArtifact = (() => {
    try {
      return fs.statSync(candidate.path).isDirectory();
    } catch {
      return false;
    }
  })();
  // The only remaining way a directory artifact cannot be restored on a SQLite
  // install is a build that shipped without the PGLite worker.
  const needsMaterializer = backend === 'sqlite' && isDirectoryArtifact;
  const materializerAvailable = !needsMaterializer || fs.existsSync(pgliteWorkerPath());
  return {
    id: candidate.id,
    name: candidate.name,
    path: candidate.path,
    sizeBytes: candidate.sizeBytes,
    sizeBucket: candidate.sizeBucket,
    createdAt: candidate.createdAt,
    verdict: candidate.assessment.verdict,
    reasonCode: candidate.assessment.reasonCode,
    mayOfferProactively: candidate.assessment.mayOfferProactively,
    factsFingerprint: candidate.assessment.factsFingerprint,
    restoreAvailable: materializerAvailable,
    restoreUnavailableReason: materializerAvailable ? null : 'pglite_worker_bundle_missing',
  };
}

/** Facts about the database that a restore would displace. */
function liveDatabaseView(userDataPath: string, backend: ActiveBackend): {
  backend: ActiveBackend;
  path: string;
  sizeBytes: number;
  sizeBucket: string;
} {
  const livePath = liveDatabasePath(userDataPath, backend);
  let sizeBytes = 0;
  try {
    sizeBytes = backend === 'pglite'
      ? dirSizeBytes(livePath)
      : fs.statSync(livePath).size;
  } catch {
    sizeBytes = 0;
  }
  return { backend, path: livePath, sizeBytes, sizeBucket: sizeBucketFor(sizeBytes) };
}

/**
 * Every name that is, or is about to become, the directory a rollback would
 * restore from.
 *
 * The backend flag alone is not enough. A cutover renames the source aside and
 * *then* commits the flag, so between those two steps the directory the
 * cutover journal owns is the install's only real database while
 * `pgliteMigratedDir` still says nothing about it. Consulting only the flag
 * meant that window reported the directory as an ordinary migrated copy,
 * deletable without so much as a warning. The journal is read-only here; the
 * cutover machinery owns writing it.
 */
function rollbackSourceNames(userDataPath: string): Set<string> {
  const names = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value) names.add(path.basename(value));
  };
  add(readBackendState(userDataPath)?.pgliteMigratedDir ?? null);
  try {
    add(readCutoverJournal(userDataPath)?.source.preservedPath ?? null);
  } catch {
    // A journal we cannot read is not a reason to fail the listing; the flag
    // check above still applies and deletion still needs a confirmation.
  }
  return names;
}

function listMigratedCopies(userDataPath: string): MigratedCopyView[] {
  const { migratedDirs } = findRecoveryArtifacts(userDataPath);
  const rollbackSources = rollbackSourceNames(userDataPath);
  return migratedDirs.map((name) => ({
    name,
    path: path.join(userDataPath, name),
    sizeBytes: dirSizeBytes(path.join(userDataPath, name)),
    createdAt: timestampFromArtifactName(name),
    isRollbackSource: rollbackSources.has(name),
  }));
}

/**
 * Ask the user, in the main process, before removing a copy of their database.
 *
 * This replaces an `acknowledgedRollbackLoss: true` flag the *caller* asserted.
 * That flag was consent in name only: the renderer enumerated every migrated
 * directory from `db:recovery:list-migrated` and then passed the boolean back,
 * so anything that could reach the IPC surface -- a compromised extension, a
 * bug in renderer code -- could delete every preserved PGLite copy on the
 * machine without a human ever seeing a prompt. Consent that the untrusted
 * side can fabricate is not consent, so main asks and main reads the answer.
 */
async function confirmMigratedCopyDeletion(target: MigratedCopyView): Promise<boolean> {
  const detail = target.isRollbackSource
    ? `${target.name} (${formatBytes(target.sizeBytes)}) is the copy Nimbalyst would restore from `
      + 'if you rolled back to PGLite. Deleting it removes that option permanently. Your current '
      + 'database is not affected.'
    : `${target.name} (${formatBytes(target.sizeBytes)}) is a preserved copy of your database from `
      + 'before the switch to SQLite. Deleting it frees the space permanently. Your current '
      + 'database is not affected.';

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Delete a preserved database copy?',
    message: `Permanently delete ${target.name}?`,
    detail,
    buttons: ['Cancel', 'Delete Permanently'],
    // The safe answer is the default and the escape key, in both directions.
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

export function registerRecoveryHandlers(): void {
  safeHandle('db:recovery:list-candidates', async () => {
    try {
      const userDataPath = getUserDataPath();
      const backend = activeBackend(userDataPath);
      const candidates = await buildProductionRecoveryService('settings').listCandidates();
      return {
        success: true,
        activeBackend: backend,
        live: liveDatabaseView(userDataPath, backend),
        candidates: candidates.map((c) => toCandidateView(c, backend)),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  safeHandle('db:recovery:proactive-offer', async () => {
    try {
      const backend = activeBackend(getUserDataPath());
      const candidate = await buildProductionRecoveryService('settings').proactiveOffer();
      return {
        success: true,
        candidate: candidate ? toCandidateView(candidate, backend) : null,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  safeHandle(
    'db:recovery:recover',
    async (
      _event,
      args: { candidateId?: string; expectedFingerprint?: string } | undefined,
    ) => {
      const candidateId = args?.candidateId;
      const expectedFingerprint = args?.expectedFingerprint;
      if (!candidateId || !expectedFingerprint) {
        // Fail fast rather than letting the service re-derive a fingerprint we
        // were not given: the fingerprint is the user's consent to the facts
        // they were shown, and a missing one is not the same as a matching one.
        return {
          success: false,
          error: 'A candidate id and the fingerprint of the facts shown to the user are required.',
        };
      }
      try {
        // Recovery, migration, adoption, dry-run and rollback all close,
        // rename and reopen the same engine. Two of them at once means one
        // operation's `close()` resolving against a database the other has
        // already renamed away.
        const run = await withDatabaseOperationLock('recovery', () =>
          buildProductionRecoveryService('settings').recover({
            candidateId,
            expectedFingerprint,
          }),
        );
        if (!run.acquired) {
          return { success: false, error: describeOperationConflict(run.heldBy, run.heldSince) };
        }
        return { success: true, outcome: run.value };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  );

  safeHandle(
    'db:recovery:mark-resolved',
    async (_event, args: { name?: string } | undefined) => {
      const name = args?.name;
      if (!name) return { success: false, error: 'An artifact name is required.' };
      try {
        const { corruptionBackupDirs } = findRecoveryArtifacts(getUserDataPath());
        if (!corruptionBackupDirs.includes(name)) {
          return { success: false, error: 'That is not a discovered recovery artifact.' };
        }
        await buildProductionRecoveryService('settings').markResolved(name);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  );

  safeHandle('db:recovery:list-migrated', async () => {
    try {
      const userDataPath = getUserDataPath();
      return {
        success: true,
        activeBackend: activeBackend(userDataPath),
        copies: listMigratedCopies(userDataPath),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  /**
   * The only destructive channel in this file, and the only way a
   * `pglite-db.migrated-*` copy is ever removed — nothing here or in startup
   * cleanup deletes one on a timer.
   *
   * The caller names a directory. It does not, and cannot, supply consent:
   * main asks the user itself. The old contract took an
   * `acknowledgedRollbackLoss` boolean from the renderer, which meant the
   * whole guard came down to a value the untrusted side chose.
   */
  safeHandle(
    'db:recovery:delete-migrated',
    async (_event, args: { name?: string } | undefined) => {
      const name = args?.name;
      if (!name) return { success: false, error: 'A directory name is required.' };
      try {
        const userDataPath = getUserDataPath();
        const copies = listMigratedCopies(userDataPath);
        const target = copies.find((c) => c.name === name);
        if (!target) {
          return { success: false, error: 'That is not a preserved PGLite copy on this computer.' };
        }
        // Belt and braces on top of the allowlist: the name came from a scan,
        // but a traversal in it would still resolve outside userData.
        if (
          !name.startsWith(MIGRATED_DIR_PREFIX)
          || path.dirname(path.resolve(target.path)) !== path.resolve(userDataPath)
        ) {
          return { success: false, error: 'That path is not inside the Nimbalyst data folder.' };
        }
        // Deleting the rollback source while a cutover, a rollback or a
        // recovery is mid-flight would pull the floor out from under it.
        const run = await withDatabaseOperationLock('rollback', async () => {
          if (!(await confirmMigratedCopyDeletion(target))) return 'declined' as const;
          logger.main.info('[Recovery] Deleting a preserved PGLite copy at the user\'s request', {
            name,
            sizeBytes: target.sizeBytes,
            wasRollbackSource: target.isRollbackSource,
          });
          await fsp.rm(target.path, { recursive: true, force: true });
          return 'deleted' as const;
        });
        if (!run.acquired) {
          return { success: false, error: describeOperationConflict(run.heldBy, run.heldSince) };
        }
        if (run.value === 'declined') {
          return { success: false, declined: true, error: 'Deletion was not confirmed.' };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  );

  safeHandle(
    'db:recovery:reveal',
    async (_event, args: { name?: string } | undefined) => {
      const name = args?.name;
      if (!name) return { success: false, error: 'A directory name is required.' };
      try {
        const userDataPath = getUserDataPath();
        const { corruptionBackupDirs, migratedDirs } = findRecoveryArtifacts(userDataPath);
        if (![...corruptionBackupDirs, ...migratedDirs].includes(name)) {
          return { success: false, error: 'That is not a database copy on this computer.' };
        }
        shell.showItemInFolder(path.join(userDataPath, name));
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    },
  );
}
