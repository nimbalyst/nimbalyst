/**
 * Turning a PGLite artifact into a SQLite database, so it can be recovered onto
 * a SQLite-active install.
 *
 * Without this, `createSqliteRecoveryAdapter` falls back to a plain file copy,
 * which rejects a directory, and Settings marks every PGLite artifact
 * "restore unavailable" on a migrated install. That is precisely the affected
 * population from the incident this plan exists for: installs that migrated an
 * emptied PGLite store to SQLite and made the loss permanent. Their artifact is
 * a PGLite directory and their live database is a SQLite file, so the one case
 * that most needs recovery was the one case with no path through it.
 *
 * Three constraints shape the implementation:
 *
 *   - **The artifact is never opened.** PGLite replays WAL and writes
 *     `postmaster.pid` on open, and the artifact is the user's only copy of
 *     whatever it holds. So the store is copied to scratch first and the copy
 *     is what gets opened. The cost is one extra full copy; the alternative is
 *     mutating the evidence.
 *   - **PGLite is opened in a worker, never in-process.** `new PGlite()` on the
 *     main thread makes PGlite's WASM env re-`require()` the main bundle, which
 *     re-evaluates the bundled `electron-log` and dies with "Attempted to
 *     register a second handler for '__ELECTRON_LOG__'". This spawns the same
 *     `worker.bundle.js` the app runs on, pointed at the scratch copy.
 *   - **Everything it creates, it cleans up.** Scratch only: the copy it made
 *     and the SQLite it built. It never touches the artifact, the live
 *     database, or the staging path the transaction owns.
 *
 * The SQLite side runs on the calling thread. That is a real responsiveness
 * cost on a large store, and the reason it is acceptable here and not on the
 * automatic migration path is that recovery is a modal, explicitly-consented
 * operation on an app that is either showing a progress dialog or has already
 * failed to start. Moving it into the SQLite worker is the better home once
 * that worker grows a request that takes an arbitrary source directory.
 */

import { Worker } from 'worker_threads';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PGLiteToSQLiteMigrator, type PGLiteHandle } from '../sqlite/PGLiteToSQLiteMigrator';
import { SQLiteDatabase } from '../sqlite/SQLiteDatabase';
import type { CandidateMaterializer } from './backendAdapters';
import { copyDirectory, moveSqliteDatabase, removeScratch } from './recoveryFs';
import type { RecoveryLogFn } from './types';

/** PGLite's WAL replay on a large store can take a while; the migrator's reads cannot. */
const WORKER_INIT_TIMEOUT_MS = 180_000;
const WORKER_QUERY_TIMEOUT_MS = 30_000;

export interface PgliteArtifactMaterializerOptions {
  /** Absolute path to `worker.bundle.js`, resolved by the caller. */
  workerPath: string;
  /** Directory holding the SQLite migration SQL files. */
  schemaDir: string;
  /**
   * Where the scratch PGLite copy and the scratch SQLite target are built.
   * Should be on the same filesystem as the live database so the final move is
   * a rename.
   */
  scratchDir: string;
  log?: RecoveryLogFn;
}

/**
 * A `CandidateMaterializer` that handles both shapes a candidate can take: a
 * SQLite file is copied, a PGLite directory is migrated.
 */
