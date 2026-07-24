import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import {
  withEffectiveUpdated,
  searchMatchesRecord,
  filterTrackerRecords,
  sortTrackerRecords,
} from '../trackerRowData';

function record(partial: Partial<TrackerRecord> & { id: string }): TrackerRecord {
  return {
    primaryType: 'bug',
    typeTags: ['bug'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/workspace',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
    fields: { title: 'Untitled' },
    ...partial,
  } as TrackerRecord;
}

describe('withEffectiveUpdated', () => {
  it('stamps lastIndexed from the effective updated date', () => {
    const [result] = withEffectiveUpdated([
      record({ id: 'a', system: { workspace: '/w', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-10T12:00:00.000Z' } }),
    ]);
    expect(result.system.lastIndexed).toBe('2026-07-10T12:00:00.000Z');
  });

  it('falls back to the epoch when a record has no usable date', () => {
    const [result] = withEffectiveUpdated([
      record({ id: 'a', system: { workspace: '/w', createdAt: '', updatedAt: '' } }),
    ]);
    expect(result.system.lastIndexed).toBe(new Date(0).toISOString());
  });
});

describe('searchMatchesRecord', () => {
  const item = record({
    id: 'a',
    issueKey: 'NIM-42',
    issueNumber: 42,
    // The `bug` schema maps the assignee role onto `owner`, so search must find
    // it through the role rather than a literal `assignee` field.
    fields: { title: 'Grid cells do not save', owner: 'greg', tags: ['sync', 'ui'] },
    system: { workspace: '/w', createdAt: '', updatedAt: '', documentPath: 'design/grid.md' },
  });

  it('matches on key, number, title, path, assignee, and tags', () => {
    expect(searchMatchesRecord(item, 'nim-42')).toBe(true);
    expect(searchMatchesRecord(item, '42')).toBe(true);
    expect(searchMatchesRecord(item, 'cells')).toBe(true);
    expect(searchMatchesRecord(item, 'design/')).toBe(true);
    expect(searchMatchesRecord(item, 'greg')).toBe(true);
    expect(searchMatchesRecord(item, 'sync')).toBe(true);
  });

  it('treats an empty query as matching everything', () => {
    expect(searchMatchesRecord(item, '   ')).toBe(true);
  });

  it('rejects a non-matching query', () => {
    expect(searchMatchesRecord(item, 'kanban')).toBe(false);
  });
});

describe('filterTrackerRecords', () => {
  const items = [
    record({ id: 'a', primaryType: 'bug', fields: { title: 'Alpha' } }),
    record({ id: 'b', primaryType: 'task', fields: { title: 'Beta' } }),
  ];

  it('filters by tracker type', () => {
    expect(filterTrackerRecords(items, { typeFilter: 'task' as any }).map(i => i.id)).toEqual(['b']);
  });

  it('passes everything through for the all-types view', () => {
    expect(filterTrackerRecords(items, { typeFilter: 'all' })).toHaveLength(2);
  });

  it('combines search and type filters', () => {
    expect(filterTrackerRecords(items, { typeFilter: 'all', searchTerm: 'alpha' }).map(i => i.id)).toEqual(['a']);
  });
});

describe('sortTrackerRecords', () => {
  it('sorts by a field value in both directions', () => {
    const items = [
      record({ id: 'b', fields: { title: 'Beta' } }),
      record({ id: 'a', fields: { title: 'Alpha' } }),
    ];
    expect(sortTrackerRecords(items, 'title', 'asc').map(i => i.id)).toEqual(['a', 'b']);
    expect(sortTrackerRecords(items, 'title', 'desc').map(i => i.id)).toEqual(['b', 'a']);
  });

  it('sorts numbers numerically rather than lexically', () => {
    const items = [
      record({ id: 'ten', fields: { title: 'x', points: 10 } }),
      record({ id: 'two', fields: { title: 'x', points: 2 } }),
    ];
    expect(sortTrackerRecords(items, 'points', 'asc').map(i => i.id)).toEqual(['two', 'ten']);
  });

  it('sorts empty values as greater, matching the existing table ordering', () => {
    const items = [
      record({ id: 'empty', fields: { title: 'x' } }),
      record({ id: 'filled', fields: { title: 'x', points: 5 } }),
    ];
    expect(sortTrackerRecords(items, 'points', 'asc').map(i => i.id)).toEqual(['filled', 'empty']);
    expect(sortTrackerRecords(items, 'points', 'desc').map(i => i.id)).toEqual(['empty', 'filled']);
  });

  it('does not mutate the input array', () => {
    const items = [record({ id: 'b', fields: { title: 'Beta' } }), record({ id: 'a', fields: { title: 'Alpha' } })];
    sortTrackerRecords(items, 'title', 'asc');
    expect(items.map(i => i.id)).toEqual(['b', 'a']);
  });
});
