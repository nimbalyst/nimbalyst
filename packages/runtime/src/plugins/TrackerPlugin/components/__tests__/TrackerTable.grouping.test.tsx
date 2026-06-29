import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { TrackerTable } from '../TrackerTable';
import { TrackerTableGrid } from '../TrackerTableGrid';
import type { TypeColumnConfig } from '../trackerColumns';

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

afterEach(() => cleanup());

function makeItem(id: string, primaryType: string, title: string): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    issueKey: id.toUpperCase(),
    system: {
      workspace: '/ws',
      createdAt: '2026-06-29T00:00:00.000Z',
      updatedAt: '2026-06-29T00:00:00.000Z',
      lastIndexed: '2026-06-29T00:00:00.000Z',
    },
    fields: {
      title,
      status: 'to-do',
      priority: 'medium',
    },
  };
}

const groupedColumnConfig: TypeColumnConfig = {
  visibleColumns: ['type', 'key', 'title', 'status', 'priority', 'updated'],
  columnWidths: {},
  groupBy: 'type',
};

const items = [
  makeItem('bug-1', 'bug', 'First bug'),
  makeItem('task-1', 'task', 'Task work'),
  makeItem('bug-2', 'bug', 'Second bug'),
];

describe('TrackerTable grouping', () => {
  it('renders group headers in the list view when Display Options grouping is set', () => {
    render(
      <TrackerTable
        hideTypeTabs
        filterType="all"
        overrideItems={items}
        columnConfig={groupedColumnConfig}
        onColumnConfigChange={() => {}}
      />,
    );

    const headers = screen.getAllByTestId('tracker-table-group-header');
    expect(headers.map((header) => header.textContent)).toEqual(['bug2 items', 'task1 item']);
  });

  it('renders group headers in the grid view when Display Options grouping is set', () => {
    render(
      <TrackerTableGrid
        filterType="all"
        overrideItems={items}
        columnConfig={groupedColumnConfig}
        onColumnConfigChange={() => {}}
      />,
    );

    const headers = screen.getAllByTestId('tracker-table-group-header');
    expect(headers.map((header) => header.textContent)).toEqual(['bug2 items', 'task1 item']);
  });
});
