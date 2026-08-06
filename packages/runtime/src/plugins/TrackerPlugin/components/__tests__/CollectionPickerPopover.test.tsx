import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CollectionPickerPopover } from '../CollectionPickerPopover';
import type { FieldDefinition } from '../../models/TrackerDataModel';
import type { RelationshipCandidate } from '../RelationshipFieldEditor';

const collectionField: FieldDefinition = {
  name: 'collection',
  type: 'relationship',
  relationshipTypeKey: 'in-collection',
  inverseRelationshipTypeKey: 'has-item',
  inverseFieldId: 'items',
  targetTrackerTypes: ['milestone', 'release'],
  multiValue: true,
};

const candidates: RelationshipCandidate[] = [
  { itemId: 'mst_1', title: 'Alpha Launch', issueKey: 'NIM-10', trackerType: 'milestone' },
  { itemId: 'mst_2', title: 'Beta Hardening', issueKey: 'NIM-11', trackerType: 'milestone' },
  { itemId: 'rel_1', title: 'v2.0', issueKey: 'NIM-12', trackerType: 'release' },
];

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof CollectionPickerPopover>> = {},
) {
  const onChange = vi.fn();
  const onRequestClose = vi.fn();
  const utils = render(
    <CollectionPickerPopover
      field={collectionField}
      value={overrides.value ?? []}
      candidates={candidates}
      onChange={onChange}
      onRequestClose={onRequestClose}
      {...overrides}
    />,
  );
  return { onChange, onRequestClose, ...utils };
}

