// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { loadBuiltinTrackers } from '../../models';
import { TrackerTable } from '../TrackerTable';

vi.mock('posthog-js/react', () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

function record(id: string): TrackerRecord {
  return {
    id,
    primaryType: 'bug',
    typeTags: ['bug'],
    issueKey: id.toUpperCase(),
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/ws',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastIndexed: '2026-08-01T00:00:00.000Z',
    },
    fields: { title: `Title ${id}`, status: 'to-do', priority: 'medium' },
  } as TrackerRecord;
}

describe('TrackerTable context menu trigger', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    (window as any).electronAPI = {
      documentService: { updateTrackerItem: vi.fn() },
    };
  });

  it('preserves a multi-selection when its overflow action opens the shared menu', () => {
    render(
      <TrackerTable
        filterType="bug"
        hideTypeTabs
        hideToolbar
        overrideItems={[record('bug-1'), record('bug-2')]}
      />,
    );

    const rows = screen.getAllByTestId('tracker-table-row');
    fireEvent.click(rows[0], { metaKey: true });
    fireEvent.click(rows[1], { metaKey: true });
    fireEvent.click(screen.getAllByTestId('tracker-row-more-actions')[1]);

    expect(screen.getByText('2 items selected')).toBeDefined();
  });
});
