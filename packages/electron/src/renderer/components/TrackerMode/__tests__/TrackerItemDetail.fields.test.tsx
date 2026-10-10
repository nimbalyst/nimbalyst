// @vitest-environment jsdom
/**
 * The detail pane's metadata region: the shared chip row is the canonical
 * presentation of a tracker's fields, tags stay an always-open row, and content
 * focus still hides all of it. The Pages-mode page view shares the body and
 * field hooks but none of that chrome.
 */
import { Provider } from 'jotai';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

// The file-backed body editor is only reachable in content focus, and it drags
// in the whole editor stack.
vi.mock('../../TabEditor/TabEditor', () => ({ TabEditor: () => null }));
// The page body editor: a stub that hands its config to the test, so a test
// can type into the body by driving the config's save callbacks.
const bodyEditor = vi.hoisted(() => ({ config: null as any }));
vi.mock('@nimbalyst/runtime/editor', () => ({
  NimbalystEditor: ({ config }: { config: unknown }) => {
    bodyEditor.config = config;
    return <div className="nimbalyst-editor" />;
  },
}));

// The collab body stack blocks on import outside Electron, and this pane's
// metadata region doesn't depend on it: a dormant collab result is enough.
vi.mock('../../../hooks/useTrackerContentCollab', () => ({
  trackerContentCollabKey: (itemId: string) => `tracker-body:${itemId}`,
  useTrackerContentCollab: () => ({
    collaboration: null,
    loading: false,
    status: 'disconnected',
    syncProvider: null,
    commentsConfig: null,
    providerEpoch: 0,
    bodyCacheMarkdown: null,
  }),
}));
// The page crumb reads the Pages tree from the docs session; a fixed one page
// tree stands in for the live session: Spec > Modules (where the plan type is
// placed) and Spec > Research. Folders are empty, as in a page tree.
const pageTree = vi.hoisted(() => ({ itemPlacements: null as any }));
vi.mock('../../../store/atoms/collabDocuments', async (importOriginal) => {
  const { atom: jotaiAtom } = await import('jotai');
  const itemPlacements = jotaiAtom<Array<{ itemId: string; parentId: string | null }>>([]);
  pageTree.itemPlacements = itemPlacements;
  const pagesTree = {
    atoms: {
      typePlacements: jotaiAtom([{ typeId: 'plan', parentFolderId: 'd-modules' }]),
      itemPlacements,
      sharedFolders: jotaiAtom([]),
      sharedDocuments: jotaiAtom([
        { documentId: 'd-spec', title: 'Spec', parentFolderId: null },
        { documentId: 'd-modules', title: 'Modules', parentFolderId: 'd-spec' },
        { documentId: 'd-research', title: 'Research', parentFolderId: 'd-spec' },
      ]),
    },
  };
  return {
    ...(await importOriginal<object>()),
    getElectronCollabDocsSession: () => pagesTree,
    getPersonalCollabDocsSession: () => pagesTree,
    resolveDesktopCollabScope: async () => ({ scope: { scopeKey: '/ws' }, retryable: false }),
  };
});
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { replaceAllTrackerItemsAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { TrackerItemDetail } from '../TrackerItemDetail';
import { TrackerPageView } from '../TrackerPageView';

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
  fields: {
    title: 'Chip row item',
    status: 'in-development',
    priority: 'high',
    tags: ['auth'],
    agentSessions: [{ sessionId: 'session-1' }],
  },
} as TrackerRecord;

const updateTrackerItem = vi.fn().mockResolvedValue({ success: true });
const createTrackerItem = vi.fn().mockResolvedValue({
  success: true,
  item: { id: 'mst_new', title: 'Gamma', issueKey: 'NIM-2' },
});

beforeAll(() => loadBuiltinTrackers());

beforeEach(() => {
  updateTrackerItem.mockClear();
  createTrackerItem.mockClear();
  (window as any).electronAPI = {
    invoke: vi.fn().mockResolvedValue(undefined),
    documentService: {
      updateTrackerItem,
      createTrackerItem,
      getTrackerCreationStatus: vi.fn().mockResolvedValue(null),
      updateTrackerItemInFile: vi.fn().mockResolvedValue({ success: true }),
      getTrackerItemContent: vi.fn().mockResolvedValue({ success: true, content: '' }),
      updateTrackerItemContent: vi.fn().mockResolvedValue({ success: true }),
      saveTrackerItemContent: vi.fn().mockResolvedValue({ success: true }),
    },
  };
  store.set(replaceAllTrackerItemsAtom, [ITEM]);
});

function renderDetail(props: Record<string, unknown> = {}) {
  render(
    <Provider store={store}>
      <TrackerItemDetail itemId={ITEM.id} onClose={() => {}} {...props} />
    </Provider>,
  );
}

/** The page's crumb as the header strip reads it, labels only. */
function pageCrumb(): string {
  return Array.from(screen.getByTestId('page-header-bar').querySelectorAll('.breadcrumb-segment'))
    .map((segment) => segment.lastElementChild?.textContent ?? '')
    .join(' / ');
}

