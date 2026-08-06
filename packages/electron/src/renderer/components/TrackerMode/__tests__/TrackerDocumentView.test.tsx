// @vitest-environment jsdom
/**
 * Tracker Mode's content shell: the ordinary list + detail presentation and the
 * focused document presentation (header, slim list pane, switchable right
 * panel) -- and, critically, the detail keeping its React identity across the
 * switch between them.
 */
import { useEffect, useRef } from 'react';
import { Provider } from 'jotai';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  replaceAllTrackerItemsAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { TrackerDocumentView } from '../TrackerDocumentView';
import { useSuppressedDocumentHeaderProviderIds } from '../../TabEditor/DocumentHeaderSuppressionContext';
import { setTrackerModeLayoutAtom, trackerModeLayoutAtom } from '../../../store/atoms/trackers';
import { WindowTopBar } from '../../WindowTopBar/WindowTopBar';

// The panel itself pulls the whole chat stack in; this shell only cares that
// the right surface is mounted where the layout says it is.
vi.mock('../TrackerDocumentPanel', () => ({
  TrackerDocumentPanel: ({ mode }: { mode: string }) => (
    <div data-testid="stub-right-panel" data-mode={mode}>panel</div>
  ),
}));

vi.mock('../TrackerDocumentFieldPills', () => ({
  TrackerDocumentFieldPills: () => <div data-testid="stub-field-pills">fields</div>,
}));

// Same reason: the document header bar drags in the editor/AI/shared-doc stack.
// Its own behavior is covered by TrackerDocumentHeaderMeta's tests.
vi.mock('../../TabEditor/UnifiedEditorHeaderBar', () => ({
  UnifiedEditorHeaderBar: ({ breadcrumbContent }: { breadcrumbContent?: React.ReactNode }) => (
    <div data-testid="stub-document-header-bar">{breadcrumbContent}</div>
  ),
}));

const ITEM = {
  id: 'item-a',
  primaryType: 'plan',
  typeTags: ['plan'],
  issueKey: 'NIM-1',
  source: 'native',
  archived: false,
  syncStatus: 'local',
  system: {
    workspace: '/ws',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  },
  fields: { title: 'Document item', status: 'in-progress' },
} as TrackerRecord;

beforeAll(() => loadBuiltinTrackers());

beforeEach(() => {
  (window as any).electronAPI = { invoke: vi.fn().mockResolvedValue(undefined) };
  store.set(replaceAllTrackerItemsAtom, [ITEM]);
  store.set(setTrackerModeLayoutAtom, {
    selectedType: 'all',
    selectedItemId: ITEM.id,
    itemViews: { [ITEM.id]: 'document' },
    viewMode: 'list',
    documentListPaneVisible: true,
    documentRightPanelVisible: true,
    documentRightPanelMode: 'chat',
  });
});

function renderView(overrides: Partial<Parameters<typeof TrackerDocumentView>[0]> = {}) {
  const onCollapseToTracker = vi.fn();
  const presentation = overrides.presentation ?? 'document';
  const documentItemId = overrides.documentItemId === undefined
    ? ITEM.id
    : overrides.documentItemId;
  store.set(setTrackerModeLayoutAtom, presentation === 'document' && documentItemId
    ? {
        selectedItemId: documentItemId,
        itemViews: { [documentItemId]: 'document' },
      }
    : {
        selectedItemId: documentItemId,
        itemViews: {},
      });
  const utils = render(
    <Provider store={store}>
    <WindowTopBar
      workspaceName="Repo"
      activeModeLabel="Tracker"
      gitStatus={null}
      gitActions={{ onPull: () => {}, onPush: () => {}, onOpenLog: () => {} }}
    />
    <TrackerDocumentView
      presentation={presentation}
      documentItemId={documentItemId}
      workspacePath="/ws"
      itemChrome={<div data-testid="stub-toolbar">toolbar</div>}
      listPane={<div data-testid="stub-list">list</div>}
      detail={<div data-testid="stub-document">document</div>}
      detailPanelWidth={400}
      onDetailPanelWidthChange={vi.fn()}
      onCollapseToTracker={onCollapseToTracker}
      {...overrides}
    />
    </Provider>,
  );
  return { onCollapseToTracker, ...utils };
}

