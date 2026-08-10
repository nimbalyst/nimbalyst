// @vitest-environment jsdom
/**
 * The detail pane's metadata region: the shared chip row is the canonical
 * presentation of a tracker's fields, tags stay an always-open row, and content
 * focus still hides all of it.
 */
import { Provider } from 'jotai';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';

// The file-backed body editor is only reachable in content focus, and it drags
// in the whole editor stack.
vi.mock('../../TabEditor/TabEditor', () => ({ TabEditor: () => null }));

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
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { replaceAllTrackerItemsAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { TrackerItemDetail } from '../TrackerItemDetail';

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
      updateTrackerItemInFile: vi.fn().mockResolvedValue({ success: true }),
      getTrackerItemContent: vi.fn().mockResolvedValue({ success: true, content: '' }),
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

  it('hides the metadata region in content focus', () => {
    renderDetail({ enableContentFocus: true, contentFocus: true });

    expect(screen.queryByTestId('tracker-detail-field-pills')).toBeNull();
    expect(screen.queryByTestId('tracker-detail-tags')).toBeNull();
  });
});