export function createPgliteArtifactMaterializer(
  opts: PgliteArtifactMaterializerOptions,
): CandidateMaterializer {
  const log = opts.log ?? (() => {});

  return async (candidatePath: string, destPath: string): Promise<void> => {
    const info = await fs.stat(candidatePath);
    if (!info.isDirectory()) {
      await fs.copyFile(candidatePath, destPath);
      return;
    }

    const scratchRoot = path.join(
      opts.scratchDir,
      `recovery-materialize-${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
    // The worker derives its data directory as `<userDataPath>/pglite-db`, so
    // the copy has to land under that exact name.
    const pgliteCopy = path.join(scratchRoot, 'pglite-db');
    const sqliteScratchDir = path.join(scratchRoot, 'sqlite-db');

    try {
      log('info', '[Recovery] Copying the PGLite artifact to scratch before opening it', {
        candidatePath,
        pgliteCopy,
      });
      await copyDirectory(candidatePath, pgliteCopy);
      // A stale lock from whatever crashed while this store was live would stop
      // the throwaway worker from opening the copy. Removing it here is safe:
      // this is a copy this function made moments ago, in a directory no other
      // process knows about.
      await fs.rm(path.join(pgliteCopy, 'postmaster.pid'), { force: true });

      const pglite = await openPgliteWorker(opts.workerPath, scratchRoot, log);
      const sqlite = new SQLiteDatabase({
        dbDir: sqliteScratchDir,
        schemaDir: opts.schemaDir,
        log: (level, msg, meta) => log(level, msg, meta),
      });
      try {
        await sqlite.initialize();
        const summary = await new PGLiteToSQLiteMigrator().migrate({
          pglite: pglite.handle,
          sqlite,
          log: (level, msg, meta) => log(level, msg, meta),
        });
        log('info', '[Recovery] Materialized a PGLite artifact into SQLite', {
          rows: summary.totalRowsCopied,
          tables: summary.tablesCopied.length,
          integrityCheck: summary.integrityCheck,
        });
      } finally {
        // The PGLite side is a read-only scratch copy this call made; a close
        // that misbehaves there costs nothing. The SQLite side is the database
        // about to become the user's, and its close is handled below, not
        // here, because a `finally` cannot refuse to continue.
        await pglite.close();
      }

      // Invariant 4: a close failure is never suppressed. This used to be
      // `.catch(log warn)` immediately before the rename below, which is the
      // single most dangerous shape available: better-sqlite3 keeps the newest
      // pages in `-wal` until the closing checkpoint, so a close that failed
      // and a rename that moved only the main file produced a structurally
      // valid database missing its most recent writes -- and verification
      // passed it, because what it opened really was a valid SQLite file.
      await sqlite.close();

      const built = path.join(sqliteScratchDir, 'nimbalyst.sqlite');
      if (!fsSync.existsSync(built)) {
        throw new Error(`migration produced no database at ${built}`);
      }
      // And move the sidecars with it. A clean close checkpoints and removes
      // them, so normally there is nothing to move; when there is, leaving a
      // `-wal` behind in a scratch directory that the `finally` below deletes
      // is the same data loss by a slower route. `moveSqliteDatabase` is
      // all-or-nothing.
      await moveSqliteDatabase(built, destPath);
    } finally {
      // Scratch only. `removeScratch` is pointed at a directory this call
      // created and nothing else has a name for.
      await removeScratch(scratchRoot).catch((err) => {
        log('warn', '[Recovery] Could not clean up materialization scratch', {
          scratchRoot,
          err,
        });
      });
    }
  };
}

// ---------------------------------------------------------------------------

interface PgliteWorkerSession {
  handle: PGLiteHandle;
  close(): Promise<void>;
}

/**
 * Spawn the app's PGLite worker against a scratch data directory and expose the
 * read surface the migrator wants. `exec` throws: this session exists to read a
 * copy of an artifact, and nothing in the read path should be writing to it.
 */
async function openPgliteWorker(
  workerPath: string,
  userDataPath: string,
  log: RecoveryLogFn,
): Promise<PgliteWorkerSession> {
  if (!fsSync.existsSync(workerPath)) {
    throw new Error(`PGLite worker bundle not found at ${workerPath}`);
  }

  const worker = new Worker(workerPath, { workerData: { userDataPath } });
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let fatal: Error | null = null;

  const failAll = (err: Error) => {
    fatal = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };

  worker.on('message', (response: { id?: string; success?: boolean; data?: unknown; error?: string }) => {
    const entry = response?.id ? pending.get(response.id) : undefined;
    if (!entry) return;
    pending.delete(response.id!);
    if (response.success) entry.resolve(response.data);
    else entry.reject(new Error(response.error ?? 'PGLite worker request failed'));
  });
  worker.on('error', (err) => failAll(err));
  worker.on('exit', (code) => failAll(new Error(`PGLite worker exited (code ${code})`)));

  const request = <T>(type: string, payload: unknown, timeoutMs: number): Promise<T> => {
    if (fatal) return Promise.reject(fatal);
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`PGLite worker ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      worker.postMessage({ id, type, payload });
    });
  };

  const close = async (): Promise<void> => {
    try {
      if (!fatal) await request('close', {}, 60_000);
    } catch (err) {
      log('warn', '[Recovery] PGLite scratch worker did not close cleanly', err);
    } finally {
      await worker.terminate();
    }
  };

  try {
    await request('init', {}, WORKER_INIT_TIMEOUT_MS);
  } catch (err) {
    await worker.terminate();
    throw err;
  }

  return {
    close,
    handle: {
      query: <T = unknown,>(sql: string, params?: unknown[]) =>
        request<{ rows: T[] }>(
          'queryReadOnly',
          { sql, params, timeoutMs: WORKER_QUERY_TIMEOUT_MS },
          WORKER_QUERY_TIMEOUT_MS + 10_000,
        ),
      exec: () =>
        Promise.reject(
          new Error('Recovery materialization reads the artifact copy; exec() is not supported'),
        ),
      close: () => Promise.resolve(),
    },
  };
}
