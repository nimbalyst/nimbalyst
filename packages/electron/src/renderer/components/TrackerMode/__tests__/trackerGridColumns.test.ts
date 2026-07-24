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

  it('renders explicit sort and compact filter actions in the header', () => {
    registerType();
    const onSort = vi.fn();
    const onOpenFilter = vi.fn();
    const [title] = buildGridColumns(columnsFor(['title']), {
      trackerType: gridType,
      isRowEditable: () => true,
      filteredColumnIds: new Set(['title']),
      sortBy: 'title',
      sortDirection: 'desc',
      onSort,
      onOpenFilter,
    });
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const header = (title.columnTemplate as any)(h);
    const actions = header.children[1];
    const [sortButton, filterButton] = actions.children;
    const target = document.createElement('span');

    expect(sortButton.props.class).toContain('is-sorted');
    expect(sortButton.children.children).toBe('arrow_downward');
    expect(filterButton.props.class).toContain('is-filtered');
    expect(filterButton.children.children).toBe('filter_alt');

    sortButton.props.onClick({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(onSort).toHaveBeenCalledWith('title', 'asc');

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
