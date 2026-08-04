import assert from 'node:assert/strict';
import test from 'node:test';
import { findToolchainProblems, minimumMajor } from '../check-toolchain.mjs';

const engines = { node: '>=24', npm: '>=11' };

test('reports each engine the running toolchain is too old for', () => {
  assert.deepEqual(findToolchainProblems({ engines, node: 'v22.18.0', npm: '10.9.3' }), [
    'node v22.18.0 is older than the required >=24',
    'npm 10.9.3 is older than the required >=11',
  ]);
  assert.deepEqual(findToolchainProblems({ engines, node: 'v24.18.0', npm: '10.9.3' }), [
    'npm 10.9.3 is older than the required >=11',
  ]);
});

test('passes newer toolchains and defers ranges npm must judge', () => {
  assert.deepEqual(findToolchainProblems({ engines, node: 'v26.5.0', npm: '11.17.0' }), []);
  // Unknown npm version (hook could not run `npm -v`) must not fail the push.
  assert.deepEqual(findToolchainProblems({ engines, node: 'v24.18.0' }), []);
  assert.deepEqual(findToolchainProblems({ engines: { node: '^22 || ^24' }, node: 'v18.0.0' }), []);
  assert.equal(minimumMajor('^22 || ^24'), null);
});
