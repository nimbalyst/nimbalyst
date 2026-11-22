// @vitest-environment node
import { expect, it } from 'vitest';
import { isGitLockFailure, noCommitNote } from '../commitOutcomeCheck';

it('recognizes both lock failures the commit path reports', () => {
  expect(isGitLockFailure(`Git operation 'git:commit' timed out waiting for lock on /repo`)).toBe(true);
  expect(isGitLockFailure('Repository is locked by another git process: .git/index.lock could not be acquired after 6 attempts.')).toBe(true);
  expect(isGitLockFailure('pre-commit hook failed')).toBe(false);
  expect(isGitLockFailure(undefined)).toBe(false);
});

it('says plainly that this call made no commit, and only offers a retry when that is safe', () => {
  const none = { kind: 'not-committed' } as const;
  expect(noCommitNote(none, { retryable: true })).toMatch(/No commit was made by this call.*safe to retry/);
  expect(noCommitNote(none, { retryable: false })).not.toMatch(/retry/);
  expect(noCommitNote({ kind: 'unreadable', reason: 'ENOSPC' }, { retryable: true })).toMatch(/Could not read.*ENOSPC.*git log/);
});
