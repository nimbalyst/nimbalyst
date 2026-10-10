import assert from 'node:assert/strict';
import test from 'node:test';
import { findToolchainProblems, minimumMajor } from '../check-toolchain.mjs';

const engines = { node: '>=24', pnpm: '>=12' };

test('reports each engine the running toolchain is too old for', () => {
  assert.deepEqual(findToolchainProblems({ engines, node: 'v22.18.0', pnpm: '10.17.1' }), [
    'node v22.18.0 is older than the required >=24',
    'pnpm 10.17.1 is older than the required >=12',
  ]);
  assert.deepEqual(findToolchainProblems({ engines, node: 'v24.18.0', pnpm: '10.17.1' }), [
    'pnpm 10.17.1 is older than the required >=12',
  ]);
});

test('passes newer toolchains and defers ranges pnpm must judge', () => {
  assert.deepEqual(findToolchainProblems({ engines, node: 'v26.5.0', pnpm: '12.9.1' }), []);
  // Unknown pnpm version (hook could not run `pnpm -v`) must not fail the push.
  assert.deepEqual(findToolchainProblems({ engines, node: 'v24.18.0' }), []);
  assert.deepEqual(findToolchainProblems({ engines: { node: '^22 || ^24' }, node: 'v18.0.0' }), []);
  assert.equal(minimumMajor('^22 || ^24'), null);
});
