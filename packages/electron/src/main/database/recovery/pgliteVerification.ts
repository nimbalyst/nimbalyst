/**
 * Verifying a PGLite store at an arbitrary path, off the calling thread.
 *
 * `PGLiteDatabaseWorker.verifyBackup()` cannot be used for recovery: it routes
 * through the *live* worker, and by the time recovery verifies anything the
 * live worker has been closed — quiescing before touching the live database is
 * the whole point of the ordering. So this spawns a throwaway worker thread
 * from the same bundle and sends it a single `verifyBackup` message, which the
 * worker answers by opening its own PGLite at the given path. It never calls
 * `init`, so it never takes the lock on the live store.
 *
 * PGLite has no `integrity_check` equivalent, so `integrity` is reported as
 * `not-applicable` when the store opens and answers a query, and `unreadable`
 * when it does not. The content indicators are what carries the weight for
 * this backend, and they are the same ones the assessment used.
 */

import { Worker } from 'worker_threads';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { RecoveryLogFn, RecoveryVerification } from './types';

/** Long enough for PGLite's WAL recovery on a large store to finish. */
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;

/**
 * Prefix on every `unreadable` verdict caused by our own verifier rather than
 * by the artifact.
 *
 * The distinction is the whole point. `unreadable` stops a recovery, and for
 * the affected population it stopped every recovery: `new Worker(workerPath)`
 * was spawned with no `workerData`, `worker.js` dereferenced
 * `workerData.userDataPath` in its constructor, the thread died with a
 * `TypeError` before it read a single byte, and the `error` handler resolved
 * `unreadable` without logging anything. Every PGLite artifact assessed as
 * `candidate_unreadable` and Settings offered recovery to nobody. A log line
 * saying "the artifact could not be read" is indistinguishable from a log line
 * saying "our verifier crashed" unless one of them says so.
 */
export const VERIFIER_FAILURE_PREFIX = 'pglite verification worker failed:';

function unreadable(error: string): RecoveryVerification {
  return {
    valid: false,
    integrity: 'unreadable',
    requiredSchemaPresent: false,
    indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
    error,
  };
}

/** True when this verdict came from our own verifier dying, not from the artifact. */
export function isVerifierFailure(verification: RecoveryVerification): boolean {
  return verification.error?.startsWith(VERIFIER_FAILURE_PREFIX) ?? false;
}

interface WorkerVerifyPayload {
  valid?: boolean;
  error?: string;
  sessionCount?: number;
  historyCount?: number;
  projectCount?: number;
}

export function toRecoveryVerification(data: WorkerVerifyPayload): RecoveryVerification {
  if (!data?.valid) return unreadable(data?.error ?? 'PGLite store did not open');
  // An absent count means the worker could not read the table, not that the
  // table is empty. A store with no `ai_sessions` table is not one we can
  // restore onto, so that reads as absent schema rather than as emptiness.
  const sessionCount = typeof data.sessionCount === 'number' ? data.sessionCount : null;
  const documentHistoryCount = typeof data.historyCount === 'number' ? data.historyCount : null;
  // `projects` is reported separately by the worker and stays `null` on a
  // store that predates the table, which the assessment treats as "no evidence
  // from this indicator" rather than as unreadable. Without it a project-only
  // database read as empty and could not be recovered.
  const projectCount = typeof data.projectCount === 'number' ? data.projectCount : null;
  return {
    valid: true,
    integrity: 'not-applicable',
    requiredSchemaPresent: sessionCount !== null && documentHistoryCount !== null,
    indicators: { sessionCount, documentHistoryCount, projectCount },
  };
}

/**
 * `workerPath` is the PGLite worker bundle — `worker.bundle.js`, resolved by
 * the caller because only it knows whether the app is packaged.
 *
 * Fails closed. If the bundle is missing or the thread cannot start, this
 * reports `unreadable`, which stops recovery rather than letting it proceed on
 * an unverified database.
 */
export function createPgliteRecoveryVerifier(opts: {
  workerPath: string;
  /**
   * The install's database root. `worker.js` builds its data directory, its
   * lock file and its CPU-profile output path from this, and reads it out of
   * `workerData` in its constructor -- so a spawn without it dies before the
   * message handler is even installed. Required rather than optional for
   * exactly that reason: the version of this that let the caller forget was
   * the version that disabled recovery for the whole affected population.
   */
  userDataPath: string;
  log?: RecoveryLogFn;
  timeoutMs?: number;
}): (dbPath: string) => Promise<RecoveryVerification> {
  const { workerPath, userDataPath, log } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;

  return (dbPath: string) =>
    new Promise<RecoveryVerification>((resolve) => {
      let settled = false;
      let worker: Worker | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (result: RecoveryVerification) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        void worker?.terminate();
        resolve(result);
      };

      /**
       * Our fault, not the artifact's. Logged at error and marked in the
       * verdict so a reader of `main.log` -- and `isVerifierFailure` -- can
       * tell the two apart.
       *
       * The `settled` guard is load-bearing for the log, not just for the
       * promise: `finish` terminates the worker, which fires `exit` with code
       * 1, so logging before checking would put a loud "our verifier failed"
       * error in `main.log` after every SUCCESSFUL verification. A diagnostic
       * that cries wolf on the happy path is worse than no diagnostic.
       */
      const verifierFailed = (what: string, detail: string): void => {
        if (settled) return;
        log?.(
          'error',
          `[Recovery] PGLite verification worker ${what}; reporting this candidate as unreadable `
            + 'because our own verifier failed, NOT because the artifact is bad. Recovery will be '
            + 'declined for it until this is fixed.',
          { dbPath, workerPath, userDataPath, detail },
        );
        finish(unreadable(`${VERIFIER_FAILURE_PREFIX} ${what}: ${detail}`));
      };

      if (!fs.existsSync(workerPath)) {
        verifierFailed('bundle missing', `no worker bundle at ${workerPath}`);
        return;
      }

      try {
        // `workerData` is the fix. `PGLiteDatabaseWorker.createWorker()` has
        // always passed it; this spawn did not, and nothing typed the two
        // together.
        worker = new Worker(workerPath, { workerData: { userDataPath } });
      } catch (err) {
        verifierFailed('could not be spawned', describe(err));
        return;
      }

      const id = randomUUID();
      worker.on('message', (response: { id?: string; success?: boolean; data?: WorkerVerifyPayload; error?: string }) => {
        if (response?.id !== id) return;
        if (!response.success) {
          // The worker ran and answered: this verdict IS about the artifact.
          log?.('warn', '[Recovery] PGLite artifact did not open for verification', {
            dbPath,
            error: response.error,
          });
          finish(unreadable(response.error ?? 'verification request failed'));
          return;
        }
        finish(toRecoveryVerification(response.data ?? {}));
      });
      worker.on('error', (err) => verifierFailed('threw', describe(err)));
      worker.on('exit', (code) => verifierFailed('exited before answering', `exit code ${code}`));

      timer = setTimeout(
        () => verifierFailed('timed out', `no answer after ${timeoutMs}ms`),
        timeoutMs,
      );
      worker.postMessage({ id, type: 'verifyBackup', payload: { backupPath: dbPath } });
    });
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
