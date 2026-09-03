// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { resolveColumnsForType } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import {
  buildGridColumns,
  buildGridActionsColumn,
  buildGridSource,
  ROW_ACTIONS,
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
      { name: 'collection', type: 'relationship', targetTrackerTypes: ['milestone'], multiValue: true },
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

  it('names collection cells from the live record, not the link snapshot', () => {
    registerType();
    const [collection] = buildGridColumns(columnsFor(['collection']), {
      trackerType: gridType,
      isRowEditable: () => true,
      resolveRelationshipLabel: id => (id === 'mst_1' ? 'Onboarding' : undefined),
    });
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const cellText = (value: unknown): string[] => {
      const cell = (collection.cellTemplate as any)(h, { model: { collection: value } });
      return (cell.children as any[]).map(chip => chip.children);
    };

    // A link written from the milestone's side carries no title at all, and a
    // renamed target leaves a stale one -- both must read as the live name.
    expect(cellText(['mst_1'])).toEqual(['Onboarding']);
    expect(cellText([{ itemId: 'mst_1', title: 'Old name', issueKey: 'NIM-9' }]))
      .toEqual(['Onboarding']);
    // Unresolvable targets still fall back to the snapshot rather than the id.
    expect(cellText([{ itemId: 'rel_2', title: 'Release 1.4' }])).toEqual(['Release 1.4']);
  });

  /**
   * A value is one pill because it is one value, not because it happens to
   * contain no comma: joining the resolved titles and re-splitting them on
   * ', ' tore "Tampa, FL client meeting" into two chips (nimbalyst#1424).
   */
  it('renders one pill per value even when a value contains a comma', () => {
    registerType();
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const pills = (
      columnId: string,
      value: unknown,
      resolveRelationshipLabel?: (id: string) => string | undefined,
    ): string[] => {
      const [column] = buildGridColumns(columnsFor([columnId]), {
        trackerType: gridType,
        isRowEditable: () => true,
        resolveRelationshipLabel,
      });
      const cell = (column.cellTemplate as any)(h, { model: { [columnId]: value } });
      return (cell.children as any[]).map(chip => chip.children);
    };

    expect(pills('collection', ['mst_1'], id => (
      id === 'mst_1' ? 'Tampa, FL client meeting' : undefined
    ))).toEqual(['Tampa, FL client meeting']);
    expect(pills('collection', [{ itemId: 'rel_2', title: 'Release 1.4, hotfix' }]))
      .toEqual(['Release 1.4, hotfix']);
    expect(pills('tags', ['Tampa, FL', 'urgent'])).toEqual(['Tampa, FL', 'urgent']);
  });

  it('opens the existing row context menu from the dedicated action column', () => {
    const actionColumn = buildGridActionsColumn();
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });
    const action = (actionColumn.cellTemplate as any)(h, {
      model: { [ROW_ITEM_ID]: '1', title: 'Alpha' },
    });
    const target = document.createElement('button');
    const rowCell = document.createElement('div');
    rowCell.dataset.rgrow = '0';
    rowCell.appendChild(target);
    const observed = vi.fn();
    rowCell.addEventListener('contextmenu', observed);
    const pointerEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    action.props.onPointerDown(pointerEvent);
    action.props.onClick({
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: target,
      clientX: 24,
      clientY: 36,
    });

    expect(pointerEvent.preventDefault).toHaveBeenCalled();
    expect(pointerEvent.stopPropagation).toHaveBeenCalled();
    expect(actionColumn.prop).toBe(ROW_ACTIONS);
    expect(actionColumn.pin).toBe('colPinEnd');
    expect(observed).toHaveBeenCalledTimes(1);
    const event = observed.mock.calls[0][0] as MouseEvent;
    expect(event.clientX).toBe(24);
    expect(event.clientY).toBe(36);
  });

  /**
   * The Key cell is the only open affordance in the grid, so both of its
   * gestures have to survive: without them a row can only be reached by
   * keyboard or through the context menu.
   */
  describe('key cell as the open affordance', () => {
    const h = (tag: string, props: Record<string, unknown>, children: unknown) => ({
      tag,
      props,
      children,
    });

    const keyCell = (keyLink: Parameters<typeof buildGridColumns>[1]['keyLink'], key = 'GCS-1') => {
      registerType();
      const [column] = buildGridColumns(columnsFor(['key']), {
        trackerType: gridType,
        isRowEditable: () => true,
        keyLink,
      });
      return (column.cellTemplate as any)(h, {
        model: { key, [ROW_ITEM_ID]: 'gcs_1' },
      });
    };

    it('opens the detail from the key and the document from the expand icon', () => {
      const onOpenDetail = vi.fn();
      const onOpenDocument = vi.fn();
      const cell = keyCell({ onOpenDetail, onOpenDocument });
      const [link, expand] = cell.children;
      const mouseEvent = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() });

      expect(link.children).toBe('GCS-1');
      link.props.onClick(mouseEvent());
      expect(onOpenDetail).toHaveBeenCalledWith('gcs_1');

      // Focusing the cell under the icon would move the selection out from
      // under the click, so the icon swallows pointerdown.
      const pointer = mouseEvent();
      expand.props.onPointerDown(pointer);
      expect(pointer.preventDefault).toHaveBeenCalled();
      expand.props.onClick(mouseEvent());
      expect(onOpenDocument).toHaveBeenCalledWith('gcs_1');
    });

    it('omits the expand icon where there is no document surface', () => {
      const cell = keyCell({ onOpenDetail: vi.fn() });
      expect(cell.children).toHaveLength(1);
    });

    it('falls back to the icon as the link when the row has no key', () => {
      const onOpenDetail = vi.fn();
      const cell = keyCell({ onOpenDetail, onOpenDocument: vi.fn() }, '');
      const [link] = cell.children;

      // Without this the cell is blank and the row cannot be opened by pointer
      // at all -- imported and frontmatter-projected items may never get a key.
      expect(link.props.class).toContain('is-icon-only');
      link.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(onOpenDetail).toHaveBeenCalledWith('gcs_1');
    });
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
