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

// Loading the module is not enough: a pty.node built for the wrong ABI or
// missing its spawn helper only fails when a terminal child actually starts.
const marker = 'nimbalyst-pty-ok';
const [shell, args] = process.platform === 'win32'
  ? [process.env.ComSpec || 'cmd.exe', ['/d', '/c', `echo ${marker}`]]
  : ['/bin/sh', ['-c', `echo ${marker}`]];
const child = pty.spawn(shell, args, { name: 'xterm', cols: 80, rows: 24, cwd: process.cwd(), env: process.env });
let output = '';
child.onData((data) => {
  output += data;
});
const timeout = setTimeout(() => {
  console.error(`node-pty child did not exit within 10s. Output so far: ${JSON.stringify(output)}`);
  process.exit(1);
}, 10000);
child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  assert.strictEqual(exitCode, 0, `node-pty child exited with ${exitCode}`);
  assert.ok(output.includes(marker), `node-pty child output did not include the marker: ${JSON.stringify(output)}`);
  console.log(
    `Native runtime verified: Electron ${process.versions.electron}, Node ${process.versions.node}, ABI ${process.versions.modules}, SQLite query and PTY child OK`,
  );
});
