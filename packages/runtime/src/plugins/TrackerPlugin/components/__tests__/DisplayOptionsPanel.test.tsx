/**
 * The Display Settings panel and the selects inside it are separate floating
 * layers, so a press inside the grouping dropdown must not read as a press
 * outside the panel — that dismissal used to unmount the option before its
 * click landed, making grouping unpickable.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DisplayOptionsPanel } from '../DisplayOptionsPanel';
import type { TrackerColumnDef, TypeColumnConfig } from '../trackerColumns';

vi.mock('../../../../ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));

const availableColumns: TrackerColumnDef[] = [
  { id: 'title', label: 'Title', defaultVisible: true },
  { id: 'status', label: 'Status', defaultVisible: true },
] as TrackerColumnDef[];

function renderPanel() {
  const onGroupByChange = vi.fn();
  const onClose = vi.fn();
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const utils = render(
    <DisplayOptionsPanel
      availableColumns={availableColumns}
      config={{ visibleColumns: ['title'], columnWidths: {} }}
      onConfigChange={vi.fn()}
      onClose={onClose}
      anchorElement={anchor}
      groupBy="none"
      onGroupByChange={onGroupByChange}
      showColumnProperties={false}
    />,
  );
  return { onGroupByChange, onClose, anchor, ...utils };
}

describe('DisplayOptionsPanel grouping select', () => {
  it('selects a grouping option instead of dismissing the panel', async () => {
    const { onGroupByChange, onClose } = renderPanel();

    fireEvent.click(within(screen.getByTestId('tracker-display-group-by')).getByRole('button'));
    const option = await screen.findByRole('button', { name: 'Status' });

    fireEvent.mouseDown(option);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(option);
    expect(onGroupByChange).toHaveBeenCalledWith('status');
  });

  it('still closes when the press lands outside every layer', () => {
    const { onClose } = renderPanel();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * A workspace running dozens of custom types cannot tell its rows apart by glyph,
 * so the Type column can print the type's name instead (nimbalyst#1422). The
 * choice belongs to the saved view, and icon stays the default.
 */
describe('DisplayOptionsPanel type column display', () => {
  const typeColumns = [
    { id: 'type', label: 'Type', defaultVisible: true },
    ...availableColumns,
  ] as TrackerColumnDef[];

  function renderWithTypeColumn(config: TypeColumnConfig) {
    const onConfigChange = vi.fn();
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    render(
      <DisplayOptionsPanel
        availableColumns={typeColumns}
        config={config}
        onConfigChange={onConfigChange}
        onClose={vi.fn()}
        anchorElement={anchor}
      />,
    );
    return { onConfigChange };
  }

  it('switches the Type column to names without disturbing the rest of the config', async () => {
    const { onConfigChange } = renderWithTypeColumn({
      visibleColumns: ['type', 'title'],
      columnWidths: { title: 300 },
    });

    fireEvent.click(within(screen.getByTestId('tracker-display-type-column')).getByRole('button'));
    fireEvent.click(await screen.findByRole('button', { name: 'Name' }));

    expect(onConfigChange).toHaveBeenCalledWith({
      visibleColumns: ['type', 'title'],
      columnWidths: { title: 300 },
      typeColumnDisplay: 'label',
    });
  });

  it('is not offered when the Type column is hidden', () => {
    renderWithTypeColumn({ visibleColumns: ['title'], columnWidths: {} });
    expect(screen.queryByTestId('tracker-display-type-column')).toBeNull();
  });
});
