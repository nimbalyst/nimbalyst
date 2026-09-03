/**
 * The one place recovery is wired to the running app.
 *
 * Both surfaces that can start a recovery -- Settings > Database and the
 * database-failure dialog -- come through here, so they cannot drift into
 * having different verifiers, different materializers, different analytics, or
 * one of them journaling and the other not. The previous arrangement had the
 * IPC handler build all of this inline and the failure dialog build none of it,
 * which is how the dialog's "Restore Backup" button ended up performing a
 * reveal.
 *
 * What this adds on top of `RecoveryService`:
 *
 *   - the off-thread verifiers for both on-disk formats;
 *   - the migrating materializer, so a PGLite artifact can be recovered onto a
 *     SQLite-active install without flipping the install back to PGLite;
 *   - the durable journal, so a process killed mid-swap leaves the next launch
 *     something to read;
 *   - the main-owned analytics mapper, so `recovery_started` actually leaves
 *     the machine.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { logger } from '../../utils/logger';
import { getPackageRoot } from '../../utils/appPaths';
import { database } from '../PGLiteDatabaseWorker';
import { resolveBackend } from '../sqlite/BackendSelector';
import { resolveDatabaseUserDataPath } from '../userDataPath';
import { createPgliteRecoveryAdapter, createSqliteRecoveryAdapter } from './backendAdapters';
import { readAgentMessageCountThrough, readIndicatorsThrough } from './backendAdapters';
import { createPgliteArtifactMaterializer } from './pgliteToSqliteMaterializer';
import { createPgliteRecoveryVerifier } from './pgliteVerification';
import { createRecoveryVerifier } from './recoveryVerification';
import { createRecoveryJournalPort } from './recoveryJournal';
import { emitRecoveryEvent, type RecoveryTrigger } from './recoveryEventMapper';
import { pathSizeBytes } from './recoveryFs';
import { RecoveryService } from './RecoveryService';
import { runRecoveryTransaction, type RecoveryBackendAdapter } from './recoveryTransaction';
import {
  sizeBucketFor,
  type ActiveBackend,
  type RecoveryLogFn,
  type RecoveryOutcome,
  type RecoveryVerification,
} from './types';

export const PGLITE_DIR = 'pglite-db';
export const SQLITE_RELPATH = path.join('sqlite-db', 'nimbalyst.sqlite');

export function getUserDataPath(): string {
  return resolveDatabaseUserDataPath();
}

export function activeBackend(userDataPath = getUserDataPath()): ActiveBackend {
  return resolveBackend({ userDataPath }).backend;
}

export function liveDatabasePath(userDataPath: string, backend: ActiveBackend): string {
  return backend === 'pglite'
    ? path.join(userDataPath, PGLITE_DIR)
    : path.join(userDataPath, SQLITE_RELPATH);
}

/** The PGLite worker bundle, resolved the same way `PGLiteDatabaseWorker` does. */
export function pgliteWorkerPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'worker.bundle.js')
    : path.join(getPackageRoot(), 'out', 'worker.bundle.js');
}

/**
 * Duplicated from `initialize.ts` rather than imported: that module runs the
 * whole database bootstrap as a side effect of being loaded, and the failure
 * dialog needs this after that bootstrap has already thrown.
 */
