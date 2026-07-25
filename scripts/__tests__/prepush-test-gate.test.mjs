import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRunFullPrePushSuite } from '../prepush-test-gate.mjs';

test('keeps the full suite enabled outside local Windows', () => {
  assert.equal(shouldRunFullPrePushSuite({ platform: 'linux' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'darwin' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: 'true' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: '1' }), true);
});

test('skips only the known nonportable suite on local Windows', () => {
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32' }), false);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: 'false' }), false);
});
