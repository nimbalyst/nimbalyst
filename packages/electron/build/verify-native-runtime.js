#!/usr/bin/env node

/**
 * Proves that the installed native modules load in the pinned Electron
 * runtime. Run this after install-app-deps and before packaging/release.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');

if (!process.versions.electron) {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const electronPackage = require('../package.json');
assert.strictEqual(
  process.versions.electron,
  electronPackage.build.electronVersion,
  'The running Electron version does not match build.electronVersion',
);

const Database = require('better-sqlite3');
const db = new Database(':memory:');
const row = db.prepare('SELECT 1 AS value').get();
db.close();
assert.deepStrictEqual(row, { value: 1 });

const pty = require('node-pty');
assert.strictEqual(typeof pty.spawn, 'function', 'node-pty did not expose spawn()');

console.log(
  `Native runtime verified: Electron ${process.versions.electron}, Node ${process.versions.node}, ABI ${process.versions.modules}`,
);
