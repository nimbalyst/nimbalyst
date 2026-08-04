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
  assert.match(result.stdout, /core\/docs graph clean/);
});

test('derives future headless domains from package exports and excludes UI entries', () => {
  const entries = deriveCollabClientHeadlessEntryPoints({
    './core': { default: './src/core/index.ts' },
    './docs': { default: './src/docs/index.ts' },
    './docs-ui': { default: './src/docs-ui/index.ts' },
    './trackers': { default: './src/trackers/index.ts' },
    './trackers-ui': { default: './src/trackers-ui/index.ts' },
  }, '/repo/packages/collab-client');

  assert.deepEqual(entries, {
    core: '/repo/packages/collab-client/src/core/index.ts',
    docs: '/repo/packages/collab-client/src/docs/index.ts',
    trackers: '/repo/packages/collab-client/src/trackers/index.ts',
  });
});