describe('TrackerDocumentView', () => {
  it('mounts the list-pane search between the pane header and the list, document view only', () => {
    const { unmount } = renderView({
      listPaneSearch: <div data-testid="stub-list-search">search</div>,
    });

    const listPane = screen.getByTestId('tracker-document-list-pane');
    const search = screen.getByTestId('stub-list-search');
    expect(listPane.contains(search)).toBe(true);
    expect(search.compareDocumentPosition(screen.getByTestId('stub-list')))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    unmount();

    // The ordinary presentation keeps its toolbar search; no second box.
    renderView({
      presentation: 'item',
      documentItemId: null,
      listPaneSearch: <div data-testid="stub-list-search">search</div>,
    });
    expect(screen.queryByTestId('stub-list-search')).toBeNull();
  });

  it('lets the list pane reach the top and keeps selected-item chrome over the document', () => {
    renderView();

    const listPane = screen.getByTestId('tracker-document-list-pane');
    const listHeader = screen.getByTestId('tracker-document-list-pane-header');
    const detailRegion = screen.getByTestId('tracker-detail-region');
    const documentHeader = screen.getByTestId('tracker-document-view-header');
    expect(listPane.contains(listHeader)).toBe(true);
    expect(detailRegion.contains(documentHeader)).toBe(true);
    expect(listPane.contains(documentHeader)).toBe(false);
    screen.getByTestId('stub-list');
    screen.getByTestId('stub-document');
    screen.getByTestId('tracker-document-list-pane-resize');
    // The ordinary presentation's toolbar stands down for the focused header.
    expect(screen.queryByTestId('stub-toolbar')).toBeNull();
  });

  it('renders the toolbar and no focused header in the item presentation', () => {
    renderView({ presentation: 'item', documentItemId: null });

    screen.getByTestId('stub-toolbar');
    expect(screen.queryByTestId('tracker-document-view-header')).toBeNull();
    expect(screen.queryByTestId('stub-right-panel')).toBeNull();
    screen.getByTestId('stub-document');
  });

  it('collapses and restores the list pane from the window top bar', () => {
    renderView();

    expect(screen.queryByTestId('tracker-document-list-pane-toggle')).toBeNull();
    fireEvent.click(screen.getByTestId('window-top-bar-left-pane'));
    expect(screen.queryByTestId('tracker-document-list-pane')).toBeNull();
    expect(screen.queryByTestId('tracker-document-list-pane-resize')).toBeNull();
    // The document stays put -- collapsing the list must not disturb it.
    screen.getByTestId('stub-document');

    fireEvent.click(screen.getByTestId('window-top-bar-left-pane'));
    screen.getByTestId('tracker-document-list-pane');
  });

  it('reports the collapse-to-tracker action to its host', () => {
    const { onCollapseToTracker } = renderView();

    fireEvent.click(screen.getByTestId('tracker-document-collapse'));
    expect(onCollapseToTracker).toHaveBeenCalledTimes(1);
  });

  it('puts the shared tracker link action in the expanded document header', () => {
    const onCopyDocumentLink = vi.fn();
    renderView({ onCopyDocumentLink });

    fireEvent.click(screen.getByTestId('tracker-document-copy-link'));
    expect(onCopyDocumentLink).toHaveBeenCalledTimes(1);
  });

  it('puts a labelled back button in the list pane and keeps the close button in the document header', () => {
    const { onCollapseToTracker } = renderView();

    const listHeader = screen.getByTestId('tracker-document-list-pane-header');
    const header = screen.getByTestId('tracker-document-view-header');
    const back = screen.getByTestId('tracker-document-back');
    const close = screen.getByTestId('tracker-document-collapse');
    expect(listHeader.contains(back)).toBe(true);
    expect(header.contains(back)).toBe(false);
    expect(back.textContent).toContain('arrow_back');
    expect(back.textContent).toContain('Back to tracker');
    expect(screen.getByTestId('tracker-document-title')
      .compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(back);
    expect(onCollapseToTracker).toHaveBeenCalledTimes(1);
  });

  it('tells the document editor the header already shows the tracker fields', () => {
    const suppression = { document: [] as readonly string[], item: [] as readonly string[] };
    const Probe: React.FC<{ into: 'document' | 'item' }> = ({ into }) => {
      suppression[into] = useSuppressedDocumentHeaderProviderIds();
      return <div data-testid="stub-document">document</div>;
    };

    const documentView = renderView({ detail: <Probe into="document" /> });
    // The chips in the header above are the same Status/Priority/Owner form the
    // in-document plan header would draw, so the editor drops its copy.
    expect(suppression.document).toEqual(['tracker-document-header']);
    documentView.unmount();

    renderView({
      presentation: 'item',
      documentItemId: null,
      detail: <Probe into="item" />,
    });
    expect(suppression.item).toEqual([]);
  });

  it('exits document view on Escape', () => {
    const { onCollapseToTracker } = renderView();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCollapseToTracker).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone outside document view and while a menu is open', () => {
    const { onCollapseToTracker, unmount } = renderView({
      presentation: 'item',
      documentItemId: null,
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCollapseToTracker).not.toHaveBeenCalled();
    unmount();

    const documentView = renderView();
    // The top-bar panel picker is a menu: Escape closes it, it does not leave the view.
    fireEvent.click(screen.getByTestId('window-top-bar-right-pane-menu-button'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(documentView.onCollapseToTracker).not.toHaveBeenCalled();
  });

  it('shows the right panel after the document and hides it from the top bar', () => {
    renderView();

    const panel = screen.getByTestId('tracker-document-right-panel');
    const document_ = screen.getByTestId('tracker-detail-region');
    expect(document_.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    screen.getByTestId('tracker-document-right-panel-resize');

    fireEvent.click(screen.getByTestId('window-top-bar-right-pane'));
    expect(screen.queryByTestId('tracker-document-right-panel')).toBeNull();
    expect(store.get(trackerModeLayoutAtom).documentRightPanelVisible).toBe(false);
  });

  it('persists the panel surface, and picking one re-shows a hidden panel', () => {
    renderView();

    fireEvent.click(screen.getByTestId('window-top-bar-right-pane'));
    fireEvent.click(screen.getByTestId('window-top-bar-right-pane-menu-button'));
    fireEvent.click(screen.getByText('Discussion'));

    const layout = store.get(trackerModeLayoutAtom);
    expect(layout.documentRightPanelMode).toBe('discussion');
    expect(layout.documentRightPanelVisible).toBe(true);
    expect(screen.getByTestId('stub-right-panel').getAttribute('data-mode')).toBe('discussion');
  });

  it('labels the standard chat surface as chat about this item', () => {
    renderView();

    fireEvent.click(screen.getByTestId('window-top-bar-right-pane-menu-button'));
    screen.getByText('Chat about this item');
  });

  it('shows pane controls only for Tracker document view', () => {
    const { unmount } = renderView();
    screen.getByTestId('window-top-bar-left-pane');
    screen.getByTestId('window-top-bar-right-pane');
    unmount();

    renderView({ presentation: 'item', documentItemId: null });
    expect(screen.queryByTestId('window-top-bar-left-pane')).toBeNull();
    expect(screen.queryByTestId('window-top-bar-right-pane')).toBeNull();
  });

  it('navigates the type breadcrumb back to that type list', () => {
    renderView();

    fireEvent.click(screen.getByTestId('tracker-document-type-navigation'));

    const layout = store.get(trackerModeLayoutAtom);
    expect(layout.selectedType).toBe('plan');
    expect(layout.viewMode).toBe('list');
    expect(layout.selectedItemId).toBeNull();
    expect(layout.itemViews[ITEM.id]).toBeUndefined();
    expect(screen.queryByTestId('window-top-bar-left-pane')).toBeNull();
    expect(screen.queryByTestId('window-top-bar-right-pane')).toBeNull();
  });

  it('keeps the detail mounted across the presentation switch', () => {
    const mounts = { count: 0 };
    const nodes: HTMLElement[] = [];
    const Probe: React.FC = () => {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => {
        mounts.count += 1;
        if (ref.current) nodes.push(ref.current);
      }, []);
      return <div ref={ref} data-testid="probe-detail" />;
    };

    // One element instance handed to both presentations, exactly as
    // TrackerMainView does it.
    const detail = <Probe />;
    const { rerender } = renderView({ presentation: 'item', documentItemId: null, detail });
    expect(mounts.count).toBe(1);

    rerender(
      <Provider store={store}>
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Tracker"
        gitStatus={null}
        gitActions={{ onPull: () => {}, onPush: () => {}, onOpenLog: () => {} }}
      />
      <TrackerDocumentView
        presentation="document"
        documentItemId="item-a"
        workspacePath="/ws"
        itemChrome={<div data-testid="stub-toolbar">toolbar</div>}
        listPane={<div data-testid="stub-list">list</div>}
        detail={detail}
        detailPanelWidth={400}
        onDetailPanelWidthChange={vi.fn()}
        onCollapseToTracker={vi.fn()}
      />
      </Provider>,
    );

    screen.getByTestId('tracker-document-view-header');
    expect(mounts.count).toBe(1);
    expect(nodes).toHaveLength(1);
    expect(screen.getByTestId('probe-detail')).toBe(nodes[0]);
  });
});
