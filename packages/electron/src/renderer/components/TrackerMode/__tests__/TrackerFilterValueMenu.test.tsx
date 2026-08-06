// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TrackerFilterValueMenu } from '../TrackerFilterValueMenu';
import type { TrackerFilterField } from '../TrackerViewHeaderControls';

const STATUS: TrackerFilterField = {
  id: 'status',
  label: 'Status',
  type: 'select',
  options: [
    { value: 'open', label: 'Open', count: 2 },
    { value: 'done', label: 'Done', count: 1 },
  ],
};

const search = () => screen.getByTestId('tracker-filter-option-search');

function renderMenu(field: TrackerFilterField, onSelect = vi.fn()) {
  render(
    <TrackerFilterValueMenu
      field={field}
      anchorRect={null}
      onSelect={onSelect}
      onClose={vi.fn()}
    />,
  );
  return onSelect;
}

describe('TrackerFilterValueMenu keyboard navigation', () => {
  it('walks the value list with the arrow keys and commits on Enter', () => {
    const onSelect = renderMenu(STATUS);

    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(screen.getByTestId('tracker-filter-option-open').dataset.selected).toBe('true');

    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('done', '=');
  });

  it('releases the highlight when arrowing back past the first row', () => {
    const onSelect = renderMenu(STATUS);

    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'ArrowUp' });
    expect(document.querySelector('[data-selected="true"]')).toBeNull();

    // Nothing highlighted and more than one match: Enter keeps its old no-op.
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps committing the only match when nothing is highlighted', () => {
    const onSelect = renderMenu(STATUS);

    fireEvent.change(search(), { target: { value: 'don' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('done', '=');
  });

  it('navigates the relative person rows of a user field', () => {
    const onSelect = renderMenu({ id: 'assignee', label: 'Assignee', type: 'user', options: [] });

    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('', 'is-not-current-user');
  });

  it('applies accumulated values on Enter for a multi-value field', () => {
    const onSelect = renderMenu({ ...STATUS, id: 'tags', label: 'Tags', type: 'multiselect' });

    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled(); // toggled, not committed

    // Apply joins the tour once something is pending: past both value rows.
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(screen.getByTestId('tracker-filter-apply-multiple').dataset.selected).toBe('true');
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(['open'], 'in');
  });

  it('applies pending multi-select values with Cmd+Enter', () => {
    const onSelect = renderMenu({ ...STATUS, id: 'tags', label: 'Tags', type: 'multiselect' });

    fireEvent.click(screen.getByTestId('tracker-filter-option-done'));
    fireEvent.keyDown(search(), { key: 'Enter', metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(['done'], 'in');
  });

  it('lets a boolean field name its own true/false values', () => {
    const onSelect = renderMenu({
      id: 'favorite',
      label: 'Starred',
      type: 'boolean',
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    });

    expect(screen.getByTestId('tracker-filter-option-true').textContent).toContain('Yes');
    expect(screen.getByTestId('tracker-filter-option-false').textContent).toContain('No');
    expect(screen.queryByText('True')).toBeNull();

    fireEvent.click(screen.getByTestId('tracker-filter-option-true'));
    expect(onSelect).toHaveBeenCalledWith('true', '=');
  });

  it('still offers True/False for a boolean field with no named values', () => {
    renderMenu({ id: 'archived', label: 'Archived', type: 'boolean' });

    expect(screen.getByTestId('tracker-filter-option-true').textContent).toContain('True');
    expect(screen.getByTestId('tracker-filter-option-false').textContent).toContain('False');
  });

  it('filters a field with no option list on exactly what was typed', () => {
    const onSelect = renderMenu({ id: 'title', label: 'Title', type: 'string' });

    fireEvent.change(search(), { target: { value: ' needs review ' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('needs review', '=');
  });
});
