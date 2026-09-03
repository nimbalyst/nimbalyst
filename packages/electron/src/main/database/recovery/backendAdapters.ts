/**
 * The two backend adapters for `runRecoveryTransaction`.
 *
 * Everything backend-specific lives here and nothing else does: how to close
 * and reopen, what a database is on disk, how to check one, and what the
 * copies left behind are called. The transaction itself does not know which
 * backend it is driving.
 *
 * The important consequence is the one the plan asks for: recovery preserves
 * the active backend. A PGLite artifact recovered on a SQLite-active install
 * is staged through a materializer into a fresh SQLite target and verified
 * there. It never puts a PGLite directory back in front of the app.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  copyDirectory,
  moveDirectory,
  moveSqliteDatabase,
  pathExists,
  removeScratch,
  removeSqliteDatabase,
} from './recoveryFs';
import type { RecoveryBackendAdapter } from './recoveryTransaction';
import type { ContentIndicators, RecoveryVerification } from './types';

/**
 * The read surface both engines expose. `PGLiteDatabaseWorker` and
 * `SQLiteDatabaseProxy` both satisfy it; taking the structural type rather
 * than the classes keeps this module out of their dependency graphs and lets
 * the tests drive real files through a small fake.
 */
export interface RecoveryEngineHandle {
  initialize(): Promise<void>;
  close(): Promise<void>;
  queryReadOnly<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Produce a database in the active backend's format from a candidate. For a
 * same-format candidate this is a copy; for a PGLite artifact on a
 * SQLite-active install it is a migration.
 */
export type CandidateMaterializer = (candidatePath: string, destPath: string) => Promise<void>;

/**
 * Read the content indicators through whatever query path production uses.
 * Counts come back as strings on PGLite and numbers on SQLite, so both go
 * through `Number`. A query that throws yields `null`, which the assessment
 * treats as unreadable rather than empty.
 */
export async function readIndicatorsThrough(
  engine: Pick<RecoveryEngineHandle, 'queryReadOnly'>,
): Promise<ContentIndicators> {
  const count = async (table: string): Promise<number | null> => {
    try {
      const result = await engine.queryReadOnly<{ c: number | string }>(
        `SELECT COUNT(*) AS c FROM ${table}`,
      );
      const raw = result.rows[0]?.c;
      if (raw === undefined || raw === null) return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  return {
    sessionCount: await count('ai_sessions'),
    documentHistoryCount: await count('document_history'),
    projectCount: await count('projects'),
  };
}

/**
 * Rows in `ai_agent_messages`, through the production query path.
 *
 * Read separately from the indicators because only the live side needs it, and
 * because it is the one count that says a person used this database rather than
 * that the app opened a window over it. See `CandidateAssessmentFacts`.
 * `null` on any failure -- unreadable is never zero.
 */
export async function readAgentMessageCountThrough(
  engine: Pick<RecoveryEngineHandle, 'queryReadOnly'>,
): Promise<number | null> {
  try {
    const result = await engine.queryReadOnly<{ c: number | string }>(
      'SELECT COUNT(*) AS c FROM ai_agent_messages',
    );
    const raw = result.rows[0]?.c;
    if (raw === undefined || raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PGLite
// ---------------------------------------------------------------------------

export interface PgliteRecoveryAdapterOptions {
  /** The live `pglite-db/` directory. */
  livePath: string;
  engine: RecoveryEngineHandle;
  /**
   * Full validation of a PGLite store at an arbitrary path. Must not run on
   * the main thread; in production this is a short-lived PGLite worker, which
   * is also the only thing that can look at a store after the live engine has
   * been closed.
   */
  verify: (dbPath: string) => Promise<RecoveryVerification>;
}

/**
 * Drop the lock file from a PGLite store this transaction created.
 *
 * PGLite does NOT remove `postmaster.pid` on a clean close -- a corruption
 * artifact that has only ever been opened by cleanly-closing verification
 * workers still has one. So every copy we make inherits a lock naming a
 * process that is long gone, and the next opener treats the store as having
 * crashed and takes the recovery path instead of the clean-open path.
 *
 * That is not hypothetical here. A recovery whose staged copy verified with
 * two sessions and a history snapshot reopened, through the production worker,
 * reporting one session and no history -- the bytes were all on disk (the
 * abandoned copy was the largest store in the directory) and the store simply
 * did not come back the same way twice. It reproduced on roughly one run in
 * five.
 *
 * `createPgliteArtifactMaterializer` already does exactly this to its scratch
 * copy, with the same reasoning written next to it. The adapter did not, so
 * the copy that becomes the user's live database was the one path that kept
 * the stale lock.
 *
 * Only ever applied to paths this transaction created and has just finished
 * verifying: `stagingPath` and `preRestoreSnapshotPath`. The artifact itself is
 * probed through `probeCandidate`, never through here, and is never modified.
 */
async function dropStaleLock(storePath: string): Promise<void> {
  await fs.rm(path.join(storePath, 'postmaster.pid'), { force: true });
}

export function createPgliteRecoveryAdapter(
  opts: PgliteRecoveryAdapterOptions,
): RecoveryBackendAdapter {
  const { livePath, engine, verify } = opts;
  const parent = path.dirname(livePath);
  const base = path.basename(livePath);

  return {
    backend: 'pglite',
    livePath,
    recoveryPathFor: (label, timestamp) => path.join(parent, `${base}.${label}-${timestamp}`),
    quiesce: () => engine.close(),
    reopen: () => engine.initialize(),
    snapshot: (destPath) => copyDirectory(livePath, destPath),
    // A PGLite artifact restored onto a PGLite install is the same format.
    stage: (candidatePath, destPath) => copyDirectory(candidatePath, destPath),
    // Verification opens the store, and the opener leaves a lock behind. This
    // runs after it, so the copy that gets promoted is one a fresh PGLite will
    // open cleanly rather than crash-recover.
    verify: async (targetPath) => {
      const result = await verify(targetPath);
      await dropStaleLock(targetPath).catch(() => {
        // A lock we could not remove is not a reason to fail a verification
        // that otherwise passed; the promote is still an improvement on the
        // store the user has now.
      });
      return result;
    },
    readLiveIndicators: () => readIndicatorsThrough(engine),
    move: moveDirectory,
    exists: pathExists,
    discardScratch: removeScratch,
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export interface SqliteRecoveryAdapterOptions {
  /** The live `nimbalyst.sqlite` file. */
  livePath: string;
  engine: RecoveryEngineHandle;
  /** Full off-thread `integrity_check` + schema + content validation. */
  verify: (dbPath: string) => Promise<RecoveryVerification>;
  /**
   * How a candidate becomes a SQLite file. Defaults to a plain copy, which
   * only handles a SQLite candidate; supply a migrating materializer to
   * recover a PGLite artifact without flipping the install back to PGLite.
   */
  materialize?: CandidateMaterializer;
}

export function createSqliteRecoveryAdapter(
  opts: SqliteRecoveryAdapterOptions,
): RecoveryBackendAdapter {
  const { livePath, engine, verify } = opts;
  const dir = path.dirname(livePath);
  const base = path.basename(livePath).replace(/\.sqlite$/, '');
  const materialize = opts.materialize ?? copySqliteCandidate;

  return {
    backend: 'sqlite',
    livePath,
    // Keeps the `.sqlite` suffix last so every copy stays openable by the
    // same tooling that opens the live database.
    recoveryPathFor: (label, timestamp) =>
      path.join(dir, `${base}.${label}-${timestamp}.sqlite`),
    quiesce: () => engine.close(),
    reopen: () => engine.initialize(),
    snapshot: (destPath) => copySqliteCandidate(livePath, destPath),
    stage: (candidatePath, destPath) => materialize(candidatePath, destPath),
    verify,
    readLiveIndicators: () => readIndicatorsThrough(engine),
    move: moveSqliteDatabase,
    exists: pathExists,
    discardScratch: removeSqliteDatabase,
  };
}

/**
 * Copy a SQLite database file. Rejects a directory rather than guessing: a
 * PGLite artifact reaching here means no migrating materializer was wired,
 * and failing loudly before anything moves is the safe outcome.
 */
async function copySqliteCandidate(candidatePath: string, destPath: string): Promise<void> {
  const info = await fs.stat(candidatePath);
  if (info.isDirectory()) {
    throw new Error(
      'Candidate is a PGLite store but no migrating materializer is configured; ' +
        'recovering it would require converting it to SQLite first.',
    );
  }
  await fs.copyFile(candidatePath, destPath);
}
