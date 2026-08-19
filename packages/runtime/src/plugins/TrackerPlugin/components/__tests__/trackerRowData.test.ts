// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import {
  resolveTrackerGroups,
  TRACKER_GROUPING_OPTIONS,
} from '../../models/trackerGrouping';
import {
  getSupportedTrackerOrderingColumns,
  resolveTrackerOrderingField,
  resolveTrackerOrderingValue,
} from '../../models/trackerOrdering';
import { resolveColumnsForType } from '../trackerColumns';
import { globalRegistry } from '../../models';
import type { TrackerDataModel } from '../../models/TrackerDataModel';
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

  // The local number is now visible in the Key column, so it has to be
  // something you can paste back into the search box.
  it('matches on the local number of an item with no team key', () => {
    const unshared = record({ id: 'b', localKey: 'NIC.42', fields: { title: 'Unshared' } });

    expect(searchMatchesRecord(unshared, 'nic.42')).toBe(true);
    expect(searchMatchesRecord(unshared, 'nic.7')).toBe(false);
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

describe('tracker grouping resolver', () => {
  it('resolves every supported axis to stable keys, display labels, and multi-value memberships', () => {
    const item = record({
      id: 'grouped',
      primaryType: 'plan',
      fields: {
        title: 'Grouped plan',
        status: 'in-progress',
        priority: 'high',
        owner: { email: 'greg@example.com', displayName: 'Greg' },
        tags: ['planning', 'launch', 'planning'],
        collection: [
          { itemId: 'mst-1', title: 'Beta Launch', trackerType: 'milestone' },
          { itemId: 'rel-1', title: 'August', trackerType: 'release' },
        ],
        goal: [
          { itemId: 'goal-1', title: 'Teams Beta', trackerType: 'goal' },
          { itemId: 'goal-2', issueKey: 'NIM-G2', trackerType: 'goal' },
        ],
      },
    });

    expect(TRACKER_GROUPING_OPTIONS.map(option => option.label)).toEqual([
      'Status', 'Priority', 'Assignee', 'Type', 'Tag', 'Milestone', 'Goal',
    ]);
    expect(Object.fromEntries(
      ['status', 'priority', 'assignee', 'type'].map(axis => [
        axis,
        resolveTrackerGroups(item, axis as 'status').map(({ key, value, label }) => ({ key, value, label })),
      ]),
    )).toEqual({
      status: [{ key: 'status:value:in-progress', value: 'in-progress', label: 'In Progress' }],
      priority: [{ key: 'priority:value:high', value: 'high', label: 'High' }],
      assignee: [{ key: 'assignee:value:greg%40example.com', value: 'greg@example.com', label: 'Greg' }],
      type: [{ key: 'type:value:plan', value: 'plan', label: 'Plan' }],
    });
    expect(resolveTrackerGroups(item, 'tag').map(({ key, label }) => ({ key, label }))).toEqual([
      { key: 'tag:value:planning', label: '#planning' },
      { key: 'tag:value:launch', label: '#launch' },
    ]);
    expect(resolveTrackerGroups(item, 'milestone').map(({ value, label }) => ({ value, label })))
      .toEqual([{ value: 'mst-1', label: 'Beta Launch' }]);
    expect(resolveTrackerGroups(item, 'goal').map(({ value, label }) => ({ value, label })))
      .toEqual([
        { value: 'goal-1', label: 'Teams Beta' },
        { value: 'goal-2', label: 'NIM-G2' },
      ]);
  });

  it('returns a named, axis-stable no-value bucket and resolves manual ordering to the wire field', () => {
    const item = record({ id: 'empty', fields: { title: 'Empty', kanbanSortOrder: 'a0' } });
    expect(resolveTrackerGroups(item, 'assignee')).toEqual([
      { key: 'assignee:empty', value: null, label: 'Unassigned', empty: true },
    ]);
    expect(resolveTrackerGroups(item, 'milestone')[0]).toMatchObject({
      key: 'milestone:empty', value: null, label: 'No milestone', empty: true,
    });
    expect(resolveTrackerGroups(item, 'goal')[0]).toMatchObject({
      key: 'goal:empty', value: null, label: 'No goal', empty: true,
    });
    expect(resolveTrackerOrderingField('manual')).toBe('kanbanSortOrder');
    expect(resolveTrackerOrderingValue(item, 'manual')).toBe('a0');
    expect(resolveTrackerOrderingField('priority')).toBe('priority');
    expect(resolveTrackerOrderingValue(item, 'type')).toBe('bug');
    expect(resolveTrackerOrderingValue(item, 'updated')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('resolves every ordering option offered to board and timeline records', () => {
    const offeredColumns = getSupportedTrackerOrderingColumns(resolveColumnsForType(''));
    const identity = {
      email: 'owner@example.com',
      displayName: 'Owner',
      gitName: null,
      gitEmail: null,
    };
    const item = record({
      id: 'ordering-contract',
      issueKey: 'TEST-1',
      syncStatus: 'synced',
      fields: Object.fromEntries(offeredColumns.map(column => [column.id, `value:${column.id}`])),
      system: {
        workspace: '/workspace',
        documentPath: 'plans/example.md',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
        lastIndexed: '2026-08-03T00:00:00.000Z',
        authorIdentity: identity,
        lastModifiedBy: identity,
      },
    });

    expect(offeredColumns.map(column => column.id)).toContain('shared');
    expect(offeredColumns.map(column => column.id)).not.toContain('viewed');
    for (const column of offeredColumns) {
      expect(resolveTrackerOrderingValue(item, column.id), column.id).not.toBeUndefined();
    }
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

/**
 * Sorting the cross-tracker "All" view by Due Date has to compare each record's own
 * due-date field. Without the column defs, every type that names it something other
 * than `dueDate` sorts as blank and lands in a block at one end -- which reads as a
 * plausible ordering rather than as a bug (nimbalyst#1129).
 */
describe('sortTrackerRecords across tracker types', () => {
  const remapped: TrackerDataModel = {
    type: 'sortGoal',
    displayName: 'Goal',
    displayNamePlural: 'Goals',
    icon: 'flag',
    color: 'var(--nim-primary)',
    modes: { inline: true, fullDocument: true },
    idPrefix: 'SGL',
    idFormat: 'ulid',
    sharing: 'personal',
    draftByDefault: false,
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'targetDate', type: 'date' },
    ],
    roles: { title: 'title', dueDate: 'targetDate' },
  };

  const items = [
    record({ id: 'goal-late', primaryType: 'sortGoal', fields: { title: 'Goal', targetDate: '2026-09-01' } }),
    record({ id: 'bug-early', fields: { title: 'Bug', dueDate: '2026-08-01' } }),
    record({ id: 'goal-mid', primaryType: 'sortGoal', fields: { title: 'Goal', targetDate: '2026-08-15' } }),
  ];

  it('sorts a mixed list on whichever field each type maps the due-date role to', () => {
    globalRegistry.register(remapped);
    const columns = resolveColumnsForType('');

    expect(sortTrackerRecords(items, 'dueDate', 'asc', columns).map(item => item.id))
      .toEqual(['bug-early', 'goal-mid', 'goal-late']);
  });
});
