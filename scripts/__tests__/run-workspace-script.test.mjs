import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  expandWorkspacePatterns,
  npmSpawnConfig,
  runPool,
  runScriptIn,
  selectWorkspaces,
} from '../run-workspace-script.mjs';
import { resolvePrepushBase } from '../resolve-prepush-base.mjs';

test('checks fork pushes against canonical upstream main', () => {
  const calls = [];
  const base = resolvePrepushBase((...args) => {
    calls.push(args);
    if (args.at(-1) === 'upstream/main') return 'stable-base\n';
    throw new Error('unexpected fallback');
  });
  assert.equal(base, 'stable-base');
  assert.deepEqual(calls, [['merge-base', 'HEAD', 'upstream/main']]);
});

test('falls back to origin main when upstream is not configured', () => {
  const base = resolvePrepushBase((...args) => {
    if (args.at(-1) === 'upstream/main') throw new Error('unknown revision');
    if (args.at(-1) === 'origin/main') return 'fork-base\n';
    throw new Error('unexpected fallback');
  });
  assert.equal(base, 'fork-base');
});

test('launches the Windows npm shim through cmd.exe', () => {
  assert.deepEqual(npmSpawnConfig('win32', { ComSpec: 'C:\\Windows\\cmd.exe' }), {
    command: 'C:\\Windows\\cmd.exe',
    argsPrefix: ['/d', '/s', '/c', 'npm.cmd'],
  });
  assert.deepEqual(npmSpawnConfig('linux'), { command: 'npm', argsPrefix: [] });
});

test('runs an npm script in a workspace', async t => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'run-workspace-script-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'fixture'));
  await writeFile(
    path.join(rootDir, 'fixture', 'package.json'),
    JSON.stringify({ scripts: { probe: 'node -e "process.stdout.write(\'launched\')"' } }),
  );

  const result = await runScriptIn('fixture', 'probe', rootDir);

  assert.equal(result.code, 0);
  assert.match(result.output, /launched/);
});

test('expands the trailing-star pattern and rejects shapes it cannot match', () => {
  const readDir = parent => (parent === 'packages/extensions' ? ['git', 'math'] : []);
  assert.deepEqual(
    expandWorkspacePatterns(['packages/electron', 'packages/extensions/*'], readDir),
    ['packages/electron', 'packages/extensions/git', 'packages/extensions/math'],
  );
  // A silently-unmatched pattern would drop packages from the pre-push gate.
  assert.throws(() => expandWorkspacePatterns(['packages/*/src'], readDir), /Unsupported/);
});

test('keeps only workspaces defining the script', () => {
  const manifests = {
    'packages/electron': { scripts: { typecheck: 'tsc --noEmit' } },
    'packages/ios': { scripts: { build: 'xcodebuild' } },
    'packages/gone': null,
  };
  assert.deepEqual(
    selectWorkspaces(Object.keys(manifests), 'typecheck', dir => manifests[dir]),
    ['packages/electron'],
  );
});

test('pool runs every item, respects the limit, and preserves input order', async () => {
  let running = 0;
  let peak = 0;
  const results = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async value => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setTimeout(resolve, value % 3));
    running--;
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(peak, 3);
});
