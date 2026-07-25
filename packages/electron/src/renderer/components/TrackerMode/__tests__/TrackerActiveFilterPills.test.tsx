// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrackerActiveFilterPills } from '../TrackerActiveFilterPills';

const fields = [{
  id: 'status',
  label: 'Status',
  type: 'select' as const,
  options: [
    { value: 'in-review', label: 'In Review' },
    { value: 'done', label: 'Done' },
  ],
}];

describe('TrackerActiveFilterPills', () => {
  it('renders applied field filters with schema value labels', () => {
    render(
      <TrackerActiveFilterPills
        fields={fields}
        filters={{
          combinator: 'and',
          clauses: [{ field: 'status', op: '=', value: 'in-review' }],
        }}
        onManage={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByTestId('tracker-active-filter-pills').textContent)
      .toContain('StatusisIn Review');
  });

  it('opens filter management from the pill and removes from its close control', () => {
    const onManage = vi.fn();
    const onRemove = vi.fn();
    render(
      <TrackerActiveFilterPills
        fields={fields}
        filters={{
          combinator: 'and',
          clauses: [{ field: 'status', op: '=', value: 'done' }],
        }}
        onManage={onManage}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByTitle('Manage filters'));
    expect(onManage).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('Remove Status filter'));
    expect(onRemove).toHaveBeenCalledWith(0);
  });
});
