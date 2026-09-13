import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classifyChanges, fullSuiteArgs, isFullSuiteInvocation } from '../validation-inventory.mjs';

test('full-suite identity matches the actual npm command and rejects partial runs', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:prepush'], `vitest ${fullSuiteArgs.join(' ')}`);
  assert.equal(isFullSuiteInvocation([...fullSuiteArgs, 'one.test.ts']), false);
  assert.equal(isFullSuiteInvocation([...fullSuiteArgs, '--shard=1/2']), false);
});
test('unknown, shared, fixture, and config inputs retain full coverage', () => {
  assert.deepEqual(classifyChanges(['README.md']), { docsOnly: true, sandbox: false });
  assert.deepEqual(classifyChanges(['packages/electron/src/renderer/App.tsx']), { docsOnly: false, sandbox: false });
  for (const files of [[], ['README.md', 'package-lock.json'], ['packages/runtime/src/x.ts'], ['packages/collab-protocol/src/x.ts'], ['packages/cloudflare-sandbox/release.json'], ['scripts/x.mjs'], ['.github/workflows/ci.yml'], ['packages/runtime/fixtures/input.md'], ['docs/POSTHOG_EVENTS.md'], ['.claude/commands/implement.md']]) assert.deepEqual(classifyChanges(files), { docsOnly: false, sandbox: true });
});
