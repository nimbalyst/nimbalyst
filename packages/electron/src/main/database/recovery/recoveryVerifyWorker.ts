/**
 * Recovery verification worker.
 *
 * Runs one full `verifyRecoveryTargetFile` against one database, posts the
 * result, and exits. It exists so a `PRAGMA integrity_check` over a multi-GB
 * store never runs on the main thread or on the thread serving `query`
 * requests — see recoveryVerification.ts for the incident that motivated it.
 *
 * Bundled as `sqlite-recovery-verify-worker.bundle.js` alongside the other
 * worker bundles.
 */

import { parentPort, workerData } from 'worker_threads';
import { verifyRecoveryTargetFile } from './recoveryVerification';

if (!parentPort) {
  throw new Error('recoveryVerifyWorker must run as a worker_threads Worker');
}

const { dbPath } = (workerData ?? {}) as { dbPath?: string };
if (!dbPath) {
  parentPort.postMessage({
    valid: false,
    integrity: 'unreadable',
    requiredSchemaPresent: false,
    indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
    error: 'recoveryVerifyWorker requires a dbPath',
  });
} else {
  parentPort.postMessage(verifyRecoveryTargetFile(dbPath));
}
