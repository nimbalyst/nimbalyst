// @vitest-environment node
/** Pure board column derivation and relationship-safe drop writes. */

import { beforeAll, describe, expect, it } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  loadBuiltinTrackers,
  globalRegistry,
  normalizeRelationshipValue,
  type TrackerRelationshipValue,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { buildKanbanStatusColumns } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  buildTrackerBoardColumns,
  groupItemsIntoBoardColumns,
  resolveBoardDrop,
} from '../trackerBoardColumns';

beforeAll(() => {
  loadBuiltinTrackers();
});

function bug(id: string, fields: Record<string, unknown> = {}): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: ['bug'],
    issueKey: `NIM-${id}`,
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/w',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    fields: { title: `Bug ${id}`, status: 'to-do', ...fields },
  } as unknown as TrackerRecord;
}

function milestoneRef(itemId: string, title: string): TrackerRelationshipValue {
  return {
    itemId,
    title,
    issueKey: `MST-${itemId}`,
    trackerType: 'milestone',
    direction: 'out',
    relationshipTypeKey: 'in-collection',
  };
}

const RELEASE_REF: TrackerRelationshipValue = {
  itemId: 'rel_1',
  title: 'v1.0',
  trackerType: 'release',
  direction: 'out',
  relationshipTypeKey: 'in-collection',
};

describe('board columns', () => {
  const items = [
    bug('1', { status: 'to-do', collection: [milestoneRef('mst_beta', 'Beta Hardening')] }),
    bug('2', { status: 'in-progress', collection: [milestoneRef('mst_alpha', 'Alpha')] }),
    bug('3', { status: 'done' }),
  ];

  it('reproduces the schema-ordered status board, empty columns included', () => {
    const columns = buildTrackerBoardColumns('status', 'bug', items);
    const legacy = buildKanbanStatusColumns('bug', items);

    expect(columns.map(c => ({ value: c.value, label: c.label }))).toEqual(
      legacy.map(c => ({ value: c.value, label: c.label })),
    );
    // The column key must stay the bare status: the board's DOM markers and the
    // kanban E2E spec address columns as `tracker-kanban-column-to-do`.
    expect(columns.map(c => c.key)).toEqual(legacy.map(c => c.value));
    // A status no item is in still gets a lane.
    expect(columns.map(c => c.value)).toContain('in-review');
    expect(columns.some(c => c.empty)).toBe(false);
  });

  it('treats an ungrouped view as a status board', () => {
    expect(buildTrackerBoardColumns('none', 'bug', items))
      .toEqual(buildTrackerBoardColumns('status', 'bug', items));
  });

  it('derives one lane per milestone present, with the triage bucket last', () => {
    const columns = buildTrackerBoardColumns('milestone', 'bug', items);

    expect(columns.map(c => c.label)).toEqual(['Alpha', 'Beta Hardening', 'No milestone']);
    expect(columns.map(c => c.value)).toEqual(['mst_alpha', 'mst_beta', null]);
    expect(columns.at(-1)?.empty).toBe(true);
    // The lane carries the stored relationship, so a drop can rewrite the same
    // denormalized title/issueKey the rest of the app displays.
    expect(columns[0].ref?.issueKey).toBe('MST-mst_alpha');
  });

  it('names a lane from the milestone record rather than the stored snapshot', () => {
    // A relationship written from the milestone's side stores no title at all,
    // and a title stored before a rename is stale -- either way the lane read as
    // a raw id or an old name until the record itself was consulted.
    const untitled = bug('5', {
      collection: [{ itemId: 'mst_alpha', trackerType: 'milestone', direction: 'out' }],
    });
    const columns = buildTrackerBoardColumns(
      'milestone',
      'bug',
      [untitled, ...items],
      itemId => (itemId === 'mst_alpha' ? 'Alpha Launch' : undefined),
    );

    expect(columns.map(c => c.label)).toEqual(['Alpha Launch', 'Beta Hardening', 'No milestone']);
  });

  it('keeps the triage bucket even when every item is placed', () => {
    const placed = items.filter(item => item.fields.collection);
    const columns = buildTrackerBoardColumns('milestone', 'bug', placed);
    expect(columns.at(-1)).toMatchObject({ empty: true, label: 'No milestone', value: null });
  });

  it('puts an unplaced item in the triage bucket and a multi-milestone item in both lanes', () => {
    const shared = bug('4', {
      collection: [milestoneRef('mst_alpha', 'Alpha'), milestoneRef('mst_beta', 'Beta Hardening')],
    });
    const all = [...items, shared];
    const columns = buildTrackerBoardColumns('milestone', 'bug', all);
    const grouped = groupItemsIntoBoardColumns(all, columns, 'milestone', 'manual');

    const idsIn = (label: string) =>
      grouped[columns.find(c => c.label === label)!.key].map(item => item.id);

    expect(idsIn('Alpha')).toEqual(['2', '4']);
    expect(idsIn('Beta Hardening')).toEqual(['1', '4']);
    expect(idsIn('No milestone')).toEqual(['3']);
  });
});