function renderPage({ collabScope = { scopeKey: '/ws' } as unknown } = {}) {
  render(
    <Provider store={store}>
      <TrackerPageView itemId={ITEM.id} workspacePath="/ws" collabScope={collabScope as any} />
    </Provider>,
  );
}

describe('TrackerItemDetail metadata region', () => {
  it('renders the schema fields as chips, with tags kept as an open row', () => {
    renderDetail();

    const chips = Array.from(
      screen.getByTestId('tracker-detail-field-pills').querySelectorAll('.tracker-field-pill'),
    ).map((chip) => chip.getAttribute('data-field'));

    expect(chips).toContain('status');
    expect(chips).toContain('priority');
    expect(chips).toContain('progress');
    expect(chips).toContain('startDate');
    // Tags are edited far more often than they're read, so they stay open.
    expect(chips).not.toContain('tags');
    screen.getByTestId('tracker-detail-tags');
    // An array of objects has no one-line form: it reads below the chips.
    expect(chips).not.toContain('agentSessions');
    const overflow = document.querySelector('.tracker-detail-overflow-fields');
    expect(overflow?.textContent).toContain('Agent Sessions');
    expect(overflow?.textContent).toContain('{"sessionId":"session-1"}');
    expect(overflow?.textContent).not.toContain('[object Object]');
  });

  it('offers inline collection creation from the detail chip', async () => {
    renderDetail({ workspacePath: '/ws' });

    fireEvent.click(screen.getByTestId('tracker-detail-field-pill-collection'));
    fireEvent.change(screen.getByTestId('tracker-detail-field-collection-picker-search'), {
      target: { value: 'Gamma' },
    });
    fireEvent.click(screen.getByTestId('tracker-detail-field-collection-picker-create'));
    fireEvent.click(screen.getByTestId('tracker-detail-field-collection-picker-type-milestone'));

    await waitFor(() => expect(createTrackerItem).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Gamma', type: 'milestone', workspace: '/ws' }),
    ));
  });

  it('saves a chip edit through the item write path', async () => {
    renderDetail();

    fireEvent.click(screen.getByTestId('tracker-detail-field-pill-status'));
    fireEvent.click(screen.getByText('Completed'));

    expect(updateTrackerItem).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: ITEM.id, updates: { status: 'completed' } }),
    );
  });

  it('disables the chips for a record it cannot edit', () => {
    // A row's `source` is a plain DB string cast on read, so a document-backed
    // record with a source this build doesn't round-trip does reach the pane.
    store.set(replaceAllTrackerItemsAtom, [{
      ...ITEM,
      source: 'external',
      system: { ...ITEM.system, documentPath: 'plans/imported.md' },
    } as unknown as TrackerRecord]);

    renderDetail();

    const chip = screen.getByTestId('tracker-detail-field-pill-status') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
  });

  it('as a page shows crumb, title, filled single-valued chips with an add-field menu, body and no detail chrome', async () => {
    // The plan's collection field is the multi-valued link under test.
    expect(globalRegistry.get('plan')?.fields.find((field) => field.name === 'collection')?.multiValue).toBe(true);
    store.set(replaceAllTrackerItemsAtom, [{
      ...ITEM,
      system: {
        ...ITEM.system,
        comments: [{ id: 'c1', body: 'A comment', authorIdentity: { displayName: 'Ana' }, createdAt: 1 }],
        activity: [{ id: 'a1', action: 'created', authorIdentity: { displayName: 'Ana' }, timestamp: 1 }],
        authorIdentity: { displayName: 'Ana' },
      },
    } as unknown as TrackerRecord]);

    renderPage();

    expect(pageCrumb()).toBe('Spec / Modules / Plans / Chip row item');
    expect((screen.getByTestId('tracker-page-title') as HTMLTextAreaElement).value).toBe('Chip row item');
    const chips = Array.from(
      screen.getByTestId('tracker-page-field-pills').querySelectorAll('.tracker-field-pill'),
    ).map((chip) => chip.getAttribute('data-field'));
    // Only fields holding a value; never multi-valued ones.
    expect(chips).toEqual(['status', 'priority']);

    // The "+" lists the empty single-valued fields; picking one adds it and opens its editor.
    fireEvent.click(screen.getByTestId('tracker-page-add-field'));
    const offered = Array.from(
      screen.getByTestId('tracker-page-add-field-menu').querySelectorAll('[role="menuitem"]'),
    ).map((entry) => entry.getAttribute('data-field'));
    expect(offered).toContain('progress');
    expect(offered).toContain('startDate');
    expect(offered).not.toContain('status');
    expect(offered).not.toContain('collection');
    expect(offered).not.toContain('tags');
    fireEvent.click(screen.getByTestId('tracker-page-add-field-menu').querySelector('[data-field="startDate"]')!);
    await waitFor(() => expect(screen.getByTestId('tracker-page-field-pill-startDate').getAttribute('aria-expanded')).toBe('true'));
    screen.getByTestId('tracker-page-field-popover-startDate');

    await waitFor(() => expect(screen.getByTestId('tracker-page-body').querySelector('.nimbalyst-editor')).not.toBeNull());

    // None of the detail pane's chrome.
    expect(screen.queryByTestId('tracker-item-detail')).toBeNull();
    expect(screen.queryByTestId('tracker-detail-tags')).toBeNull();
    expect(screen.queryByTestId('tracker-content-focus-toggle')).toBeNull();
    expect(document.querySelector('.tracker-sessions-section')).toBeNull();
    expect(document.querySelector('.tracker-type-tags-editor')).toBeNull();
    expect(document.querySelector('.tracker-detail-overflow-fields')).toBeNull();
    expect(screen.queryByText('Comments')).toBeNull();
    expect(screen.queryByText('Activity')).toBeNull();
    expect(screen.queryByText('Created by')).toBeNull();
  });

  it('as a placed page, the crumb walks the parent pages of the item, not its type', () => {
    store.set(pageTree.itemPlacements, [{ itemId: ITEM.id, parentId: 'd-research' }]);
    try {
      renderPage();
      expect(pageCrumb()).toBe('Spec / Research / Chip row item');
    } finally {
      store.set(pageTree.itemPlacements, []);
    }
  });

  it('as a team page opened before Pages had a scope, the crumb still follows a move', async () => {
    // Tab content mounts once with whatever scope Pages had at that moment.
    const realGet = globalRegistry.get.bind(globalRegistry);
    const teamPlan = { ...realGet('plan')!, sharing: 'team' as const };
    const spy = vi.spyOn(globalRegistry, 'get').mockImplementation((type) => (type === 'plan' ? teamPlan : realGet(type)));
    store.set(pageTree.itemPlacements, [{ itemId: ITEM.id, parentId: 'd-modules' }]);
    try {
      renderPage({ collabScope: null });
      await waitFor(() => expect(pageCrumb()).toBe('Spec / Modules / Chip row item'));
      act(() => store.set(pageTree.itemPlacements, [{ itemId: ITEM.id, parentId: 'd-research' }]));
      expect(pageCrumb()).toBe('Spec / Research / Chip row item');
    } finally {
      spy.mockRestore();
      store.set(pageTree.itemPlacements, []);
    }
  });

  it('as a page offers the legacy description only when the body does not already hold it', async () => {
    const getContent = (window as any).electronAPI.documentService.getTrackerItemContent;
    // Created with the same text in both fields; the body re-flowed its whitespace.
    getContent.mockResolvedValue({ success: true, content: { markdown: 'Built on Yjs.\nIt syncs   pages.\n\nMore later.\n' } });
    store.set(replaceAllTrackerItemsAtom, [{ ...ITEM, fields: { ...ITEM.fields, description: 'Built on Yjs. It syncs pages.' } } as TrackerRecord]);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('tracker-page-body').querySelector('.nimbalyst-editor')).not.toBeNull());
    expect(screen.queryByText('Saved description')).toBeNull();

    // Editing that text out of the body leaves the description holding unique text.
    act(() => {
      bodyEditor.config.onGetContent(() => 'More later.\n');
      bodyEditor.config.onDirtyChange(true);
    });
    await screen.findByText('Saved description', undefined, { timeout: 3000 });
    cleanup();

    // Text that never reached the body is kept and offered.
    store.set(replaceAllTrackerItemsAtom, [{ ...ITEM, fields: { ...ITEM.fields, description: 'Only in the old field.' } } as TrackerRecord]);
    renderPage();
    await screen.findByText('Saved description');
  });

  it('as a page leaves relationship fields to Links, even single-valued ones', () => {
    // `source` on a capture is one relationship value with no predicate.
    const source = globalRegistry.get('capture')?.fields.find((field) => field.name === 'source');
    expect(source?.type).toBe('relationship');
    expect(source?.multiValue).toBe(false);
    store.set(replaceAllTrackerItemsAtom, [{
      ...ITEM,
      primaryType: 'capture',
      typeTags: ['capture'],
      fields: { title: 'A capture', source: { itemId: 'src-1', title: 'The source' } },
    } as unknown as TrackerRecord]);

    renderPage();

    expect(screen.queryByTestId('tracker-page-field-pill-source')).toBeNull();
    fireEvent.click(screen.getByTestId('tracker-page-add-field'));
    expect(screen.getByTestId('tracker-page-add-field-menu').querySelector('[data-field="source"]')).toBeNull();
  });

  it('hides the metadata region in content focus', () => {
    renderDetail({ enableContentFocus: true, contentFocus: true });

    expect(screen.queryByTestId('tracker-detail-field-pills')).toBeNull();
    expect(screen.queryByTestId('tracker-detail-tags')).toBeNull();
  });
});
