import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildVitestArgs,
  buildVitestEnv,
  shouldExcludeKnownFailingSuites,
} from '../prepush-test-gate.mjs';
import { WINDOWS_KNOWN_FAILING_SUITES } from '../windows-known-failing-suites.mjs';

test('keeps the full suite enabled outside local Windows', () => {
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'linux' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'darwin' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: 'true' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: '1' }), false);
});

test('excludes only the tracked nonportable suites on local Windows', () => {
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32' }), true);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: 'false' }), true);
});

test('uses the ordinary full-suite invocation outside local Windows', () => {
  assert.deepEqual(buildVitestArgs({ platform: 'linux' }), ['vitest', '--run']);
  assert.deepEqual(
    buildVitestEnv(
      { platform: 'linux' },
      { KEEP_ME: 'yes', NIMBALYST_PREPUSH_GATE: '1' },
    ),
    { KEEP_ME: 'yes' },
  );
  assert.deepEqual(
    buildVitestEnv(
      { platform: 'win32', ci: 'true' },
      { KEEP_ME: 'yes', NIMBALYST_PREPUSH_GATE: '1' },
    ),
    { KEEP_ME: 'yes' },
  );
});

test('caps workers and activates config exclusions only on local Windows', () => {
  assert.deepEqual(buildVitestArgs({ platform: 'win32' }), [
    'vitest',
    '--run',
    '--maxWorkers',
    '4',
  ]);
  assert.deepEqual(
    buildVitestEnv({ platform: 'win32' }, { KEEP_ME: 'yes' }),
    { KEEP_ME: 'yes', NIMBALYST_PREPUSH_GATE: '1' },
  );
});

test('never relies on a top-level --exclude flag with project-based config', () => {
  assert.equal(buildVitestArgs({ platform: 'win32' }).includes('--exclude'), false);
  assert.equal(buildVitestArgs({ platform: 'linux' }).includes('--exclude'), false);
});

test('keeps the exclusion manifest explicit, unique, and current', () => {
  const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
  assert.equal(WINDOWS_KNOWN_FAILING_SUITES.length, 17);
  assert.equal(new Set(WINDOWS_KNOWN_FAILING_SUITES).size, 17);
  assert.equal(
    WINDOWS_KNOWN_FAILING_SUITES.includes(
      'packages/electron/src/main/utils/__tests__/aiSettingsMerge.test.ts',
    ),
    false,
  );
  for (const suitePath of WINDOWS_KNOWN_FAILING_SUITES) {
    assert.match(suitePath, /^packages\/.+\.test\.(?:ts|tsx)$/);
    assert.equal(
      existsSync(path.join(repositoryRoot, suitePath)),
      true,
      `missing exclusion path: ${suitePath}`,
    );
  }
});