export function resolveSchemaDir(): string {
  const candidates = [
    path.resolve(__dirname, 'sqlite', 'schemas'),
    path.resolve(__dirname, '..', 'sqlite', 'schemas'),
    path.join(app.getAppPath(), 'out', 'main', 'sqlite', 'schemas'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export const recoveryLog: RecoveryLogFn = (level, msg, meta) => {
  if (level === 'error') logger.main.error(msg, meta);
  else if (level === 'warn') logger.main.warn(msg, meta);
  else logger.main.info(msg, meta);
};

/**
 * Probe a database at an arbitrary path. Dispatches on what is actually on
 * disk rather than on the name: a directory is a PGLite store, a file is
 * SQLite.
 */
export function createCandidateProbe(
  userDataPath = getUserDataPath(),
): (p: string) => Promise<RecoveryVerification> {
  const verifyPglite = createPgliteRecoveryVerifier({
    workerPath: pgliteWorkerPath(),
    userDataPath,
    log: recoveryLog,
  });
  const verifySqlite = createRecoveryVerifier({ workerDir: __dirname, log: recoveryLog });
  return async (candidatePath: string): Promise<RecoveryVerification> => {
    let isDirectory = false;
    try {
      isDirectory = (await fsp.stat(candidatePath)).isDirectory();
    } catch (err) {
      return {
        valid: false,
        integrity: 'unreadable',
        requiredSchemaPresent: false,
        indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
        error: (err as Error).message,
      };
    }
    return isDirectory ? verifyPglite(candidatePath) : verifySqlite(candidatePath);
  };
}

/**
 * The adapter for whichever backend is live, complete with the materializer
 * that lets a PGLite artifact become a SQLite database.
 */
export function buildProductionRecoveryAdapter(
  userDataPath: string,
  backend: ActiveBackend,
): RecoveryBackendAdapter {
  if (backend === 'pglite') {
    return createPgliteRecoveryAdapter({
      livePath: path.join(userDataPath, PGLITE_DIR),
      engine: database,
      verify: createPgliteRecoveryVerifier({
        workerPath: pgliteWorkerPath(),
        userDataPath,
        log: recoveryLog,
      }),
    });
  }
  const livePath = path.join(userDataPath, SQLITE_RELPATH);
  return createSqliteRecoveryAdapter({
    livePath,
    engine: database,
    verify: createRecoveryVerifier({ workerDir: __dirname, log: recoveryLog }),
    // Without this the SQLite adapter refuses every directory candidate, which
    // is every artifact an affected install has.
    materialize: createPgliteArtifactMaterializer({
      workerPath: pgliteWorkerPath(),
      schemaDir: resolveSchemaDir(),
      scratchDir: path.dirname(livePath),
      log: recoveryLog,
    }),
  });
}

/**
 * Build the service for the current launch. Cheap -- a bag of closures over the
 * live engine -- so it is rebuilt per call rather than cached, which also means
 * it always reflects the backend that is actually active.
 */
export function buildProductionRecoveryService(trigger: RecoveryTrigger): RecoveryService {
  const userDataPath = getUserDataPath();
  const backend = activeBackend(userDataPath);
  return new RecoveryService({
    userDataPath,
    activeBackend: backend,
    adapter: buildProductionRecoveryAdapter(userDataPath, backend),
    probeCandidate: createCandidateProbe(userDataPath),
    readLiveIndicators: () => readIndicatorsThrough(database),
    readLiveAgentMessageCount: () => readAgentMessageCountThrough(database),
    journal: createRecoveryJournalPort(userDataPath),
    emit: (event) => emitRecoveryEvent(event, trigger),
    log: recoveryLog,
  });
}

/**
 * Restore from a copy the user named on the database-failure dialog.
 *
 * No candidate assessment: the app could not start, so there is no live
 * database to compare against and no verdict to compute. Every other guarantee
 * the transaction gives still applies -- verified staging, the empty-candidate
 * refusal, the atomic swap, the preserved displaced database, and the journal.
 */
export async function restoreFromNamedBackup(args: {
  backupPath: string;
  backupName: string;
}): Promise<RecoveryOutcome> {
  const userDataPath = getUserDataPath();
  const backend = activeBackend(userDataPath);
  const adapter = buildProductionRecoveryAdapter(userDataPath, backend);
  return runRecoveryTransaction({
    candidateId: `failure-dialog:${args.backupName}`,
    candidatePath: args.backupPath,
    adapter,
    context: {
      candidateSizeBucket: sizeBucketFor(await pathSizeBytes(args.backupPath)),
      liveSizeBucket: sizeBucketFor(await pathSizeBytes(adapter.livePath)),
      reasonCode: null,
    },
    journal: createRecoveryJournalPort(userDataPath),
    emit: (event) => emitRecoveryEvent(event, 'failure-dialog'),
    log: recoveryLog,
  });
}
