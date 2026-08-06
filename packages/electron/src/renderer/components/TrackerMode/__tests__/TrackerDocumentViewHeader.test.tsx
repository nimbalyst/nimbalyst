// @vitest-environment jsdom
import { Provider } from 'jotai';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  globalRegistry,
  type TrackerDataModel,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  replaceAllTrackerItemsAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import {
  TrackerDocumentListPaneHeader,
  TrackerDocumentViewHeader,
} from '../TrackerDocumentViewHeader';
import { TrackerDocumentFieldPills } from '../TrackerDocumentFieldPills';

function renderHeader(
  overrides: Partial<Parameters<typeof TrackerDocumentViewHeader>[0]> = {},
) {
  const onCollapseToTracker = vi.fn();
  render(
    <TrackerDocumentViewHeader
      issueKey="NIM-1647"
      title="Linear-Style Tracker Views and Filtering Plan"
      fieldPills={<span data-testid="stub-field-pills">In Progress</span>}
      onCollapseToTracker={onCollapseToTracker}
      {...overrides}
    />,
  );
  return { onCollapseToTracker };
}

describe('TrackerDocumentViewHeader', () => {
  afterEach(() => {
    globalRegistry.unregister('documentPillSpec');
    store.set(replaceAllTrackerItemsAtom, []);
  });

  it('identifies the selected item with its key, title and field pills', () => {
    renderHeader();

    const header = screen.getByTestId('tracker-document-view-header');
    expect(header.textContent).toContain('Expanded tracker content');
    expect(screen.getByTestId('tracker-document-issue-key').textContent).toBe('NIM-1647');
    expect(screen.getByTestId('tracker-document-title').textContent)
      .toBe('Linear-Style Tracker Views and Filtering Plan');
    expect(screen.getByTestId('tracker-document-header-field-pills').textContent)
      .toContain('In Progress');
    expect(screen.queryByTestId('tracker-document-status')).toBeNull();
  });

  it('puts clickable collection and type navigation in the list-pane header', () => {
    const onCollapseToTracker = vi.fn();
    const onNavigateToTypeList = vi.fn();
    render(
      <TrackerDocumentListPaneHeader
        collectionLabel="Trackers"
        typeLabel="Tasks"
        onCollapseToTracker={onCollapseToTracker}
        onNavigateToTypeList={onNavigateToTypeList}
      />,
    );

    const back = screen.getByTestId('tracker-document-back');
    const breadcrumb = screen.getByTestId('tracker-document-list-breadcrumb');
    expect(back.textContent).toContain('arrow_back');
    expect(back.textContent).toContain('Back to tracker');
    expect(breadcrumb.textContent).toContain('Trackers');
    expect(breadcrumb.textContent).toContain('Tasks');

    fireEvent.click(back);
    fireEvent.click(screen.getByTestId('tracker-document-collection-navigation'));
    fireEvent.click(screen.getByTestId('tracker-document-type-navigation'));
    expect(onCollapseToTracker).toHaveBeenCalledTimes(1);
    expect(onNavigateToTypeList).toHaveBeenCalledTimes(2);
  });

  it('keeps pane and collection-navigation controls out of the document header', () => {
    const { onCollapseToTracker } = renderHeader();

    expect(screen.queryByTestId('tracker-document-list-pane-toggle')).toBeNull();
    expect(screen.queryByTestId('tracker-document-right-panel-toggle')).toBeNull();
    expect(screen.queryByTestId('tracker-document-right-panel-menu-button')).toBeNull();
    expect(screen.queryByTestId('tracker-document-type-navigation')).toBeNull();
    expect(screen.queryByTestId('tracker-document-collection-navigation')).toBeNull();
    fireEvent.click(screen.getByTestId('tracker-document-collapse'));
    expect(onCollapseToTracker).toHaveBeenCalledTimes(1);
  });

  it('keeps the document-header exit as a trailing close', () => {
    const { onCollapseToTracker } = renderHeader();

    const close = screen.getByTestId('tracker-document-collapse');
    expect(screen.queryByTestId('tracker-document-back')).toBeNull();
    expect(close.getAttribute('aria-label')).toBe('Collapse to tracker');
    expect(close.getAttribute('title')).toContain('Esc');

    fireEvent.click(close);
    expect(onCollapseToTracker).toHaveBeenCalledTimes(1);
  });

  it('shows a copy-link button for a shared tracker and reports the action', () => {
    const onCopyDocumentLink = vi.fn();
    renderHeader({ onCopyDocumentLink });

    const copyLink = screen.getByTestId('tracker-document-copy-link');
    expect(copyLink.getAttribute('aria-label')).toBe('Copy collaborative tracker link');
    expect(copyLink.getAttribute('title')).toBe('Copy collaborative tracker link');

    fireEvent.click(copyLink);
    expect(onCopyDocumentLink).toHaveBeenCalledTimes(1);
  });

  it('keeps the document header to one icon-only exit', () => {
    renderHeader();

    const header = screen.getByTestId('tracker-document-view-header');
    const exits = header.querySelectorAll('button');
    expect(exits.length).toBe(1);
    expect(header.textContent).not.toContain('Collapse to tracker');
    expect(header.textContent).not.toContain('Back to tracker');
  });

  it('omits shared-tracker actions when no collaborative link is available', () => {
    renderHeader();

    // Local trackers have no organization-scoped collaborative URL to copy.
    expect(screen.queryByTestId('tracker-document-breadcrumb')).toBeNull();
    expect(screen.queryByTestId('tracker-collab-sync-dot')).toBeNull();
    expect(screen.queryByTestId('tracker-document-copy-link')).toBeNull();
  });

  it('omits the key when the record has none', () => {
    renderHeader({ issueKey: null });

    expect(screen.queryByTestId('tracker-document-issue-key')).toBeNull();
  });

  it('renders schema fields as editable pills and absorbs workflow status', async () => {
    const model: TrackerDataModel = {
      type: 'documentPillSpec',
      displayName: 'Spec',
      displayNamePlural: 'Specs',
      icon: 'assignment',
      color: 'var(--nim-primary)',
      modes: { inline: true, fullDocument: true },
      idPrefix: 'DPS',
      idFormat: 'ulid',
      sync: { mode: 'local', scope: 'workspace' },
      fields: [
        { name: 'title', type: 'string', required: true },
        {
          name: 'state',
          type: 'select',
          options: [
            { value: 'open', label: 'Open', icon: 'radio_button_checked' },
            { value: 'done', label: 'Done', icon: 'check_circle' },
          ],
        },
        { name: 'priority', type: 'select', options: [{ value: 'high', label: 'High' }] },
        { name: 'owner', type: 'user' },
        { name: 'tags', type: 'array' },
        { name: 'estimate', type: 'number' },
        { name: 'description', type: 'text' },
      ],
      roles: {
        title: 'title',
        workflowStatus: 'state',
        priority: 'priority',
        assignee: 'owner',
        tags: 'tags',
      },
    };
    globalRegistry.register(model);
    const item = {
      id: 'pill-item',
      primaryType: model.type,
      typeTags: [model.type],
      issueKey: 'DPS-1',
      source: 'native',
      archived: false,
      syncStatus: 'local',
      system: {
        workspace: '/ws',
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
      },
      fields: {
        title: 'Pill item',
        state: 'open',
        priority: 'high',
        owner: '',
        tags: ['design'],
        estimate: 3,
        description: 'Long-form content stays out of the header.',
      },
    } as TrackerRecord;
    store.set(replaceAllTrackerItemsAtom, [item]);
    const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
    (window as any).electronAPI = {
      invoke: vi.fn().mockResolvedValue(undefined),
      documentService: { updateTrackerItem },
    };

    render(
      <Provider store={store}>
        <TrackerDocumentViewHeader
          issueKey="DPS-1"
          title="Pill item"
          fieldPills={
            <TrackerDocumentFieldPills itemId={item.id} />
          }
          onCollapseToTracker={() => {}}
        />
      </Provider>,
    );

    expect(screen.getByTestId('tracker-document-field-pill-state').textContent).toContain('Open');
    expect(screen.getByTestId('tracker-document-field-pill-owner').getAttribute('data-empty'))
      .toBe('true');
    expect(screen.getByTestId('tracker-document-field-pill-tags').textContent)
      .toContain('design');
    expect(screen.getByTestId('tracker-document-field-pill-estimate').textContent)
      .toContain('3');
    expect(screen.queryByTestId('tracker-document-field-pill-description')).toBeNull();
    expect(screen.queryByTestId('tracker-document-status')).toBeNull();

    fireEvent.click(screen.getByTestId('tracker-document-field-pill-state'));
    expect(document.querySelector('.custom-select-trigger')).toBeNull();
    fireEvent.click(screen.getByText('Done'));
    await waitFor(() => {
      expect(updateTrackerItem).toHaveBeenCalledWith({
        itemId: item.id,
        updates: { state: 'done' },
        syncMode: 'local',
      });
    });
  });
});
