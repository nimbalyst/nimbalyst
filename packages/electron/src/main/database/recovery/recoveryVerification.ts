/**
 * Full validation of a database we are about to make authoritative.
 *
 * Deliberately not `backupVerification.ts`. That module runs `PRAGMA
 * quick_check`, which is the right trade for the routine startup backup: its
 * inputs come from SQLite's own Online Backup API, so index consistency
 * follows from the pages copying cleanly, and `integrity_check` over a 6.3 GB
 * database once blocked the query worker for 66 seconds and killed 221 queued
 * requests (NIM-3613).
 *
 * Recovery is the other trade. Its input is a database that something already
 * decided was corrupt, and the output replaces the user's live store. The plan
 * is explicit that `quick_check` does not authorize a destructive replacement,
 * so this runs the full `integrity_check`, checks that the tables we depend on
 * are actually there, and reads the same content indicators the assessment
 * used — and it runs off the calling thread precisely because it is expensive.
 *
 * Ordering matters: the cheap structural checks run before the scan, so a file
 * that is not a database at all is rejected without paying for a full read.
 */

import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { loadBetterSqlite, nativeBindingOverride } from '../sqlite/betterSqliteLoader';
import type { ContentIndicators, RecoveryLogFn, RecoveryVerification } from './types';

/**
 * Tables the app cannot start without. A candidate missing any of them is not
 * a Nimbalyst database, whatever its integrity check says.
 */
export const REQUIRED_TABLES = ['ai_sessions', 'document_history', 'projects'] as const;

/** Filename of the recovery verification worker bundle, sibling of the caller's bundle. */
export const RECOVERY_VERIFY_WORKER_FILENAME = 'sqlite-recovery-verify-worker.bundle.js';

const UNREADABLE = (error: string): RecoveryVerification => ({
  valid: false,
  integrity: 'unreadable',
  requiredSchemaPresent: false,
  indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
  error,
});

/**
 * Synchronous full verification. Blocks the calling thread for as long as it
 * takes to read every page, so only call this on a thread with nothing else to
 * do — see `createRecoveryVerifier`.
 */
export function verifyRecoveryTargetFile(dbPath: string): RecoveryVerification {
  let Sqlite: ReturnType<typeof loadBetterSqlite>;
  try {
    Sqlite = loadBetterSqlite();
  } catch (err) {
    return UNREADABLE((err as Error).message);
  }

  let handle: InstanceType<ReturnType<typeof loadBetterSqlite>>;
  try {
    const nativeBinding = nativeBindingOverride();
    handle = new Sqlite(
      dbPath,
      nativeBinding
        ? { fileMustExist: true, readonly: true, nativeBinding }
        : { fileMustExist: true, readonly: true },
    );
  } catch (err) {
    return UNREADABLE((err as Error).message);
  }

  try {
    // Cheap first: a file that has no schema is rejected without a full scan.
    const present = new Set(
      (handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]).map((r) => r.name),
    );
    const requiredSchemaPresent = REQUIRED_TABLES.every((t) => present.has(t));
    if (!requiredSchemaPresent) {
      return {
        valid: false,
        integrity: 'not-checked',
        requiredSchemaPresent: false,
        indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
        error: `missing required tables: ${REQUIRED_TABLES.filter((t) => !present.has(t)).join(', ')}`,
      };
    }

    const check = (handle.pragma('integrity_check', { simple: true }) as string) ?? '';
    if (check !== 'ok') {
      return {
        valid: false,
        integrity: 'failed',
        requiredSchemaPresent: true,
        indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
        error: `integrity_check returned: ${check}`,
      };
    }

    const indicators: ContentIndicators = {
      sessionCount: countRows(handle, 'ai_sessions'),
      documentHistoryCount: countRows(handle, 'document_history'),
      projectCount: countRows(handle, 'projects'),
    };
    return { valid: true, integrity: 'ok', requiredSchemaPresent: true, indicators };
  } catch (err) {
    return UNREADABLE((err as Error).message);
  } finally {
    try {
      handle.close();
    } catch {
      // Nothing to do; the handle is read-only.
    }
  }
}

function countRows(handle: { prepare: (sql: string) => { get: () => unknown } }, table: string): number | null {
  try {
    const row = handle.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
    return row?.c ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify on a dedicated worker thread so the caller's thread stays responsive.
 *
 * `workerDir` is the directory holding the verification bundle. Falls back to
 * inline verification when the bundle is missing or the thread cannot be
 * spawned: a packaging miss must degrade to blocking rather than skip a
 * data-safety gate, and it says so loudly in the log.
 */
export function createRecoveryVerifier(opts: {
  workerDir: string;
  log?: RecoveryLogFn;
}): (dbPath: string) => Promise<RecoveryVerification> {
  const { workerDir, log } = opts;
  return (dbPath: string) => {
    const workerPath = path.join(workerDir, RECOVERY_VERIFY_WORKER_FILENAME);
    if (!fs.existsSync(workerPath)) {
      log?.('warn', '[Recovery] Verification worker bundle missing; verifying inline', { workerPath });
      return Promise.resolve(verifyRecoveryTargetFile(dbPath));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RecoveryVerification) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let worker: Worker;
      try {
        worker = new Worker(workerPath, { workerData: { dbPath } });
      } catch (err) {
        log?.('warn', '[Recovery] Could not spawn verification worker; verifying inline', err);
        finish(verifyRecoveryTargetFile(dbPath));
        return;
      }

      worker.on('message', (result: RecoveryVerification) => {
        finish(result);
        void worker.terminate();
      });
      worker.on('error', (err) => {
        log?.('warn', '[Recovery] Verification worker errored; verifying inline', err);
        finish(verifyRecoveryTargetFile(dbPath));
      });
      worker.on('exit', (code) => {
        finish(UNREADABLE(`verification worker exited (code ${code}) without a result`));
      });
    });
  };
}
