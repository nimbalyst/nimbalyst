/**
 * Undoing a migration: SQLite back to the preserved PGLite store.
 *
 * A rollback is a cutover run the other way. It quiesces the live engine,
 * moves that engine's store aside, promotes an already-populated directory
 * into the live path, and points the backend flag at it -- which is, step for
 * step, what `MigrationAdopter` does in the forward direction. So it runs on
 * `runCutover` rather than on a second hand-written copy of those steps, and
 * it is journaled by `cutoverJournal.ts` rather than by a journal of its own.
 *
 * Two defects this replaces, both in the version that lived in the SQLite
 * worker:
 *
 *   1. **It chose its source by sorting.** It took every
 *      `pglite-db.migrated-*` directory, sorted the names, and restored the
 *      last one. An install with more than one preserved store -- an earlier
 *      dry-run adoption, a second migration attempt, a directory a user copied
 *      in -- got back a database that had nothing to do with the migration it
 *      was undoing. The flag file has recorded `pgliteMigratedDir` since the
 *      migration wrote it; that is the only answer, and when it is missing and
 *      the disk offers a choice this refuses rather than guessing.
 *
 *   2. **The two renames were unjournaled.** Between "sqlite-db/ is gone" and
 *      "pglite-db/ is back" the install has no database at either live path,
 *      and the flag still said SQLite. A crash in that window -- or a second
 *      rename the OS refused -- left the next launch resolving to SQLite,
 *      finding nothing at `sqlite-db/`, and creating an empty one. The journal
 *      closes that window: `reconcileCutoverOnStartup` sees a rollback that
 *      got as far as preserving its source, finds the staged PGLite store
 *      where the journal says it is, and finishes the promotion and the flag
 *      write. It never has to infer any of that from the directory listing.
 *
 * Nothing here deletes anything. The retired `sqlite-db.rolledback-*` stays on
 * disk exactly as `pglite-db.migrated-*` does after a migration.
 */

import * as fs from 'fs';
import * as path from 'path';

import { readBackendState } from './BackendSelector';
import { runCutover } from './cutoverMachine';
import type { CutoverFs } from './cutoverJournal';

export interface RollbackRequest {
  userDataPath: string;
  operationId?: string;
  /**
   * Close the live SQLite worker. If this rejects the rollback stops before
   * anything is renamed -- a store we cannot prove is closed is a store that
   * may still be taking writes.
   */
  quiesceSqlite: () => Promise<void>;
  cutoverFs?: CutoverFs;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

export interface RollbackResult {
  /** Absolute path of the preserved store that is now live. */
  restoredFrom: string;
  /** Absolute path the retired SQLite store was moved to. Never deleted. */
  retiredSqliteDir: string;
}

const MIGRATED_PREFIX = 'pglite-db.migrated-';

/**
 * Which preserved store this install migrated from.
 *
 * The recorded path wins whenever it is on disk. The single-candidate
 * fallback exists for installs whose flag predates the field or was written
 * with an empty one; with exactly one preserved store there is no choice to
 * get wrong. Two or more and no record is the ambiguous case, and guessing
 * there is how a user gets somebody else's database back.
 */
export function resolveRollbackSource(userDataPath: string): {
  dir: string;
  from: 'recorded' | 'sole-candidate';
} {
  const recorded = readBackendState(userDataPath)?.pgliteMigratedDir;
  if (recorded && isPgliteStore(recorded)) return { dir: recorded, from: 'recorded' };

  let candidates: string[] = [];
  try {
    candidates = fs
      .readdirSync(userDataPath)
      .filter((d) => d.startsWith(MIGRATED_PREFIX))
      .map((d) => path.join(userDataPath, d))
      .filter(isPgliteStore);
  } catch {
    candidates = [];
  }

  if (recorded) {
    throw new Error(
      `The preserved database this install migrated from (${path.basename(recorded)}) is not on `
      + `disk. ${candidates.length} other preserved database(s) are present, but restoring one of `
      + 'those would activate a database from a different migration. Nothing has been changed.',
    );
  }
  if (candidates.length === 0) {
    throw new Error('No preserved PGLite database to roll back to.');
  }
  if (candidates.length > 1) {
    throw new Error(
      `This install's backend record does not name which preserved database it migrated from, and `
      + `${candidates.length} are present. Nimbalyst will not guess between them. Nothing has been `
      + 'changed.',
    );
  }
  return { dir: candidates[0], from: 'sole-candidate' };
}

/** Does this directory look like a PostgreSQL data directory? */
function isPgliteStore(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, 'PG_VERSION'));
}

export async function runRollback(req: RollbackRequest): Promise<RollbackResult> {
  const { userDataPath } = req;
  const log = req.log ?? (() => {});

  const pgliteDir = path.join(userDataPath, 'pglite-db');
  const sqliteDir = path.join(userDataPath, 'sqlite-db');

  // Resolved before the quiesce so a refusal costs the user nothing: the app
  // is still running on the database it had.
  const source = resolveRollbackSource(userDataPath);
  if (fs.existsSync(pgliteDir)) {
    throw new Error(
      'pglite-db/ already exists; refusing to overwrite it. Nothing has been changed.',
    );
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const retiredSqliteDir = path.join(userDataPath, `sqlite-db.rolledback-${stamp}`);

  log('info', '[rollback] restoring the preserved PGLite store', {
    source: path.basename(source.dir),
    selectedBy: source.from,
    retiringTo: path.basename(retiredSqliteDir),
  });

  await runCutover({
    userDataPath,
    operationId: req.operationId ?? `rollback-${Date.now()}`,
    operation: 'rollback',
    commitBackend: 'pglite',
    // The engine being retired is the cutover's "source"; the one coming back
    // is its "target". Same five steps, same journal, opposite direction.
    sourceLiveDir: sqliteDir,
    sourcePreservedDir: retiredSqliteDir,
    targetLiveDir: pgliteDir,
    targetStagingDir: source.dir,
    cutoverFs: req.cutoverFs,
    log,
    // Runs while SQLite is still live and authoritative, so throwing costs
    // nothing. The shipped rollback verified nothing at all and would happily
    // promote an empty directory into `pglite-db/`.
    verifyTarget: async () => {
      if (!isPgliteStore(source.dir)) {
        throw new Error(
          `${path.basename(source.dir)} is not a usable PostgreSQL data directory; refusing to `
          + 'activate it.',
        );
      }
    },
    quiesceSource: req.quiesceSqlite,
  });

  return { restoredFrom: source.dir, retiredSqliteDir };
}
