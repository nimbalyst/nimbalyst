import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldExcludeKnownFailingSuites, buildVitestArgs, buildVitestEnv } from '../prepush-test-gate.mjs';

test('runs the full suite (no exclusions) outside local Windows', () => {
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'linux' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'darwin' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: 'true' }), false);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: '1' }), false);
});

test('excludes only the known-failing suites on local Windows', () => {
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32' }), true);
  assert.equal(shouldExcludeKnownFailingSuites({ platform: 'win32', ci: 'false' }), true);
});

test('buildVitestArgs adds no --exclude flags outside local Windows', () => {
  const args = buildVitestArgs({ platform: 'linux' });
  assert.deepEqual(args, ['vitest', '--run']);
});

test('buildVitestArgs caps worker concurrency on local Windows', () => {
  const args = buildVitestArgs({ platform: 'win32' });
  const idx = args.indexOf('--maxWorkers');
  assert.ok(idx >= 0, 'missing --maxWorkers flag');
  assert.equal(args[idx + 1], '4');
});

test('buildVitestArgs adds no --maxWorkers flag outside local Windows', () => {
  const args = buildVitestArgs({ platform: 'linux' });
  assert.equal(args.includes('--maxWorkers'), false);
});

test('buildVitestArgs never uses --exclude (vitest CLI --exclude does not reach test.projects file discovery)', () => {
  assert.equal(buildVitestArgs({ platform: 'win32' }).includes('--exclude'), false);
  assert.equal(buildVitestArgs({ platform: 'linux' }).includes('--exclude'), false);
});

test('buildVitestEnv sets NIMBALYST_PREPUSH_GATE on local Windows', () => {
  assert.equal(buildVitestEnv({ platform: 'win32' }).NIMBALYST_PREPUSH_GATE, '1');
});

test('buildVitestEnv sets nothing outside local Windows', () => {
  assert.deepEqual(buildVitestEnv({ platform: 'linux' }), {});
  assert.deepEqual(buildVitestEnv({ platform: 'win32', ci: 'true' }), {});
});
