// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';

it('terminates an active SQLite worker without aborting its parent process', () => {
  // Native assertions abort the entire process, so keep the database and its
  // worker inside a disposable subprocess rather than the Vitest worker.
  const source = path.resolve(__dirname, '../SQLiteDatabase.ts');
  const schemaDir = path.resolve(__dirname, '../schemas');
  const sqliteModule = require.resolve('better-sqlite3');
  const bundle = buildSync({
    entryPoints: [source], bundle: true, write: false, platform: 'node',
    format: 'cjs', external: ['better-sqlite3'],
  }).outputFiles[0].text;
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const normalRequire = require;
    require = (id) => normalRequire(id === 'better-sqlite3' ? ${JSON.stringify(sqliteModule)} : id);
    ${bundle}
    const db = new module.exports.SQLiteDatabase({
      dbDir: workerData.dbDir, schemaDir: ${JSON.stringify(schemaDir)}, sampleRate: 0,
    });
    db.initialize().then(() => {
      parentPort.postMessage('ready');
      parentPort.once('message', () => {
        parentPort.postMessage('started');
        // Exercise the production-owned handle while termination interrupts
        // native object creation (the upstream worker termination failure).
        for (let i = 0; i < 1_000_000; i++) db.getRawHandle().pragma('busy_timeout = 5000');
      });
    });
  `;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'nim-worker-termination-'));
  const script = `
    const { Worker } = require('node:worker_threads');
    const { once } = require('node:events');
    const path = require('node:path');
    (async () => {
      const temp = ${JSON.stringify(temp)};
      for (let i = 0; i < 100; i++) {
        const worker = new Worker(${JSON.stringify(workerCode)}, {
          eval: true, workerData: { dbDir: path.join(temp, String(i)) },
        });
        await once(worker, 'message');
        const started = once(worker, 'message'); worker.postMessage('start'); await started;
        await worker.terminate();
      }
      console.log('completed 100 active-worker terminations');
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  try {
    // ~15s alone; 100 fresh databases ran past 25s under a loaded full suite. The
    // bound only stops a hung child, so it is generous rather than tight.
    const result = spawnSync(process.execPath, ['-e', script], {
      timeout: 75_000, encoding: 'utf8', maxBuffer: 1024 * 1024,
      env: { ...process.env, NIMBALYST_BETTER_SQLITE3_NATIVE: '' },
    });
    expect({ status: result.status, signal: result.signal, error: result.error?.message }, result.stderr)
      .toEqual({ status: 0, signal: null, error: undefined });
    expect(result.stdout).toContain('completed 100 active-worker terminations');
  } finally {
    // The child cannot clean up after SIGABRT; the surviving test process can.
    rmSync(temp, { recursive: true, force: true });
  }
}, 90_000);
