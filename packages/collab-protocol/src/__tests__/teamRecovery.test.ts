// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { planRecoveryIdentities } from '../teamRecovery';

it('reserves a referenced source key when the server item has no assigned identity', () => {
  const result = planRecoveryIdentities([{ id: 'item', issueKey: null, issueNumber: null, deleted: false }], [{ id: 'item', issueKey: 'NIM-8', issueNumber: 8 }]);
  expect(result.blockers).toEqual([]);
  expect(result.identities[0]?.issueKey).toBe('NIM-8');
});

describe('in-place recovery identity plan', () => {
  it('keeps both server-owned and never-uploaded referenced keys', () => {
    const plan = planRecoveryIdentities([{ id: 'old', issueKey: 'NIM-2', issueNumber: 2, deleted: false }], [
      { id: 'old', issueKey: 'NIM-2', issueNumber: 2 },
      { id: 'pending', issueKey: 'NIM-612', issueNumber: 612 },
    ]);
    expect(plan.blockers).toEqual([]);
    expect(plan.identities).toEqual([
      { id: 'old', issueKey: 'NIM-2', issueNumber: 2 },
      { id: 'pending', issueKey: 'NIM-612', issueNumber: 612 },
    ]);
    expect(plan.nextIssueNumber).toBe(613);
  });

  it('blocks differing ownership, missing source rows and duplicate local key claims', () => {
    const plan = planRecoveryIdentities([
      { id: 'server-only', issueKey: 'NIM-1', issueNumber: 1, deleted: false },
      { id: 'changed', issueKey: 'NIM-2', issueNumber: 2, deleted: false },
    ], [
      { id: 'changed', issueKey: 'NIM-3', issueNumber: 3 },
      { id: 'collision', issueKey: 'NIM-1', issueNumber: 1 },
    ]);
    expect(plan.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['missing-source', 'identity-conflict', 'duplicate-key']));
    expect(plan.identities).toEqual([]);
  });

  it('never imports a private local number or resurrects a server tombstone', () => {
    const plan = planRecoveryIdentities([{ id: 'deleted', issueKey: 'NIM-1', issueNumber: 1, deleted: true }], [
      { id: 'deleted', issueKey: 'NIM-1', issueNumber: 1 },
      { id: 'private', issueKey: 'STR.42', issueNumber: 42 },
    ]);
    expect(plan.blockers.map(b => b.code)).toEqual(expect.arrayContaining(['deleted-on-server', 'invalid-key']));
    expect(plan.identities).toEqual([]);
  });
});
