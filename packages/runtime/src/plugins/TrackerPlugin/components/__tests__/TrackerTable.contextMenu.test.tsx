// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import type { TrackerRecord } from '../../../../core/TrackerRecord';
import { globalRegistry, loadBuiltinTrackers } from '../../models';
import { trackerItemsMapAtom } from '../../trackerDataAtoms';
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

describe('TrackerTable delete confirmation', () => {
  beforeAll(() => loadBuiltinTrackers());

  beforeEach(() => {
    (window as any).electronAPI = {
      documentService: { updateTrackerItem: vi.fn() },
    };
  });

  function renderSelected(props: Record<string, unknown>) {
    render(
      <TrackerTable
        filterType="bug"
        hideTypeTabs
        hideToolbar
        overrideItems={[record('bug-1'), record('bug-2')]}
        {...props}
      />,
    );
    const rows = screen.getAllByTestId('tracker-table-row');
    fireEvent.click(rows[0], { metaKey: true });
    fireEvent.click(rows[1], { metaKey: true });
  }

  it('deletes from the context menu only after the host confirms', async () => {
    const onDeleteItems = vi.fn();
    const confirmDelete = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const nativeConfirm = vi.spyOn(window, 'confirm');
    renderSelected({ onDeleteItems, confirmDelete });

    fireEvent.click(screen.getAllByTestId('tracker-row-more-actions')[1]);
    fireEvent.click(screen.getByTestId('tracker-row-context-delete'));
    await waitFor(() => expect(confirmDelete).toHaveBeenCalledWith(2));
    expect(onDeleteItems).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTestId('tracker-row-more-actions')[1]);
    fireEvent.click(screen.getByTestId('tracker-row-context-delete'));
    await waitFor(() => expect(onDeleteItems).toHaveBeenCalledWith(['bug-1', 'bug-2']));
    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it('deletes on Cmd+Delete only after the host confirms', async () => {
    const onDeleteItems = vi.fn();
    const confirmDelete = vi.fn().mockResolvedValue(true);
    renderSelected({ onDeleteItems, confirmDelete });

    fireEvent.keyDown(document.querySelector('.tracker-table-container')!, { key: 'Delete', metaKey: true });
    await waitFor(() => expect(onDeleteItems).toHaveBeenCalledWith(['bug-1', 'bug-2']));
    expect(confirmDelete).toHaveBeenCalledWith(2);
  });

  it('refuses to delete without a host confirm rather than raising a native dialog', async () => {
    const onDeleteItems = vi.fn();
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderSelected({ onDeleteItems });

    fireEvent.keyDown(document.querySelector('.tracker-table-container')!, { key: 'Delete', metaKey: true });
    fireEvent.click(screen.getAllByTestId('tracker-row-more-actions')[1]);
    expect(screen.queryByTestId('tracker-row-context-delete')).toBeNull();
    await Promise.resolve();
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(onDeleteItems).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });
});

describe('TrackerTable collection cell', () => {
  beforeAll(() => loadBuiltinTrackers());

  it('names a collection from the live record, not the link snapshot', () => {
    const milestone = {
      ...record('mst_1'),
      primaryType: 'milestone',
      typeTags: ['milestone'],
      fields: { title: 'Onboarding' },
    } as TrackerRecord;
    getDefaultStore().set(trackerItemsMapAtom, new Map([[milestone.id, milestone]]));

    const bug = record('bug-1');
    // A link written from the milestone's side carries no title, so the cell
    // would otherwise read as the raw item id.
    bug.fields.collection = [{ itemId: 'mst_1', trackerType: 'milestone' }];

    render(
      <TrackerTable
        filterType="bug"
        hideTypeTabs
        hideToolbar
        overrideItems={[bug]}
        columnConfig={{ visibleColumns: ['title', 'collection'], columnWidths: {} }}
      />,
    );

    expect(screen.getByText('Onboarding')).toBeDefined();
    expect(screen.queryByText('mst_1')).toBeNull();
  });
});

/**
 * The Type column read a hardcoded map of the seven built-in types, so every row
 * of a custom type rendered an empty glyph -- the reporter in nimbalyst#1422 runs
 * ~30 of them. Identity now comes from the type's own schema, and the column can
 * print the type name instead of a glyph.
 */
describe('TrackerTable type column', () => {
  beforeAll(() => loadBuiltinTrackers());

  const customType = {
    type: 'securityReview',
    displayName: 'Security Review',
    displayNamePlural: 'Security Reviews',
    icon: 'shield_lock',
    color: '#dc2626',
    modes: { inline: true, fullDocument: false },
    idPrefix: 'SEC',
    idFormat: 'ulid',
    fields: [{ name: 'title', type: 'string', required: true }],
    roles: { title: 'title' },
  } as const;

  function customItem(): TrackerRecord {
    return {
      ...record('sec-1'),
      primaryType: 'securityReview',
      typeTags: ['securityReview'],
      fields: { title: 'Review the auth flow' },
    } as TrackerRecord;
  }

  function renderTypeColumn(typeColumnDisplay?: 'icon' | 'label') {
    globalRegistry.register(customType as any);
    const { container } = render(
      <TrackerTable
        filterType={'securityReview' as any}
        hideTypeTabs
        hideToolbar
        overrideItems={[customItem()]}
        columnConfig={{ visibleColumns: ['type', 'title'], columnWidths: {}, typeColumnDisplay }}
      />,
    );
    return container.querySelector('.tracker-type-indicator');
  }

  it('draws the icon the custom type declares rather than an empty glyph', () => {
    expect(renderTypeColumn()?.textContent).toBe('shield_lock');
  });

  it('draws the type name when the view asks for names', () => {
    expect(renderTypeColumn('label')?.textContent).toBe('Security Review');
  });
});
