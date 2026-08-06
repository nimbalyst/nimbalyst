import assert from 'node:assert/strict';
import test from 'node:test';
import { expandWorkspacePatterns, runPool, selectWorkspaces } from '../run-workspace-script.mjs';

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