describe('CollectionPickerPopover', () => {
  it('filters collections by title and assigns the picked one', () => {
    const { onChange } = renderPicker();

    fireEvent.change(screen.getByTestId('collection-picker-search'), {
      target: { value: 'beta' },
    });

    expect(screen.queryByTestId('collection-picker-option-mst_1')).toBeNull();
    fireEvent.click(screen.getByTestId('collection-picker-option-mst_2'));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        itemId: 'mst_2',
        title: 'Beta Hardening',
        relationshipTypeKey: 'in-collection',
        direction: 'out',
      }),
    ]);
  });

  it('filters by issue key too', () => {
    renderPicker();

    fireEvent.change(screen.getByTestId('collection-picker-search'), {
      target: { value: 'NIM-12' },
    });

    screen.getByTestId('collection-picker-option-rel_1');
    expect(screen.queryByTestId('collection-picker-option-mst_1')).toBeNull();
  });

  it('preserves other memberships when adding, since the field is multi-value', () => {
    const { onChange } = renderPicker({ value: [{ itemId: 'mst_1', title: 'Alpha Launch' }] });

    fireEvent.click(screen.getByTestId('collection-picker-option-rel_1'));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ itemId: 'mst_1' }),
      expect.objectContaining({ itemId: 'rel_1' }),
    ]);
  });

  it('unassigns from the current-membership chip', () => {
    const { onChange } = renderPicker({
      value: [{ itemId: 'mst_1', title: 'Alpha Launch' }, { itemId: 'rel_1', title: 'v2.0' }],
    });

    fireEvent.click(screen.getByTestId('collection-picker-remove-mst_1'));

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ itemId: 'rel_1' })]);
  });

  it('unassigns by clicking an already-assigned option', () => {
    const { onChange } = renderPicker({ value: [{ itemId: 'mst_1', title: 'Alpha Launch' }] });

    fireEvent.click(screen.getByTestId('collection-picker-option-mst_1'));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('navigates with the arrow keys and assigns with Enter', () => {
    const { onChange } = renderPicker();
    const search = screen.getByTestId('collection-picker-search');

    // Options sort by label: Alpha Launch, Beta Hardening, v2.0.
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ itemId: 'mst_2' })]);
  });

  it('wraps ArrowUp from the first row to the last', () => {
    const { onChange } = renderPicker();
    const search = screen.getByTestId('collection-picker-search');

    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ itemId: 'rel_1' })]);
  });

  it('closes on Escape', () => {
    const { onRequestClose } = renderPicker();

    fireEvent.keyDown(screen.getByTestId('collection-picker-search'), { key: 'Escape' });

    expect(onRequestClose).toHaveBeenCalled();
  });

  it('offers a create row only for a name no collection already has', () => {
    renderPicker({ onCreateCollection: vi.fn() });
    const search = screen.getByTestId('collection-picker-search');

    fireEvent.change(search, { target: { value: 'Gamma' } });
    expect(screen.getByTestId('collection-picker-create').textContent).toContain('Gamma');

    fireEvent.change(search, { target: { value: 'v2.0' } });
    expect(screen.queryByTestId('collection-picker-create')).toBeNull();
  });

  it('hides the create row when the surface supplies no creation path', () => {
    renderPicker();

    fireEvent.change(screen.getByTestId('collection-picker-search'), {
      target: { value: 'Gamma' },
    });

    expect(screen.queryByTestId('collection-picker-create')).toBeNull();
  });

  it('creates and assigns in one step once a type is chosen', async () => {
    const onCreateCollection = vi.fn().mockResolvedValue({
      itemId: 'rel_new',
      title: 'Gamma',
      trackerType: 'release',
    });
    const { onChange } = renderPicker({ onCreateCollection });

    fireEvent.change(screen.getByTestId('collection-picker-search'), {
      target: { value: 'Gamma' },
    });
    fireEvent.click(screen.getByTestId('collection-picker-create'));

    // The type toggle offers exactly the field's collection target types.
    screen.getByTestId('collection-picker-type-milestone');
    fireEvent.click(screen.getByTestId('collection-picker-type-release'));

    await waitFor(() => expect(onCreateCollection).toHaveBeenCalledWith('Gamma', 'release'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ itemId: 'rel_new', title: 'Gamma', trackerType: 'release' }),
    ]));
  });

  it('reaches the create row with the arrow keys and opens the type toggle with Enter', () => {
    renderPicker({ onCreateCollection: vi.fn() });
    const search = screen.getByTestId('collection-picker-search');

    fireEvent.change(search, { target: { value: 'Gamma' } });
    // No candidate matches "Gamma", so the create row is the only row.
    fireEvent.keyDown(search, { key: 'Enter' });

    screen.getByTestId('collection-picker-create-panel');
  });

  it('surfaces a creation failure instead of silently assigning nothing', async () => {
    const onCreateCollection = vi.fn().mockRejectedValue(new Error('type is not creatable'));
    const { onChange } = renderPicker({ onCreateCollection });

    fireEvent.change(screen.getByTestId('collection-picker-search'), {
      target: { value: 'Gamma' },
    });
    fireEvent.click(screen.getByTestId('collection-picker-create'));
    fireEvent.click(screen.getByTestId('collection-picker-type-milestone'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not creatable'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Escape backs out of create mode without closing the popover', () => {
    const { onRequestClose } = renderPicker({ onCreateCollection: vi.fn() });
    const search = screen.getByTestId('collection-picker-search');

    fireEvent.change(search, { target: { value: 'Gamma' } });
    fireEvent.click(screen.getByTestId('collection-picker-create'));
    fireEvent.keyDown(search, { key: 'Escape' });

    expect(screen.queryByTestId('collection-picker-create-panel')).toBeNull();
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('collapses after a pick when the field holds a single collection', () => {
    const singleValueField: FieldDefinition = { ...collectionField, multiValue: false };
    const { onChange, onRequestClose } = renderPicker({ field: singleValueField });

    fireEvent.click(screen.getByTestId('collection-picker-option-mst_1'));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'mst_1' }));
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('tells the user when there is nothing to pick', () => {
    renderPicker({ candidates: [] });

    expect(screen.getByTestId('collection-picker-empty').textContent).toBe('No collections yet');
  });
});
