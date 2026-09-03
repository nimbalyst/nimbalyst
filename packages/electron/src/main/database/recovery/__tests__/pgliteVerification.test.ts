// @vitest-environment node
/**
 * The spawn contract for the PGLite verification worker.
 *
 * This is the test the last round did not have, and its absence cost the whole
 * feature. `createPgliteRecoveryVerifier` spawned `new Worker(workerPath)` with
 * no `workerData`; `worker.js` dereferences `workerData.userDataPath` in its
 * constructor, so the thread died with a `TypeError` before it read a byte of
 * anything. The `error` handler resolved `unreadable` and logged nothing, so
 * every PGLite artifact on every install assessed as `candidate_unreadable`,
 * Settings offered recovery to nobody, and the suite stayed green because
 * nothing anywhere asserted that the worker started.
 *
 * These drive real `worker_threads` workers -- three tiny scripts standing in
 * for the app's bundle, each reproducing one thing the real one does. Not the
 * bundle itself: `out/worker.bundle.js` is a build artifact that may not exist,
 * and opening a real PGLite store would cost seconds per case. What is being
 * asserted here is the message the parent sends and what it does with the four
 * ways a worker can fail to answer, and a script that echoes `workerData` back
 * proves that exactly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createPgliteRecoveryVerifier,
  isVerifierFailure,
} from '../pgliteVerification';
import type { RecoveryLogFn } from '../types';

let scriptDir: string;

/** Write a worker script and return its path. */
function script(name: string, body: string): string {
  const file = path.join(scriptDir, `${name}.cjs`);
  fs.writeFileSync(file, body, 'utf-8');
  return file;
}

beforeAll(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-pglite-verify-'));
});

afterAll(() => {
  fs.rmSync(scriptDir, { recursive: true, force: true });
});

function collectLogs(): { log: RecoveryLogFn; entries: Array<[string, string]> } {
  const entries: Array<[string, string]> = [];
  return { log: (level, msg) => { entries.push([level, msg]); }, entries };
}

