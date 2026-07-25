import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { findMainBundleGraphViolations } from '../main-bundle-graph-policy.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-main-bundle-graph.mjs',
);
const missingMap = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/does-not-exist.map',
);

test('strict bundle graph validation fails when no main sourcemap exists', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--map', missingMap], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /no main sourcemap/i);
});

test('warning-only bundle graph validation may skip a missing sourcemap', () => {
  const result = spawnSync(process.execPath, [scriptPath, '--warn', '--map', missingMap], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no main sourcemap/i);
});

test('shared policy detects renderer and Lexical modules in the main graph', () => {
  const violations = findMainBundleGraphViolations([
    '/repo/packages/electron/src/main/index.ts',
    '/repo/packages/electron/src/renderer/App.tsx?commonjs-proxy',
    '/repo/node_modules/@lexical/yjs/LexicalYjs.mjs',
  ]);

  assert.deepEqual(
    violations.map(({ name }) => name),
    ['@lexical/*', '.tsx modules', 'renderer/ files'],
  );
});
