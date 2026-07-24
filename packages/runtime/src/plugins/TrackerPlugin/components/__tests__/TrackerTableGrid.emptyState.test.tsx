import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { TrackerTableGrid } from '../TrackerTableGrid';

function trackerRecord(title: string): TrackerRecord {
  return {
    id: 'bug_1',
    issueKey: 'NIM-1',
    issueNumber: 1,
    primaryType: 'bug',
    typeTags: ['bug'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    fields: { title, status: 'to-do', priority: 'medium' },
    system: {
      workspace: '/workspace',
      createdAt: '2026-07-11T12:00:00.000Z',
      updatedAt: '2026-07-11T12:00:00.000Z',
      lastIndexed: '2026-07-11T12:00:00.000Z',
    },
  };
}

describe('TrackerTableGrid filtered empty state', () => {
  it('offers to clear filters when a search has no matches', () => {
    const onClearFilters = vi.fn();
    const onNewItem = vi.fn();

    render(
      <TrackerTableGrid
        filterType="bug"
        overrideItems={[trackerRecord('Visible tracker')]}
        searchQuery="missing"
        onClearFilters={onClearFilters}
        onNewItem={onNewItem}
      />,
    );

    expect(screen.getByText('No tracker items match your filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: /New Bug/ }));
    expect(onNewItem).toHaveBeenCalledWith('bug');
  });
});
