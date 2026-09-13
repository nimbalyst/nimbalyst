import assert from 'node:assert/strict';
import test from 'node:test';
import { pushDeliversNewCommits, shouldRunFullPrePushSuite } from '../prepush-test-gate.mjs';

test('keeps the full suite enabled outside local Windows', () => {
  assert.equal(shouldRunFullPrePushSuite({ platform: 'linux' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'darwin' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: 'true' }), true);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: '1' }), true);
});

test('skips only the known nonportable suite on local Windows', () => {
  // Model a local shell explicitly, even when this test runs under CI=true.
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: '' }), false);
  assert.equal(shouldRunFullPrePushSuite({ platform: 'win32', ci: 'false' }), false);
});

const BRANCH_PUSH = 'refs/heads/main abc123 refs/heads/main def456\n';
const TAG_PUSH = `refs/tags/v0.75.1 abc123 refs/tags/v0.75.1 ${'0'.repeat(40)}\n`;

test('gates a push that delivers commits the remote lacks', () => {
  const calls = [];
  const git = (...args) => {
    calls.push(args);
    return '7\n';
  };
  assert.equal(pushDeliversNewCommits({ stdin: BRANCH_PUSH, remote: 'origin', git }), true);
  assert.deepEqual(calls, [['rev-list', '--count', 'abc123', '--not', '--remotes=origin']]);
});

test('skips the release tag push, whose commit the branch push already delivered', () => {
  const git = () => '0\n';
  assert.equal(pushDeliversNewCommits({ stdin: TAG_PUSH, remote: 'origin', git }), false);
});

test('never waves a push through on missing refs or a failing git', () => {
  const git = () => '0\n';
  // Hook run by hand with no stdin, so we cannot tell what is being pushed.
  assert.equal(pushDeliversNewCommits({ stdin: '', git }), true);
  assert.equal(
    pushDeliversNewCommits({
      stdin: BRANCH_PUSH,
      git: () => {
        throw new Error('not a git repository');
      },
    }),
    true
  );
  // A branch deletion carries no commits, so there is nothing left to gate.
  assert.equal(
    pushDeliversNewCommits({ stdin: `refs/heads/old ${'0'.repeat(40)} refs/heads/old abc123\n`, git }),
    false
  );
});

import { fullSuiteReuseDecision } from '../prepush-test-gate.mjs';
import { fullSuiteInvocation } from '../validation-inventory.mjs';

test('reuses only complete passing matching HEAD results; all uncertainty runs the suite', () => {
  const sha = 'a'.repeat(40);
  const good = {
    record: { invocation: fullSuiteInvocation, complete: true, result: 'PASS' },
    comparison: { verdict: 'current', now: { head: sha, files: [], extras: [] } },
    stdin: `refs/heads/main ${sha} refs/heads/main ${'b'.repeat(40)}`,
    git: () => sha,
    ci: 'false',
  };
  assert.equal(fullSuiteReuseDecision(good).reuse, true);
  // A dirty tree whose content the run fingerprinted is the tree that passed;
  // parallel sessions keep the checkout permanently dirty, so this is the
  // common case, not an edge.
  assert.equal(
    fullSuiteReuseDecision({ ...good, comparison: { ...good.comparison, now: { ...good.comparison.now, files: [{ path: 'dirty.ts' }] } } }).reuse,
    true,
  );
  for (const overrides of [
    { record: null },
    { record: { ...good.record, invocation: 'run one.test.ts' } },
    { record: { ...good.record, complete: false } },
    { record: { ...good.record, result: 'FAIL' } },
    { comparison: { verdict: 'stale' } },
    { comparison: { verdict: 'unknown' } },
    { stdin: '' }, { stdin: 'malformed' }, { git: () => 'b'.repeat(40) },
    { git: () => { throw new Error('unavailable'); } }, { ci: 'true' },
  ]) assert.equal(fullSuiteReuseDecision({ ...good, ...overrides }).reuse, false, JSON.stringify(overrides));
  assert.equal(fullSuiteReuseDecision({ ...good, stdin: `${good.stdin}\nrefs/tags/v1 ${'c'.repeat(40)} refs/tags/v1 ${'0'.repeat(40)}` }).reuse, true);
});
