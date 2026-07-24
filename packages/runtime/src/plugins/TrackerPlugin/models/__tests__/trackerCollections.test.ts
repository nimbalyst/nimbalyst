import { describe, it, expect, beforeAll } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { loadBuiltinTrackers } from '../ModelLoader';
import { getRecordStatus } from '../../trackerRecordAccessors';
import {
  isCollectionType,
  getMembersField,
  getCollectionField,
  getMemberIds,
  addMembersValue,
  removeMembersValue,
  computeCollectionRollup,
  computeCollectionRollups,
  isTerminalStatus,
  COLLECTION_MEMBER_KEY,
  COLLECTION_INVERSE_KEY,
} from '../trackerCollections';

beforeAll(() => {
  loadBuiltinTrackers();
});

function record(
  id: string,
  primaryType: string,
  fields: Record<string, unknown> = {},
): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    issueKey: `${primaryType.toUpperCase()}-${id}`,
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/w', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' },
    fields: { title: `Item ${id}`, ...fields },
  } as TrackerRecord;
}

describe('collection type detection', () => {
  it('recognizes the built-in collection types', () => {
    expect(isCollectionType('milestone')).toBe(true);
    expect(isCollectionType('release')).toBe(true);
  });

  it('does not treat ordinary work types as collections', () => {
    expect(isCollectionType('bug')).toBe(false);
    expect(isCollectionType('task')).toBe(false);
  });

  it('exposes the members field on collections and the inverse on members', () => {
    const members = getMembersField('milestone');
    expect(members?.name).toBe('items');
    expect(members?.relationshipTypeKey).toBe(COLLECTION_MEMBER_KEY);
    expect(members?.multiValue).toBe(true);

    const collection = getCollectionField('bug');
    expect(collection?.name).toBe('collection');
    expect(collection?.relationshipTypeKey).toBe(COLLECTION_INVERSE_KEY);
  });

  it('wires the two sides to each other by inverse field id', () => {
    expect(getMembersField('milestone')?.inverseFieldId).toBe('collection');
    expect(getCollectionField('bug')?.inverseFieldId).toBe('items');
  });
});

describe('membership writes', () => {
  it('adds members with denormalized display data', () => {
    const milestone = record('m1', 'milestone');
    const value = addMembersValue(milestone, [record('b1', 'bug', { title: 'Crash on save' })]);

    expect(value).toHaveLength(1);
    expect(value[0]).toMatchObject({
      itemId: 'b1',
      title: 'Crash on save',
      trackerType: 'bug',
      relationshipTypeKey: COLLECTION_MEMBER_KEY,
    });
  });

  it('preserves existing members and collapses duplicates', () => {
    const milestone = record('m1', 'milestone', { items: [{ itemId: 'b1' }] });
    const value = addMembersValue(milestone, [record('b1', 'bug'), record('b2', 'bug')]);
    expect(value.map(v => v.itemId).sort()).toEqual(['b1', 'b2']);
  });

  it('refuses to make a collection its own member', () => {
    const milestone = record('m1', 'milestone');
    expect(addMembersValue(milestone, [milestone])).toEqual([]);
  });

  it('removes only the named members', () => {
    const milestone = record('m1', 'milestone', {
      items: [{ itemId: 'b1' }, { itemId: 'b2' }, { itemId: 'b3' }],
    });
    expect(removeMembersValue(milestone, ['b2']).map(v => v.itemId)).toEqual(['b1', 'b3']);
  });

  it('reads member ids back off a collection', () => {
    const milestone = record('m1', 'milestone', { items: [{ itemId: 'b1' }, { itemId: 'b2' }] });
    expect(getMemberIds(milestone)).toEqual(['b1', 'b2']);
  });
});

describe('rollups', () => {
  const index = (items: TrackerRecord[]) => new Map(items.map(i => [i.id, i]));

  it('counts members by status and computes progress', () => {
    const members = [
      record('b1', 'bug', { status: 'done' }),
      record('b2', 'bug', { status: 'done' }),
      record('b3', 'bug', { status: 'in-progress' }),
      record('b4', 'bug', { status: 'to-do' }),
    ];
    const milestone = record('m1', 'milestone', {
      items: members.map(m => ({ itemId: m.id })),
    });

    const rollup = computeCollectionRollup(milestone, index(members), getRecordStatus);
    expect(rollup.total).toBe(4);
    expect(rollup.resolved).toBe(4);
    expect(rollup.done).toBe(2);
    expect(rollup.percentComplete).toBe(50);
    expect(rollup.byStatus).toEqual({ done: 2, 'in-progress': 1, 'to-do': 1 });
  });

  it('never counts unresolved members toward progress', () => {
    const loaded = [record('b1', 'bug', { status: 'done' })];
    const milestone = record('m1', 'milestone', {
      items: [{ itemId: 'b1' }, { itemId: 'missing' }],
    });

    const rollup = computeCollectionRollup(milestone, index(loaded), getRecordStatus);
    expect(rollup.total).toBe(2);
    expect(rollup.resolved).toBe(1);
    // Only the resolved member is in the math -- an unloaded member must not
    // make an incomplete milestone report 100%.
    expect(rollup.percentComplete).toBe(100);
    expect(rollup.done).toBe(1);
  });

  it('reports zero progress for an empty collection instead of dividing by zero', () => {
    const rollup = computeCollectionRollup(record('m1', 'milestone'), index([]), getRecordStatus);
    expect(rollup).toMatchObject({ total: 0, resolved: 0, done: 0, percentComplete: 0 });
  });

  it('treats released and cancelled as terminal alongside done', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('released')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('in-progress')).toBe(false);
  });

  it('indexes items once when rolling up many collections', () => {
    const members = [record('b1', 'bug', { status: 'done' }), record('b2', 'bug', { status: 'to-do' })];
    const collections = [
      record('m1', 'milestone', { items: [{ itemId: 'b1' }] }),
      record('m2', 'milestone', { items: [{ itemId: 'b1' }, { itemId: 'b2' }] }),
    ];

    const rollups = computeCollectionRollups(collections, members, getRecordStatus);
    expect(rollups.get('m1')?.percentComplete).toBe(100);
    expect(rollups.get('m2')?.percentComplete).toBe(50);
  });

  it('scales linearly with member count rather than per-member lookups', () => {
    // Guards the N+1 shape: a 500-member collection resolved against a 500-item
    // index must stay a single pass.
    const members = Array.from({ length: 500 }, (_, i) =>
      record(`b${i}`, 'bug', { status: i % 2 === 0 ? 'done' : 'to-do' }));
    const milestone = record('m1', 'milestone', { items: members.map(m => ({ itemId: m.id })) });

    let lookups = 0;
    const countingIndex = {
      get(id: string) { lookups++; return index(members).get(id); },
    } as unknown as ReadonlyMap<string, TrackerRecord>;

    const rollup = computeCollectionRollup(milestone, countingIndex, getRecordStatus);
    expect(lookups).toBe(500);
    expect(rollup.percentComplete).toBe(50);
  });
});
