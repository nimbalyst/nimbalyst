import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import {
  withEffectiveUpdated,
  searchMatchesRecord,
  filterTrackerRecords,
  getTrackerGroupLabel,
  groupTrackerRecords,
  sortTrackerRecords,
  compareCellValues,
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

describe('groupTrackerRecords', () => {
  it('groups records by status while preserving sorted order within each group', () => {
    const items = [
      record({ id: 'a', fields: { title: 'A', status: 'in-progress' } }),
      record({ id: 'b', fields: { title: 'B', status: 'done' } }),
      record({ id: 'c', fields: { title: 'C', status: 'in-progress' } }),
    ];

    const groups = groupTrackerRecords(items, 'status');

    expect(groups.map(group => group.label)).toEqual(['In Progress', 'Done']);
    expect(groups[0].items.map(item => item.id)).toEqual(['a', 'c']);
    expect(groups[1].items.map(item => item.id)).toEqual(['b']);
  });

  it('uses the schema assignee role and a readable unassigned bucket', () => {
    const assigned = record({
      id: 'assigned',
      fields: {
        title: 'Assigned',
        owner: { email: 'greg@example.com', displayName: 'Greg' },
      },
    });
    const unassigned = record({ id: 'unassigned', fields: { title: 'Unassigned' } });

    expect(getTrackerGroupLabel(assigned, 'assignee')).toBe('Greg');
    expect(groupTrackerRecords([assigned, unassigned], 'owner').map(group => group.label))
      .toEqual(['Greg', 'Unassigned']);
  });

  it('returns a flat group when grouping is disabled', () => {
    const items = [record({ id: 'a' }), record({ id: 'b' })];
    expect(groupTrackerRecords(items, null)).toEqual([{ key: '', label: null, items }]);
  });
});

describe('compareCellValues', () => {
  it('orders dates chronologically rather than by stringified month name', () => {
    // Both are Wednesdays; "may" sorts after "jun" alphabetically.
    expect(compareCellValues(
      new Date('2026-05-20T12:00:00Z'),
      new Date('2026-06-24T12:00:00Z'),
    )).toBeLessThan(0);
  });

  it('coerces a mixed Date/string date pair to epoch', () => {
    expect(compareCellValues('2026-01-05', new Date('2026-03-01T00:00:00Z'))).toBeLessThan(0);
    expect(compareCellValues(new Date('2026-03-01T00:00:00Z'), '2026-01-05')).toBeGreaterThan(0);
  });

  it('treats an emptied cell the same as a missing one', () => {
    expect(compareCellValues('', undefined)).toBe(0);
    expect(compareCellValues('', 'alpha')).toBeGreaterThan(0);
  });

  it('falls back to a string compare for unparseable date-column values', () => {
    expect(compareCellValues('not a date', 'zebra', 'date')).toBeLessThan(0);
  });
});

describe('sortTrackerRecords by Updated', () => {
  it('orders the Updated column chronologically in both directions', () => {
    const items = [
      record({ id: 'mar', system: { workspace: '/w', createdAt: '2026-03-25T12:00:00.000Z', updatedAt: '2026-03-25T12:00:00.000Z' } }),
      record({ id: 'may', system: { workspace: '/w', createdAt: '2026-05-20T12:00:00.000Z', updatedAt: '2026-05-20T12:00:00.000Z' } }),
      record({ id: 'jun', system: { workspace: '/w', createdAt: '2026-06-24T12:00:00.000Z', updatedAt: '2026-06-24T12:00:00.000Z' } }),
    ];
    expect(sortTrackerRecords(items, 'updated', 'desc').map(i => i.id)).toEqual(['jun', 'may', 'mar']);
    expect(sortTrackerRecords(items, 'updated', 'asc').map(i => i.id)).toEqual(['mar', 'may', 'jun']);
  });
});
