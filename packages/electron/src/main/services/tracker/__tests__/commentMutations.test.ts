import { describe, it, expect } from 'vitest';
import { applyCommentMutation, type MutableComment } from '../commentMutations';
import type { TrackerIdentity } from '@nimbalyst/runtime';

/**
 * NIM-360: comment edit/delete must be limited to the author. These cover the
 * pure authorization + LWW-stamp logic the IPC handler delegates to.
 */

const alice: TrackerIdentity = {
  email: 'alice@example.com',
  displayName: 'Alice',
  gitName: 'alice',
  gitEmail: 'alice@git.example.com',
};
const bob: TrackerIdentity = {
  email: 'bob@example.com',
  displayName: 'Bob',
  gitName: 'bob',
  gitEmail: 'bob@git.example.com',
};

function seed(): MutableComment[] {
  return [
    { id: 'c1', authorIdentity: alice, body: 'hello', updatedAt: null, deleted: false },
    { id: 'c2', authorIdentity: bob, body: 'world', updatedAt: null, deleted: false },
  ];
}

describe('applyCommentMutation', () => {
  it('lets the author edit their own comment and stamps updatedAt', () => {
    const r = applyCommentMutation(seed(), 'c1', { kind: 'edit', body: 'hello edited' }, alice, 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c1 = r.comments.find((c) => c.id === 'c1')!;
    expect(c1.body).toBe('hello edited');
    expect(c1.updatedAt).toBe(1000);
  });

  it('lets the author soft-delete their own comment (body preserved)', () => {
    const r = applyCommentMutation(seed(), 'c2', { kind: 'delete' }, bob, 2000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c2 = r.comments.find((c) => c.id === 'c2')!;
    expect(c2.deleted).toBe(true);
    expect(c2.body).toBe('world'); // retained for audit
    expect(c2.updatedAt).toBe(2000);
  });

  it('rejects a non-author trying to edit', () => {
    const r = applyCommentMutation(seed(), 'c1', { kind: 'edit', body: 'tampered' }, bob, 1000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('forbidden');
  });

  it('rejects a non-author trying to delete', () => {
    const r = applyCommentMutation(seed(), 'c2', { kind: 'delete' }, alice, 1000);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('forbidden');
  });

  it('matches the author by gitEmail facet (different email facet captured)', () => {
    const aliceViaGit: TrackerIdentity = {
      email: null,
      displayName: 'Alice (laptop)',
      gitName: 'alice',
      gitEmail: 'alice@git.example.com',
    };
    const r = applyCommentMutation(seed(), 'c1', { kind: 'edit', body: 'x' }, aliceViaGit, 1);
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown comment id', () => {
    const r = applyCommentMutation(seed(), 'nope', { kind: 'delete' }, alice, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not-found');
  });

  it('rejects an empty edit body', () => {
    const r = applyCommentMutation(seed(), 'c1', { kind: 'edit', body: '   ' }, alice, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid');
  });

  it('does not mutate the input array', () => {
    const input = seed();
    applyCommentMutation(input, 'c1', { kind: 'edit', body: 'changed' }, alice, 1);
    expect(input[0].body).toBe('hello');
    expect(input[0].updatedAt).toBeNull();
  });

  it('denies when actor identity is missing (fails closed)', () => {
    const r = applyCommentMutation(seed(), 'c1', { kind: 'delete' }, null, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('forbidden');
  });
});