describe('board drops', () => {
  const alpha = { key: 'milestone:value:mst_alpha', value: 'mst_alpha', label: 'Alpha', empty: false, ref: milestoneRef('mst_alpha', 'Alpha') };
  const noMilestone = { key: 'milestone:empty', value: null, label: 'No milestone', empty: true };

  it('reassigns milestone membership and leaves an unrelated release alone', () => {
    const item = bug('1', { collection: [milestoneRef('mst_beta', 'Beta Hardening'), RELEASE_REF] });

    const updates = resolveBoardDrop({
      item,
      axis: 'milestone',
      sourceColumnKey: 'milestone:value:mst_beta',
      targetColumn: alpha,
      columnItems: [],
      dropIndex: null,
    });

    const written = normalizeRelationshipValue(updates?.collection);
    expect(written.map(v => v.itemId)).toEqual(['rel_1', 'mst_alpha']);
    expect(written.find(v => v.itemId === 'mst_alpha')).toMatchObject({
      relationshipTypeKey: 'in-collection',
      trackerType: 'milestone',
      issueKey: 'MST-mst_alpha',
      title: 'Alpha',
    });
    expect(updates?.kanbanSortOrder).toBeTypeOf('string');
  });

  it('drops the milestone but not the release when a card lands in the triage bucket', () => {
    const item = bug('1', { collection: [milestoneRef('mst_beta', 'Beta Hardening'), RELEASE_REF] });

    const updates = resolveBoardDrop({
      item,
      axis: 'milestone',
      sourceColumnKey: 'milestone:value:mst_beta',
      targetColumn: noMilestone,
      columnItems: [],
      dropIndex: null,
    });

    expect(normalizeRelationshipValue(updates?.collection).map(v => v.itemId)).toEqual(['rel_1']);
  });

  it('reassigns a multi-milestone card dragged between two lanes it already occupies', () => {
    // The card renders in both lanes, so the target column already holds it.
    // Read as "stayed put" the drag writes only a sort key, Beta Hardening keeps
    // the card, and the gesture looks like it did nothing.
    const item = bug('1', {
      collection: [milestoneRef('mst_alpha', 'Alpha'), milestoneRef('mst_beta', 'Beta Hardening')],
    });

    const updates = resolveBoardDrop({
      item,
      axis: 'milestone',
      sourceColumnKey: 'milestone:value:mst_beta',
      targetColumn: alpha,
      columnItems: [item],
      dropIndex: 0,
    });

    expect(normalizeRelationshipValue(updates?.collection).map(v => v.itemId)).toEqual(['mst_alpha']);
  });

  it('writes the resolved workflow status when a card crosses status columns', () => {
    const item = bug('1', { status: 'to-do' });
    const updates = resolveBoardDrop({
      item,
      axis: 'status',
      sourceColumnKey: 'to-do',
      targetColumn: { key: 'in-progress', value: 'in-progress', label: 'In Progress', empty: false },
      columnItems: [],
      dropIndex: null,
    });
    expect(updates?.status).toBe('in-progress');
  });

  it('writes only a sort key between the new neighbors when a card moves within its column', () => {
    const moved = bug('3', { kanbanSortOrder: 'a2' });
    const columnItems = [
      bug('1', { kanbanSortOrder: 'a0' }),
      bug('2', { kanbanSortOrder: 'a1' }),
      moved,
    ];

    const updates = resolveBoardDrop({
      item: moved,
      axis: 'status',
      sourceColumnKey: 'to-do',
      targetColumn: { key: 'to-do', value: 'to-do', label: 'To Do', empty: false },
      columnItems,
      dropIndex: 1,
    });

    expect(Object.keys(updates ?? {})).toEqual(['kanbanSortOrder']);
    const key = updates!.kanbanSortOrder as string;
    expect(key > 'a0' && key < 'a1').toBe(true);
  });

  it('writes nothing when the axis has no defined cross-column write', () => {
    const item = bug('1');
    expect(resolveBoardDrop({
      item,
      axis: 'type',
      sourceColumnKey: 'type:value:bug',
      targetColumn: { key: 'type:value:plan', value: 'plan', label: 'Plan', empty: false },
      columnItems: [],
      dropIndex: null,
    })).toBeNull();
  });
});


describe('boards grouped by a schema field', () => {
  it('keeps empty schema lanes in option order, groups booleans, and writes the actual selected field', () => {
    globalRegistry.register({ type: 'board-custom', displayName: 'Custom', displayNamePlural: 'Customs', fields: [
      { name: 'stage', type: 'select', options: [{ value: 'next', label: 'Next' }, { value: 'now', label: 'Now' }] },
      { name: 'shipped', type: 'boolean' },
    ] } as never);
    const item = { ...bug('custom'), primaryType: 'board-custom', fields: { title: 'Card', stage: 'now', shipped: false } };
    const axis = { kind: 'field', fieldId: 'stage' } as const;
    const columns = buildTrackerBoardColumns(axis, 'board-custom', [item]);
    expect(columns.map(column => column.label)).toEqual(['Next', 'Now']);
    const grouped = groupItemsIntoBoardColumns([item], columns, axis, 'manual');
    expect(grouped[columns[1].key]).toEqual([item]);
    expect(resolveBoardDrop({ item, axis, sourceColumnKey: columns[1].key, targetColumn: columns[0], columnItems: [], dropIndex: null })).toMatchObject({ stage: 'next' });
    const booleans = buildTrackerBoardColumns({ kind: 'field', fieldId: 'shipped' }, 'board-custom', [item]);
    expect(booleans.map(column => column.value)).toEqual(['true', 'false']);
    globalRegistry.unregister('board-custom');
  });
});
