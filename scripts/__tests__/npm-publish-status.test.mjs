// The release decision behind /publish-npm: what to do given local and npm versions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide } from '../npm-publish-status.mjs';

test('a group publishes only when it changed, and never with mismatched or older versions', () => {
  assert.equal(decide({ localVersions: ['0.1.0', '0.1.0'], published: '0.1.0', changed: false }).status, 'up to date');
  assert.equal(decide({ localVersions: ['0.1.0', '0.1.0'], published: '0.1.0', changed: true }).status, 'bump+publish');
  assert.equal(decide({ localVersions: ['0.1.1', '0.1.1'], published: '0.1.0', changed: true }).status, 'publish (already bumped)');
  // Numeric, not lexical: 0.10.0 is newer than 0.9.0.
  assert.equal(decide({ localVersions: ['0.10.0'], published: '0.9.0', changed: false }).status, 'publish (already bumped)');
  assert.equal(decide({ localVersions: ['0.1.0'], published: '0.2.0', changed: true }).status, 'LOCAL BEHIND NPM');
  assert.equal(decide({ localVersions: ['0.1.1', '0.1.0'], published: '0.1.0', changed: true }).status, 'VERSIONS DIFFER');
  assert.equal(decide({ localVersions: ['0.1.0'], published: null, changed: true }).status, 'never published');
});
