import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyChanges, fullSuiteArgs, isFullSuiteInvocation, tasks } from '../validation-inventory.mjs';

test('full-suite identity matches the actual package script and rejects partial runs', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:prepush'], `vitest ${fullSuiteArgs.join(' ')}`);
  assert.equal(isFullSuiteInvocation([...fullSuiteArgs, 'one.test.ts']), false);
  assert.equal(isFullSuiteInvocation([...fullSuiteArgs, '--shard=1/2']), false);
});
test('the pre-push typecheck and the CI bundle step still enforce the collab bundle budgets', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../packages/collab-bundle/package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['check:bundle'], /pnpm run build && .*check-collab-bundle\.mjs/);
  const runsBundleCheck = steps => steps.some(step => step.includes('@nimbalyst/collab-bundle') && step.at(-1) === 'check:bundle');
  assert.ok(runsBundleCheck(tasks.typecheck), 'typecheck:prepush must build the bundle before vitest');
  assert.ok(runsBundleCheck(tasks['bundle-build']), 'CI bundle-build must check the budgets');
  assert.ok(tasks['unit-build'].some(step => step.at(-1) === 'check:bundle'));
});
test('unknown, shared, fixture, and config inputs retain full coverage', () => {
  assert.deepEqual(classifyChanges(['README.md']), { docsOnly: true, sandbox: false });
  assert.deepEqual(classifyChanges(['packages/electron/src/renderer/App.tsx']), { docsOnly: false, sandbox: false });
  for (const files of [[], ['README.md', 'pnpm-lock.yaml'], ['packages/runtime/src/x.ts'], ['packages/collab-protocol/src/x.ts'], ['packages/cloudflare-sandbox/release.json'], ['scripts/x.mjs'], ['.github/workflows/ci.yml'], ['packages/runtime/fixtures/input.md'], ['docs/POSTHOG_EVENTS.md'], ['.claude/commands/implement.md']]) assert.deepEqual(classifyChanges(files), { docsOnly: false, sandbox: true });
});
