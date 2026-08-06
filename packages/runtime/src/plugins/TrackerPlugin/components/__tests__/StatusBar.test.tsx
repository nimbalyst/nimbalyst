import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { globalRegistry } from '../../models';
import type { TrackerDataModel } from '../../models/TrackerDataModel';
import { StatusBar } from '../StatusBar';

const model: TrackerDataModel = {
  type: 'statusBarPlan',
  displayName: 'Plan',
  displayNamePlural: 'Plans',
  icon: 'flag',
  color: '#3b82f6',
  modes: { inline: true, fullDocument: true },
  idPrefix: 'SBP',
  idFormat: 'ulid',
  sync: { mode: 'local', scope: 'project' },
  fields: [
    { name: 'title', type: 'string', required: true },
    {
      name: 'status',
      type: 'select',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'completed', label: 'Completed' },
      ],
    },
    { name: 'progress', type: 'number', min: 0, max: 100 },
    { name: 'owner', type: 'user' },
    {
      name: 'collection',
      type: 'relationship',
      relationshipTypeKey: 'in-collection',
      targetTrackerTypes: ['milestone'],
      multiValue: true,
    },
    { name: 'created', type: 'datetime', readOnly: true },
    { name: 'updated', type: 'datetime', readOnly: true },
  ],
  roles: { title: 'title', workflowStatus: 'status', assignee: 'owner', progress: 'progress' },
};

function renderStatusBar(data: Record<string, unknown> = {}) {
  globalRegistry.register(model);
  const onChange = vi.fn();
  render(<StatusBar model={model} data={data} onChange={onChange} />);
  return { onChange };
}

describe('StatusBar', () => {
  it('renders the tracker fields as a chip row and writes one field per change', () => {
    const { onChange } = renderStatusBar({ status: 'draft', progress: 40 });

    screen.getByTestId('tracker-status-bar-field-pills');
    expect(screen.getByTestId('tracker-status-bar-field-pill-status').textContent).toContain('Draft');
    expect(screen.getByTestId('tracker-status-bar-field-pill-progress').textContent).toContain('40');

    fireEvent.click(screen.getByTestId('tracker-status-bar-field-pill-status'));
    expect(screen.getByTestId('tracker-status-bar-field-popover-header-status').textContent)
      .toBe('Status');

    fireEvent.click(screen.getByText('Completed'));
    expect(onChange).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('leaves the created and updated timestamps to the document, not the header', () => {
    renderStatusBar({
      status: 'draft',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-02-01T00:00:00.000Z',
    });

    expect(screen.queryByTestId('tracker-status-bar-field-pill-created')).toBeNull();
    expect(screen.queryByTestId('tracker-status-bar-field-pill-updated')).toBeNull();
    expect(screen.queryByText(/Created/)).toBeNull();
    expect(screen.queryByText(/Updated/)).toBeNull();
  });

  it('collapses to the title and restores the chips', () => {
    renderStatusBar({ status: 'draft' });

    fireEvent.click(screen.getByRole('button', { name: 'Collapse status bar' }));
    expect(screen.queryByTestId('tracker-status-bar-field-pills')).toBeNull();
    screen.getByText('Plan');

    fireEvent.click(screen.getByRole('button', { name: 'Expand status bar' }));
    screen.getByTestId('tracker-status-bar-field-pills');
  });

  it('keeps the issue-key chip clickable without collapsing the header', () => {
    globalRegistry.register(model);
    const onOpen = vi.fn();
    render(
      <StatusBar
        model={model}
        data={{ status: 'draft' }}
        onChange={() => {}}
        trackerItemLink={{ label: 'NIM-42', title: 'Roadmap', onOpen }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open tracker item NIM-42' }));

    expect(onOpen).toHaveBeenCalledOnce();
    screen.getByTestId('tracker-status-bar-field-pills');
  });

  it('forwards people, relationship, navigation, and creation capabilities to the chips', () => {
    globalRegistry.register(model);
    const onOpenItem = vi.fn();
    const onCreateCollection = vi.fn();
    render(
      <StatusBar
        model={model}
        data={{ owner: '', collection: [{ itemId: 'mst_1', title: 'Alpha' }] }}
        onChange={() => {}}
        teamMembers={[{ email: 'ada@example.com', name: 'Ada' }]}
        relationshipCandidates={new Map([[
          'collection',
          [{ itemId: 'mst_1', title: 'Alpha', trackerType: 'milestone' }],
        ]])}
        onOpenItem={onOpenItem}
        onCreateCollection={onCreateCollection}
      />,
    );

    fireEvent.click(screen.getByTestId('tracker-status-bar-field-pill-owner'));
    screen.getByText('Ada');

    fireEvent.click(screen.getByTestId('tracker-status-bar-field-pill-collection'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Alpha' })[0]);
    expect(onOpenItem).toHaveBeenCalledWith('mst_1');
    fireEvent.change(screen.getByTestId('tracker-status-bar-field-collection-picker-search'), {
      target: { value: 'New milestone' },
    });
    screen.getByTestId('tracker-status-bar-field-collection-picker-create');
  });
});
