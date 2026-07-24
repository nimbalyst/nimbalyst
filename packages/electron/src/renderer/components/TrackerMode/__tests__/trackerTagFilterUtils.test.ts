import { describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  buildTrackerTagOptions,
  filterTrackerItemsByTags,
  getTrackerItemTags,
  normalizeTrackerTagList,
} from '../trackerTagFilterUtils';

function makeRecord(id: string, tags: unknown): TrackerRecord {
  return {
    id,
    primaryType: 'task',
    typeTags: ['task'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/tmp/workspace',
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
    },
    fields: {
      title: id,
      tags,
    },
  };
}

describe('trackerTagFilterUtils', () => {
  it('normalizes tracker tags from arrays and comma-separated strings', () => {
    expect(normalizeTrackerTagList([' ui ', 'bug', 12, '', 'bug'])).toEqual(['ui', 'bug', 'bug']);
    expect(normalizeTrackerTagList('ui, bug , , urgent')).toEqual(['ui', 'bug', 'urgent']);
    expect(normalizeTrackerTagList(null)).toEqual([]);
  });

  it('reads tracker tags from the schema tag role field', () => {
    expect(getTrackerItemTags(makeRecord('task-1', ['ui', 'urgent']))).toEqual(['ui', 'urgent']);
  });

  it('builds sorted tag options with per-item counts', () => {
    const items = [
      makeRecord('task-1', ['ui', 'bug', 'ui']),
      makeRecord('task-2', ['bug', 'urgent']),
      makeRecord('task-3', 'ui, urgent'),
    ];

    expect(buildTrackerTagOptions(items)).toEqual([
      { name: 'bug', count: 2 },
      { name: 'ui', count: 2 },
      { name: 'urgent', count: 2 },
    ]);
  });

  it('filters items when any active tag matches', () => {
    const task1 = makeRecord('task-1', ['ui', 'bug']);
    const task2 = makeRecord('task-2', ['urgent']);
    const task3 = makeRecord('task-3', []);

    expect(filterTrackerItemsByTags([task1, task2, task3], [])).toEqual([task1, task2, task3]);
    expect(filterTrackerItemsByTags([task1, task2, task3], ['ui'])).toEqual([task1]);
    expect(filterTrackerItemsByTags([task1, task2, task3], ['bug', 'urgent'])).toEqual([task1, task2]);
  });
});
