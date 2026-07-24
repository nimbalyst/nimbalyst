// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  TrackerColumnDef,
  TypeColumnConfig,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { TrackerViewHeaderControls } from '../TrackerViewHeaderControls';

const columns = [
  {
    id: 'title',
    label: 'Title',
    width: 'auto',
    sortable: true,
    render: 'text',
    defaultVisible: true,
    builtin: true,
    editable: true,
    edit: 'text',
  },
  {
    id: 'status',
    label: 'Status',
    width: 120,
    sortable: true,
    render: 'badge',
    defaultVisible: true,
    builtin: true,
    editable: true,
    edit: 'select',
  },
  {
    id: 'priority',
    label: 'Priority',
    width: 100,
    sortable: true,
    render: 'badge',
    defaultVisible: false,
    builtin: true,
    editable: true,
    edit: 'select',
  },
] satisfies TrackerColumnDef[];

const columnConfig: TypeColumnConfig = {
  visibleColumns: ['title', 'status'],
  columnWidths: {},
  groupBy: null,
};

const filterFields = [
  { id: 'title', label: 'Title', type: 'string' as const },
  {
    id: 'status',
    label: 'Status',
    type: 'select' as const,
    options: [
      { value: 'to-do', label: 'To do' },
      { value: 'done', label: 'Done' },
    ],
  },
  {
    id: 'priority',
    label: 'Priority',
    type: 'select' as const,
    options: [
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ],
  },
];

function renderControls(overrides: Partial<Parameters<typeof TrackerViewHeaderControls>[0]> = {}) {
  const onColumnConfigChange = vi.fn();
  const onFiltersChange = vi.fn();
  render(
    <TrackerViewHeaderControls
      itemCount={42}
      availableColumns={columns}
      columnConfig={columnConfig}
      onColumnConfigChange={onColumnConfigChange}
      showColumnControls
      filterFields={filterFields}
      filters={null}
      onFiltersChange={onFiltersChange}
      {...overrides}
    />,
  );
  return { onColumnConfigChange, onFiltersChange };
}

describe('TrackerViewHeaderControls', () => {
  it('keeps count, filters, and display options in one shared header control group', () => {
    renderControls();

    expect(screen.getByTestId('tracker-view-item-count').textContent).toBe('42 items');
    expect(screen.getByTestId('tracker-view-filter-button')).toBeTruthy();
    expect(screen.getByTestId('tracker-view-display-options')).toBeTruthy();
  });

  it('builds multiple field-aware clauses with AND/OR semantics', () => {
    const { onFiltersChange } = renderControls();
    fireEvent.click(screen.getByTestId('tracker-view-filter-button'));
    fireEvent.click(screen.getByTestId('tracker-filter-advanced'));

    fireEvent.change(screen.getByTestId('tracker-filter-builder-field-0'), {
      target: { value: 'status' },
    });
    fireEvent.change(screen.getByTestId('tracker-filter-builder-value-0'), {
      target: { value: 'done' },
    });
    fireEvent.click(screen.getByTestId('tracker-filter-builder-add'));
    fireEvent.change(screen.getByTestId('tracker-filter-builder-field-1'), {
      target: { value: 'priority' },
    });
    fireEvent.change(screen.getByTestId('tracker-filter-builder-value-1'), {
      target: { value: 'high' },
    });
    fireEvent.change(screen.getByTestId('tracker-filter-builder-combinator'), {
      target: { value: 'or' },
    });
    fireEvent.click(screen.getByTestId('tracker-filter-builder-apply'));

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'or',
      clauses: [
        { field: 'status', op: '=', value: 'done' },
        { field: 'priority', op: '=', value: 'high' },
      ],
    });
  });

  it('starts as a searchable field command menu and applies a quick field filter', () => {
    const { onFiltersChange } = renderControls();
    fireEvent.click(screen.getByTestId('tracker-view-filter-button'));

    expect(screen.getByPlaceholderText('Add filter…')).toBeTruthy();
    expect(screen.getByTestId('tracker-filter-advanced')).toBeTruthy();
    fireEvent.change(screen.getByTestId('tracker-filter-command-search'), {
      target: { value: 'status' },
    });
    expect(screen.getByTestId('tracker-filter-field-status')).toBeTruthy();
    expect(screen.queryByTestId('tracker-filter-field-priority')).toBeNull();

    fireEvent.click(screen.getByTestId('tracker-filter-field-status'));
    expect(screen.getByTestId('tracker-filter-value-submenu')).toBeTruthy();
    expect(screen.getByTestId('tracker-filter-field-status')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tracker-filter-option-done'));

    expect(onFiltersChange).toHaveBeenCalledWith({
      combinator: 'and',
      clauses: [{ field: 'status', op: '=', value: 'done' }],
    });
  });

  it('supports keyboard drill-in and removing active filters from the command menu', () => {
    const { onFiltersChange } = renderControls({
      filters: {
        combinator: 'and',
        clauses: [{ field: 'status', op: '=', value: 'done' }],
      },
    });
    fireEvent.click(screen.getByTestId('tracker-view-filter-button'));

    expect(screen.getByTestId('tracker-filter-active-list')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('tracker-filter-command-search'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByTestId('tracker-filter-command-search'), { key: 'Enter' });
    expect(screen.getByTestId('tracker-filter-value-submenu')).toBeTruthy();
    expect(screen.getByTestId('tracker-filter-builder')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Remove Status filter'));
    expect(onFiltersChange).toHaveBeenCalledWith({ combinator: 'and', clauses: [] });
  });

  it('keeps the field menu open beside a searchable value submenu with counts', () => {
    renderControls({
      filterFields: [
        {
          id: 'status',
          label: 'Status',
          type: 'select',
          options: [
            { value: 'done', label: 'Done', count: 2, color: '#22c55e' },
            { value: 'blocked', label: 'Blocked', count: 0, color: '#ef4444' },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByTestId('tracker-view-filter-button'));
    fireEvent.mouseEnter(screen.getByTestId('tracker-filter-field-status'));

    expect(screen.getByTestId('tracker-filter-builder')).toBeTruthy();
    expect(screen.getByTestId('tracker-filter-value-submenu')).toBeTruthy();
    expect(screen.getByText('2 issues')).toBeTruthy();
    expect(screen.getByText('1 option not matching any issues')).toBeTruthy();

    fireEvent.change(screen.getByTestId('tracker-filter-option-search'), {
      target: { value: 'don' },
    });
    expect(screen.getByTestId('tracker-filter-option-done')).toBeTruthy();
  });

  it('uses the same display-options panel for column visibility', () => {
    const { onColumnConfigChange } = renderControls();
    fireEvent.click(screen.getByTestId('tracker-view-display-options'));
    expect(screen.getByText('Display Options')).toBeTruthy();

    fireEvent.click(screen.getAllByText('Priority').find(element => element.tagName === 'SPAN')!);
    expect(onColumnConfigChange).toHaveBeenCalledWith({
      visibleColumns: ['title', 'status', 'priority'],
      columnWidths: {},
      groupBy: null,
    });
  });

  it('hides column controls for non-column views while preserving filters and count', () => {
    renderControls({ showColumnControls: false });

    expect(screen.queryByTestId('tracker-view-display-options')).toBeNull();
    expect(screen.getByTestId('tracker-view-filter-button')).toBeTruthy();
    expect(screen.getByTestId('tracker-view-item-count')).toBeTruthy();
  });

  it('opens filter management when an active filter pill requests it', () => {
    renderControls({ openFiltersToken: 1 });

    expect(screen.getByTestId('tracker-filter-builder')).toBeTruthy();
  });

});
