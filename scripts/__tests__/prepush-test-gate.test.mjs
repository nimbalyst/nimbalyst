import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRunFullPrePushSuite } from '../prepush-test-gate.mjs';

test('keeps the full suite enabled on every supported platform', () => {
  assert.equal(shouldRunFullPrePushSuite({ platform: 'linux' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'darwin' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: 'true' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: '1' }), true);
});

test('does not accept a local Windows bypass', () => {
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: 'false' }), true);
});