describe('createPgliteRecoveryVerifier', () => {
  /**
   * The defect itself. `worker.js` reads `workerData.userDataPath` to build its
   * data directory, its lock file and its log directory; a spawn without it is
   * a worker that cannot start.
   */
  it('spawns the worker with the userDataPath it was given', async () => {
    const echo = script('echo-worker', `
      const { parentPort, workerData } = require('worker_threads');
      // Exactly what the real worker does with it, at the point it does it.
      const dataDir = require('path').join(workerData.userDataPath, 'pglite-db');
      parentPort.on('message', (msg) => {
        parentPort.postMessage({
          id: msg.id,
          success: true,
          data: {
            valid: true,
            sessionCount: dataDir.length,
            historyCount: 1,
            projectCount: 2,
            receivedType: msg.type,
            receivedPath: msg.payload.backupPath,
          },
        });
      });
    `);

    const verify = createPgliteRecoveryVerifier({
      workerPath: echo,
      userDataPath: '/somewhere/userData',
    });
    const result = await verify('/somewhere/userData/pglite-db.backup-x');

    // A worker that could compute its data directory is a worker that got the
    // root. Before the fix this call resolved `unreadable`.
    expect(result.valid).toBe(true);
    expect(result.indicators).toEqual({
      sessionCount: path.join('/somewhere/userData', 'pglite-db').length,
      documentHistoryCount: 1,
      projectCount: 2,
    });
  });

  /**
   * A successful verification must be silent about the verifier.
   *
   * `finish` terminates the worker, which fires `exit` with code 1 immediately
   * afterwards. An `exit` handler that logs before checking whether the promise
   * has already settled put "our own verifier failed" in `main.log` after every
   * successful verification -- observed in the E2E run, where a recovery that
   * worked end to end emitted seven of them. A diagnostic that cries wolf on
   * the happy path is worse than no diagnostic.
   */
  it('says nothing about verifier failure when the worker answered', async () => {
    const echo = script('quiet-worker', `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (msg) => {
        parentPort.postMessage({
          id: msg.id,
          success: true,
          data: { valid: true, sessionCount: 3, historyCount: 2, projectCount: 1 },
        });
      });
    `);
    const { log, entries } = collectLogs();

    const result = await createPgliteRecoveryVerifier({
      workerPath: echo,
      userDataPath: '/root',
      log,
    })('/root/pglite-db.backup-x');
    // The terminate-triggered `exit` lands after the promise resolves.
    await new Promise((r) => setTimeout(r, 50));

    expect(result.valid).toBe(true);
    expect(entries.filter(([level]) => level === 'error')).toEqual([]);
  });

  it('asks the worker to verify the path it was given', async () => {
    const echoRequest = script('echo-request', `
      const { parentPort, workerData } = require('worker_threads');
      parentPort.on('message', (msg) => {
        parentPort.postMessage({
          id: msg.id,
          success: false,
          error: JSON.stringify({ type: msg.type, path: msg.payload.backupPath, root: workerData.userDataPath }),
        });
      });
    `);

    const verify = createPgliteRecoveryVerifier({
      workerPath: echoRequest,
      userDataPath: '/root',
    });
    const result = await verify('/root/pglite-db.backup-y');

    expect(JSON.parse(result.error!)).toEqual({
      type: 'verifyBackup',
      path: '/root/pglite-db.backup-y',
      root: '/root',
    });
  });

  /**
   * The silence half of the defect. An `unreadable` verdict stops a recovery,
   * so a reader of `main.log` has to be able to tell "we could not read this
   * artifact" from "our verifier crashed". Both used to produce the same
   * verdict and neither produced a line.
   */
  it('marks and logs a verdict caused by the verifier dying, not by the artifact', async () => {
    const crashes = script('crashing-worker', `
      const { workerData } = require('worker_threads');
      // The pre-fix failure, reproduced: dereference the root at construction.
      const dataDir = workerData.userDataPath + '/pglite-db';
      module.exports = dataDir;
    `);
    const { log, entries } = collectLogs();

    // Deliberately spawned the old way, with the argument the fix added
    // omitted from the workerData the script sees.
    const verify = createPgliteRecoveryVerifier({
      workerPath: crashes,
      userDataPath: undefined as unknown as string,
      log,
    });
    const result = await verify('/root/pglite-db.backup-z');

    expect(result.integrity).toBe('unreadable');
    expect(isVerifierFailure(result)).toBe(true);
    const errors = entries.filter(([level]) => level === 'error').map(([, msg]) => msg);
    expect(errors.join('\n')).toContain('our own verifier failed');
  });

  /**
   * And the other side of that distinction: a worker that ran and reported the
   * artifact would not open is a verdict ABOUT the artifact. Recovery is right
   * to decline, and nothing should be pointing at the verifier.
   */
  it('does not mark an artifact the worker actually looked at as a verifier failure', async () => {
    const refuses = script('refusing-worker', `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', (msg) => {
        parentPort.postMessage({ id: msg.id, success: false, error: 'directory is not a PGLite store' });
      });
    `);

    const result = await createPgliteRecoveryVerifier({
      workerPath: refuses,
      userDataPath: '/root',
    })('/root/pglite-db.backup-z');

    expect(result.integrity).toBe('unreadable');
    expect(isVerifierFailure(result)).toBe(false);
    expect(result.error).toBe('directory is not a PGLite store');
  });

  it('fails closed, loudly, when the worker bundle is not there', async () => {
    const { log, entries } = collectLogs();
    const result = await createPgliteRecoveryVerifier({
      workerPath: path.join(scriptDir, 'does-not-exist.cjs'),
      userDataPath: '/root',
      log,
    })('/root/pglite-db.backup-z');

    expect(result.valid).toBe(false);
    expect(isVerifierFailure(result)).toBe(true);
    expect(entries.some(([level]) => level === 'error')).toBe(true);
  });

  it('gives up rather than hanging when the worker never answers', async () => {
    const silent = script('silent-worker', `
      const { parentPort } = require('worker_threads');
      parentPort.on('message', () => { /* deliberately no reply */ });
    `);

    const result = await createPgliteRecoveryVerifier({
      workerPath: silent,
      userDataPath: '/root',
      timeoutMs: 150,
    })('/root/pglite-db.backup-z');

    expect(isVerifierFailure(result)).toBe(true);
    expect(result.error).toContain('timed out');
  });
});
