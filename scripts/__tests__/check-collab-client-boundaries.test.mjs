import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveCollabClientHeadlessEntryPoints,
  findCollabClientBoundaryViolations,
} from '../check-collab-client-boundaries.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-collab-client-boundaries.mjs',
);

test('classifies every forbidden headless dependency', () => {
  const violations = findCollabClientBoundaryViolations([
    'node:fs',
    'node_modules/react-dom/client.js',
    '/repo/packages/extension-sdk/src/index.ts',
    '/repo/packages/electron/src/renderer/App.tsx',
  ]);

  assert.deepEqual(
    violations.map(({ name }) => name),
    ['react-dom', '@nimbalyst/extension-sdk', 'Electron', 'node:*'],
  );
});

test('current core and docs entry graphs satisfy the boundary', () => {
  const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The label lists every headless export, so it grows as new domains are added.
  const summary = result.stdout.match(
    /^\[collab-client-boundaries\] (\S+) graph clean \(\d+ modules\)\.$/m,
  );
  assert.ok(summary, `unexpected summary line: ${result.stdout}`);
  const checkedEntries = summary[1].split('/');
  assert.ok(checkedEntries.includes('core'), summary[1]);
  assert.ok(checkedEntries.includes('docs'), summary[1]);
});

test('derives future headless domains from package exports and excludes UI entries', () => {
  const entries = deriveCollabClientHeadlessEntryPoints({
    './core': { default: './src/core/index.ts' },
    './docs': { default: './src/docs/index.ts' },
    './docs-ui': { default: './src/docs-ui/index.ts' },
    './trackers': { default: './src/trackers/index.ts' },
    './trackers-ui': { default: './src/trackers-ui/index.ts' },
  }, '/repo/packages/collab-client');

  // Compare relative to the synthetic root, normalized to POSIX separators,
  // rather than the absolute paths directly -- path.* resolves a leading
  // '/' as drive-relative on Windows (e.g. D:\repo\...), so a hardcoded
  // POSIX-absolute expected value only ever matched on POSIX CI. This keeps
  // the real assertions (which domains are derived, -ui entries excluded)
  // platform-agnostic without touching the implementation under test.
  const rel = Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [key, path.relative('/repo/packages/collab-client', value).split(path.sep).join('/')]),
  );
  assert.deepEqual(rel, {
    core: 'src/core/index.ts',
    docs: 'src/docs/index.ts',
    trackers: 'src/trackers/index.ts',
  });
});
