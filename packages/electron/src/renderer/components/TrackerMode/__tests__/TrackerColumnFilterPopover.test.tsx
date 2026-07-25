// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FieldDefinition } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { TrackerColumnFilterPopover } from '../grid/TrackerColumnFilterPopover';

const statusField: FieldDefinition = {
  name: 'status',
  type: 'select',
  options: [
    { value: 'to-do', label: 'To do' },
    { value: 'in-progress', label: 'In progress' },
  ],
};

describe('TrackerColumnFilterPopover', () => {
  afterEach(() => cleanup());

  it('edits multiple clauses and the AND/OR combinator', () => {
    const onApply = vi.fn();
    render(
      <TrackerColumnFilterPopover
        columnId="status"
        columnLabel="Status"
        field={statusField}
        clauses={[{ field: 'status', op: '=', value: 'to-do' }]}
        combinator="and"
        anchorRect={new DOMRect(0, 0, 100, 20)}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByTestId('tracker-column-filter-combinator'), {
      target: { value: 'or' },
    });
    fireEvent.click(screen.getByTestId('tracker-column-filter-add'));
    fireEvent.change(screen.getByTestId('tracker-column-filter-value-1'), {
      target: { value: 'in-progress' },
    });
    fireEvent.click(screen.getByTestId('tracker-column-filter-apply'));

    expect(onApply).toHaveBeenCalledWith([
      { field: 'status', op: '=', value: 'to-do' },
      { field: 'status', op: '=', value: 'in-progress' },
    ], 'or');
  });
});
