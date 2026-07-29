// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { resolveColumnsForType } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  buildGridColumns,
  buildGridSource,
  ROW_ITEM_ID,
  ROW_ITEM_TYPE,
} from '../grid/trackerGridColumns';

const gridType = 'gridColumnSpec';

function registerType(): void {
  const model: TrackerDataModel = {
    type: gridType,
    displayName: 'Spec',
    displayNamePlural: 'Specs',
    icon: 'assignment',
    color: '#000000',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'gcs',
    idFormat: 'ulid',
    fields: [
      { name: 'title', type: 'string', required: true },
      { name: 'state', type: 'select', options: [{ value: 'open', label: 'Open' }] },
      { name: 'points', type: 'number' },
      { name: 'computed', type: 'string', readOnly: true },
    ],
    roles: { title: 'title', workflowStatus: 'state' },
  };
  globalRegistry.register(model);
}

function record(id: string, fields: Record<string, unknown>): TrackerRecord {
  return {
    id,
    primaryType: gridType,
    typeTags: [gridType],
    issueKey: `GCS-${id}`,
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: { workspace: '/w', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z' },
    fields,
  } as TrackerRecord;
}

function recordWithCreator(id: string, fields: Record<string, unknown>): TrackerRecord {
  return {
    ...record(id, fields),
    system: {
      ...record(id, fields).system,
      authorIdentity: {
        email: 'alice@example.com',
        displayName: 'Alice Example',
        gitName: null,
        gitEmail: null,
      },
    },
  };
}

function columnsFor(ids: string[]) {
  const all = resolveColumnsForType(gridType);
  return ids.map(id => all.find(c => c.id === id)!).filter(Boolean);
}

describe('buildGridSource', () => {
  afterEach(() => globalRegistry.unregister(gridType));

  it('emits raw stored values keyed by column id, plus the item id', () => {
    registerType();
    const cols = columnsFor(['key', 'title', 'points']);
    const source = buildGridSource([record('1', { title: 'Alpha', points: 8 })], cols);

    expect(source).toHaveLength(1);
    expect(source[0][ROW_ITEM_ID]).toBe('1');
    expect(source[0][ROW_ITEM_TYPE]).toBe(gridType);
    expect(source[0].title).toBe('Alpha');
    // Numbers stay numbers -- editors and comparisons depend on the real type.
    expect(source[0].points).toBe(8);
    expect(source[0].key).toBe('GCS-1');
  });

  it('emits the creator identity for the structural Created by column', () => {
    registerType();
    const cols = columnsFor(['createdBy']);
    const source = buildGridSource([recordWithCreator('1', { title: 'Alpha' })], cols);

    expect(source[0].createdBy).toEqual({
      email: 'alice@example.com',
      displayName: 'Alice Example',
      gitName: null,
      gitEmail: null,
    });
  });
});

describe('buildGridColumns', () => {
  afterEach(() => globalRegistry.unregister(gridType));

  const build = (ids: string[], isRowEditable: (id: string) => boolean = () => true) =>
    buildGridColumns(columnsFor(ids), { trackerType: gridType, isRowEditable });

  it('attaches an editor to schema-backed columns', () => {
    registerType();
    const [title, state, points] = build(['title', 'state', 'points']);
    expect(title.editor).toBeDefined();
    expect(state.editor).toBeDefined();
    expect(points.editor).toBeDefined();
  });

  it('leaves structural and readOnly columns without an editor', () => {
    registerType();
    const [key, updated, computed] = build(['key', 'updated', 'computed']);
    expect(key.editor).toBeUndefined();
    expect(updated.editor).toBeUndefined();
    expect(computed.editor).toBeUndefined();
  });

  it('marks structural cells readonly', () => {
    registerType();
    const [key] = build(['key']);
    const readonly = key.readonly as (params: any) => boolean;
    expect(readonly({ model: { [ROW_ITEM_ID]: '1' } })).toBe(true);
  });

  it('marks cells readonly when the row itself is not editable', () => {
    registerType();
    const [title] = build(['title'], id => id !== 'locked');
    const readonly = title.readonly as (params: any) => boolean;

    expect(readonly({ model: { [ROW_ITEM_ID]: 'open' } })).toBe(false);
    expect(readonly({ model: { [ROW_ITEM_ID]: 'locked' } })).toBe(true);
    // A row with no resolvable item id must never be editable.
    expect(readonly({ model: {} })).toBe(true);
  });

  it('honors persisted column width overrides', () => {
    registerType();
    const [title] = buildGridColumns(columnsFor(['title']), {
      trackerType: gridType,
      columnWidths: { title: 420 },
      isRowEditable: () => true,
    });
    expect(title.size).toBe(420);
  });

  it('resolves mixed-type role columns and editors from each row schema', () => {
    registerType();
    const mixedColumns = resolveColumnsForType('').filter(column =>
      ['title', 'status'].includes(column.id));
    const [source] = buildGridSource(
      [record('1', { title: 'Alpha', state: 'open' })],
      mixedColumns,
    );
    const [, status] = buildGridColumns(mixedColumns, {
      trackerType: '',
      isRowEditable: () => true,
    });

    expect(source.status).toBe('open');
    expect(status.editor).toBeDefined();
    expect((status.readonly as (params: any) => boolean)({ model: source })).toBe(false);
  });

  it('enables native header sorting while keeping the filter action isolated', () => {
    registerType();
    const onOpenFilter = vi.fn();
    const [title] = buildGridColumns(columnsFor(['title']), {
      trackerType: gridType,
      isRowEditable: () => true,
      filteredColumnIds: new Set(['title']),
      sortingEnabled: true,
      onOpenFilter,
    });
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const header = (title.columnTemplate as any)(h);
    const actions = header.children[1];
    const [filterButton] = actions.children;
    const target = document.createElement('span');

    expect(title.sortable).toBe(true);
    expect(header.props.onClick).toBeUndefined();
    expect(filterButton.props.class).toContain('is-filtered');
    expect(filterButton.children.children).toBe('filter_alt');

    filterButton.props.onClick({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: target,
      clientX: 0,
      clientY: 0,
    });
    expect(onOpenFilter).toHaveBeenCalledWith('title', expect.objectContaining({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    }));
  });
});

describe('buildGridColumns cellCompare', () => {
  afterEach(() => globalRegistry.unregister(gridType));

  function comparerFor(columnId: string) {
    registerType();
    const [column] = buildGridColumns(columnsFor([columnId]), {
      trackerType: gridType,
      isRowEditable: () => false,
      sortingEnabled: true,
    });
    expect(column.cellCompare).toBeTypeOf('function');
    return (a: unknown, b: unknown): number =>
      column.cellCompare!.call({ order: 'asc' }, columnId, { [columnId]: a } as never, { [columnId]: b } as never);
  }

  it('orders Date cells chronologically, not by their stringified month name', () => {
    const compare = comparerFor('updated');
    // "wed may 20 2026" > "wed jun 24 2026" alphabetically, but May precedes June.
    expect(compare(new Date('2026-05-20T12:00:00Z'), new Date('2026-06-24T12:00:00Z'))).toBeLessThan(0);
    expect(compare(new Date('2026-06-24T12:00:00Z'), new Date('2026-05-20T12:00:00Z'))).toBeGreaterThan(0);
    expect(compare(new Date('2026-06-24T12:00:00Z'), new Date('2026-06-24T12:00:00Z'))).toBe(0);
  });

  it('orders a date column holding mixed Date and string values chronologically', () => {
    const compare = comparerFor('updated');
    expect(compare('2026-01-05', new Date('2026-03-01T00:00:00Z'))).toBeLessThan(0);
    expect(compare(new Date('2026-03-01T00:00:00Z'), '2026-01-05')).toBeGreaterThan(0);
  });

  it('keeps numeric columns numeric rather than lexicographic', () => {
    const compare = comparerFor('points');
    expect(compare(9, 10)).toBeLessThan(0);
  });

  it('sorts blank cells last ascending, matching the list comparator', () => {
    const compare = comparerFor('updated');
    expect(compare(undefined, new Date('2026-05-20T12:00:00Z'))).toBeGreaterThan(0);
    expect(compare(new Date('2026-05-20T12:00:00Z'), undefined)).toBeLessThan(0);
    // An emptied cell is stored as '' -- it must bucket with the blanks, not sort first.
    expect(compare('', new Date('2026-05-20T12:00:00Z'))).toBeGreaterThan(0);
    expect(compare('', undefined)).toBe(0);
  });
});
