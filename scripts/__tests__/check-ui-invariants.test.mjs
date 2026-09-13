import assert from 'node:assert/strict';
import { test } from 'node:test';
import { undefinedTokens } from '../check-ui-invariants.mjs';
test('detects undefined references, ignores comments, and refuses missing definitions', () => {
  assert.deepEqual(undefinedTokens('var(--nim-typo) var( --nim-primary) /* var(--nim-comment) */', ':root { --nim-primary: red; }'), ['--nim-typo']);
  assert.throws(() => undefinedTokens('var(--nim-primary)', ''), /No canonical/);
});
