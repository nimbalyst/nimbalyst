/**
 * A view embed draws from the items: it renders the view in its own mode and
 * follows item changes as they stream in.
 */

import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { trackerRecordToItem, type TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/tracker-schema';
import {
  createDefaultViewDefinition,
  serializeSharedSavedView,
  type TrackerDataChange,
  type TrackerDataSource,
} from '@nimbalyst/collab-client/trackers';
import { TrackersUIProvider } from '../../TrackersUIProvider';
import { useTrackerViewRows } from '../../useTrackerViewRows';
import { TRACKER_EMBEDS_READ_ONLY_ATTRIBUTE, TrackerViewEmbed } from '../TrackerViewEmbed';
import { createTypePageView } from '../typePageView';
import { PlacedViewEmbed } from '../PlacedViewEmbed';
import { MarksListEmbed } from '../MarksListEmbed';
import { setPageMarksSource } from '../../../pages';

// The real grid surface runs; only the web component is a bare element, so a
// test can fire the `afteredit` RevoGrid would fire after a cell edit.
vi.mock('@revolist/react-datagrid', () => ({
  RevoGrid: (props: { readonly?: boolean }) => createElement('revo-grid', { 'data-readonly': String(Boolean(props.readonly)) }),
}));

function model(type: string, fields: TrackerDataModel['fields']): TrackerDataModel {
  return {
    type, displayName: type, displayNamePlural: `${type}s`, icon: 'circle', color: '#888888',
    modes: { inline: false, fullDocument: false }, idPrefix: type.slice(0, 3), idFormat: 'ulid', fields,
  } as TrackerDataModel;
}

function record(id: string, type: string, fields: Record<string, unknown>): TrackerRecord {
  return {
    id, primaryType: type, typeTags: [type], source: 'native', archived: false, syncStatus: 'local',
    system: { workspace: '/w', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
    fields,
  } as unknown as TrackerRecord;
}

const braze = (title: string) => record('braze', 'ev-target', { title, realtime: 0.5 });
const cap = record('cap-rt', 'ev-cap', { title: 'Realtime targeting' });
const comparison = {
  id: 'v-cmp',
  name: 'Comparison',
  definition: { ...createDefaultViewDefinition(), selectedType: 'ev-target', viewMode: 'list' as const, statusScope: 'all' as const },
};

function fakeSource(): TrackerDataSource & { emit(change: TrackerDataChange): void } {
  const listeners = new Set<(change: TrackerDataChange) => void>();
  return {
    snapshot: async () => ({
      items: [braze('Braze'), cap].map(trackerRecordToItem),
      savedViews: [{ viewId: comparison.id, payload: serializeSharedSavedView(comparison) }],
      presence: [],
      sync: { workspacePath: '/w', status: 'connected', projectId: null },
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    status: () => ({ workspacePath: '/w', status: 'connected', projectId: null }),
    command: vi.fn(async () => ({ ok: true as const })),
    getItemRevision: vi.fn(),
    dispose: () => {},
    emit: (change) => { for (const listener of listeners) listener(change); },
  } as TrackerDataSource & { emit(change: TrackerDataChange): void };
}

beforeAll(() => {
  globalRegistry.register(model('ev-cap', [{ name: 'title', type: 'string' }]));
  globalRegistry.register(model('ev-target', [
    { name: 'title', type: 'string' },
    { name: 'realtime', type: 'number' },
    { name: 'supports', type: 'relationship', multiValue: true, targetTrackerTypes: ['ev-cap'], predicate: 'supports' },
  ]));
});

afterAll(() => {
  globalRegistry.unregister('ev-cap');
  globalRegistry.unregister('ev-target');
});

describe('TrackerViewEmbed', () => {
  it('opens the explored definition full size without changing the source page', async () => {
    const open = vi.fn();
    render(<TrackersUIProvider dataSource={fakeSource()} identity={null}><PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-target' }} label="Targets" attrs={{ custom: 'preserved' }} onOpenFullView={open} /></TrackersUIProvider>);
    fireEvent.click(screen.getByRole('button', { name: /View settings/ }));
    if (!screen.queryByTestId('tracker-display-view-mode-list')) fireEvent.click(screen.getByRole('button', { name: /Layout/ }));
    fireEvent.click(screen.getByTestId('tracker-display-view-mode-list'));
    fireEvent.click(screen.getByRole('button', { name: 'Close view settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open full view' }));
    expect(open).toHaveBeenCalledWith('ev-target', { label: 'Targets', attrs: { custom: 'preserved', mode: 'list' } });
  });
  it('navigates settings while patching only the edited properties, sorts and filters', async () => {
    const change = vi.fn();
    render(<TrackersUIProvider dataSource={fakeSource()} identity={null}><PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-target' }} label="Targets" attrs={{ cols: 'title,realtime', sort: 'title:asc,realtime:desc', filter: 'title:=Braze', custom: 'keep' }} onAttrsChange={change} /></TrackersUIProvider>);
    await screen.findByTestId('tracker-saved-view-embed');
    fireEvent.click(screen.getByRole('button', { name: 'View settings' }));
    fireEvent.click(screen.getByRole('button', { name: /Property visibility/ }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Realtime' }), { key: 'ArrowUp' });
    expect(change).toHaveBeenLastCalledWith({ cols: 'realtime,title' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Realtime' }));
    expect(change).toHaveBeenLastCalledWith({ cols: 'title' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to view settings' }));
    fireEvent.click(screen.getByRole('button', { name: /Sort/ }));
    fireEvent.change(screen.getByLabelText('Sort direction 1'), { target: { value: 'desc' } });
    expect(change).toHaveBeenLastCalledWith({ sort: 'title:desc,realtime:desc' });
    fireEvent.click(screen.getByRole('button', { name: 'Back to view settings' }));
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    fireEvent.change(screen.getByLabelText('Filter field'), { target: { value: 'realtime' } });
    fireEvent.change(screen.getByLabelText('Filter operator'), { target: { value: '>' } });
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: '1' } });
    // Moving from a number to text must discard the incompatible operator and draft value.
    fireEvent.change(screen.getByLabelText('Filter field'), { target: { value: 'title' } });
    expect((screen.getByLabelText('Filter value') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Filter value'), { target: { value: 'A,B|C' } });
    fireEvent.click(screen.getByRole('button', { name: /Add filter/ }));
    expect(change).toHaveBeenLastCalledWith({ filter: 'title:=Braze,title:=A%2CB%7CC' });
  });

  it('routes native header sorting and resize through the shared view write-back', async () => {
    const change = vi.fn();
    render(<TrackersUIProvider dataSource={fakeSource()} identity={null}><PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-target' }} label="Targets" attrs={{ cols: 'title,realtime', sort: 'realtime:desc', w: 'title:320' }} onAttrsChange={change} /></TrackersUIProvider>);
    await screen.findByText('1 item');
    const grid = document.querySelector('revo-grid')!;
    fireEvent(grid, new CustomEvent('beforesorting', { bubbles: false, cancelable: true, detail: { column: { prop: 'realtime' } } }));
    expect(change).toHaveBeenLastCalledWith({ sort: 'realtime:asc' });
    fireEvent(grid, new CustomEvent('aftercolumnresize', { bubbles: true, detail: { 0: { prop: 'realtime', size: 180 } } }));
    expect(change).toHaveBeenLastCalledWith({ w: 'title:320,realtime:180' });
  });

  it('fits an unsized table body to its rows, and a saved height overrides the fit', async () => {
    const view = (attrs: Record<string, string>) => <TrackersUIProvider dataSource={fakeSource()} identity={null}><PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-target' }} label="Targets" attrs={attrs} /></TrackersUIProvider>;
    const { rerender } = render(view({}));
    await screen.findByText('1 item');
    const body = () => document.querySelector<HTMLElement>('[data-placed-view-body]')!;
    // One row fits well under the old fixed 420px, so the body shrinks to its floor.
    expect(body().style.height).toBe('120px');
    rerender(view({ height: '300' }));
    expect(body().style.height).toBe('300px');
  });

  it('sorts by subsequent fields on a tie without reversing descending results twice', () => {
    const rows = [record('b', 'ev-target', { title: 'B', realtime: 2 }), record('a', 'ev-target', { title: 'A', realtime: 2 }), record('c', 'ev-target', { title: 'C', realtime: 1 })];
    const { result } = renderHook(() => useTrackerViewRows(rows, { ...comparison.definition, ordering: 'realtime', sortColumns: [{ field: 'realtime', direction: 'desc' }, { field: 'title', direction: 'asc' }] }, { identity: null }), { wrapper: ({ children }) => <TrackersUIProvider dataSource={fakeSource()} identity={null}>{children}</TrackersUIProvider> });
    expect(result.current.rows.map(row => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('creates the first item in an empty board lane with filter and lane defaults', async () => {
    globalRegistry.register(model('ev-board', [{ name: 'title', type: 'string' }, { name: 'score', type: 'number' }, { name: 'stage', type: 'select', options: [{ value: 'ready', label: 'Ready' }] }]));
    const source = fakeSource();
    try {
      render(<TrackersUIProvider dataSource={source} identity={null}><PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-board' }} label="Board" attrs={{ mode: 'board', group: 'stage', filter: 'score:3' }} /></TrackersUIProvider>);
      const add = await screen.findByRole('button', { name: '+ New' });
      fireEvent.click(add);
      fireEvent.change(screen.getByLabelText('New item title'), { target: { value: 'First' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(source.command).toHaveBeenCalledWith(expect.objectContaining({ type: 'create-item', item: expect.objectContaining({ title: 'First', customFields: expect.objectContaining({ stage: 'ready', score: 3 }) }) })));
    } finally { act(() => globalRegistry.unregister('ev-board')); }
  });

  it('creates from the view through its datasource and retains a refused title for retry', async () => {
    const source = fakeSource();
    vi.mocked(source.command).mockResolvedValueOnce({ ok: true, result: { success: false, error: 'Disconnected' } }).mockResolvedValue({ ok: true, result: { success: true } });
    render(<TrackersUIProvider dataSource={source} identity={null}><TrackerViewEmbed view={comparison} /></TrackersUIProvider>);
    await screen.findByTestId('tracker-saved-view-embed');
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    fireEvent.change(screen.getByLabelText('New item title'), { target: { value: 'New target' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Disconnected');
    expect((screen.getByLabelText('New item title') as HTMLInputElement).value).toBe('New target');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect((screen.getByLabelText('New item title') as HTMLInputElement).value).toBe(''));
    expect(source.command).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'create-item', item: expect.objectContaining({ type: 'ev-target', title: 'New target' }) }));
    const create = vi.mocked(source.command).mock.calls[0][0];
    if (create.type !== 'create-item') throw new Error('Expected creation');
    expect(create.item.creationRequestId).toBe(create.item.id);
    expect(vi.mocked(source.command).mock.calls[0][0]).toEqual(vi.mocked(source.command).mock.calls[1][0]);
  });

  it('writes only the changed setting, while read-only view exploration stays temporary', async () => {
    const onAttrsChange = vi.fn();
    const source = fakeSource();
    const view = (writer?: typeof onAttrsChange) => <TrackersUIProvider dataSource={source} identity={null}>
      <PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-target' }} label="Targets" attrs={{ custom: 'keep' }} onAttrsChange={writer} />
    </TrackersUIProvider>;
    const { rerender } = render(view(onAttrsChange));
    await screen.findByTestId('tracker-saved-view-embed');
    if (!screen.queryByRole('dialog', { name: 'View settings' })) fireEvent.click(screen.getByRole('button', { name: /View settings/ }));
    if (!screen.queryByTestId('tracker-display-view-mode-list')) fireEvent.click(screen.getByRole('button', { name: /Layout/ }));
    fireEvent.click(screen.getByTestId('tracker-display-view-mode-list'));
    expect(onAttrsChange).toHaveBeenCalledWith({ mode: 'list' });
    rerender(view());
    if (!screen.queryByRole('dialog', { name: 'View settings' })) fireEvent.click(screen.getByRole('button', { name: /View settings/ }));
    if (!screen.queryByTestId('tracker-display-view-mode-list')) fireEvent.click(screen.getByRole('button', { name: /Layout/ }));
    fireEvent.click(screen.getByTestId('tracker-display-view-mode-list'));
    expect(screen.getByTestId('tracker-saved-view-embed').dataset.viewMode).toBe('list');
    expect(onAttrsChange).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Not saved: view only/)).toBeTruthy();
  });

  it('draws the view in its own mode and follows item changes', async () => {
    const source = fakeSource();
    const onOpenAsTable = vi.fn();
    render(
      <TrackersUIProvider dataSource={source} identity={null}>
        <TrackerViewEmbed view={comparison} onOpenAsTable={onOpenAsTable} />
      </TrackersUIProvider>,
    );

    const embed = await screen.findByTestId('tracker-saved-view-embed');
    expect(embed.dataset.viewMode).toBe('list');
    await screen.findByText('Braze');

    act(() => source.emit({ type: 'items-upserted', items: [trackerRecordToItem(braze('Braze Engage'))] }));
    await screen.findByText('Braze Engage');
    expect(screen.queryByText('Braze')).toBeNull();

    fireEvent.click(screen.getByTestId('tracker-saved-view-embed-open'));
    expect(onOpenAsTable).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-cmp', name: 'Comparison' }));
  });

  it('draws a type page from a synthetic view: that type only, as a table', async () => {
    render(
      <TrackersUIProvider dataSource={fakeSource()} identity={null}>
        <TrackerViewEmbed view={createTypePageView('ev-target')} variant="page" />
      </TrackersUIProvider>,
    );
    const embed = await screen.findByTestId('tracker-saved-view-embed');
    expect(embed.dataset.viewMode).toBe('table');
    await screen.findByText('1 item');
  });

  it('lists the items of every type a type page names (its subtypes)', async () => {
    render(
      <TrackersUIProvider dataSource={fakeSource()} identity={null}>
        <TrackerViewEmbed view={createTypePageView('ev-target')} variant="page" typeIds={['ev-target', 'ev-cap']} />
      </TrackersUIProvider>,
    );
    await screen.findByText('2 items');
  });

  it('leaves an archived typed page out of the view, as the tree and Tracker mode do', async () => {
    const source = fakeSource();
    render(
      <TrackersUIProvider dataSource={source} identity={null}>
        <TrackerViewEmbed view={createTypePageView('ev-target')} variant="page" typeIds={['ev-target', 'ev-cap']} />
      </TrackersUIProvider>,
    );
    await screen.findByText('2 items');
    act(() => source.emit({ type: 'items-upserted', items: [trackerRecordToItem({ ...braze('Braze'), archived: true })] }));
    await screen.findByText('1 item');
  });
});

describe('TrackerViewEmbed editing', () => {
  const scoreView = {
    ...createTypePageView('ev-target'),
    definition: {
      ...createTypePageView('ev-target').definition,
      columnConfig: { visibleColumns: ['title', 'realtime'], columnWidths: {} },
    },
  };
  const editCell = (val: unknown) => {
    const grid = document.querySelector('revo-grid')!;
    grid.dispatchEvent(new CustomEvent('afteredit', { detail: { rowIndex: 0, prop: 'realtime', val } }));
  };

  it('writes a cell edit to the item as update-items with the coerced value', async () => {
    const source = fakeSource();
    render(
      <TrackersUIProvider dataSource={source} identity={null}>
        <TrackerViewEmbed view={scoreView} />
      </TrackersUIProvider>,
    );
    await screen.findByText('1 item');
    expect(document.querySelector('revo-grid')!.getAttribute('data-readonly')).toBe('false');

    editCell('0.7');
    await waitFor(() => expect(source.command).toHaveBeenCalledWith({
      type: 'update-items',
      input: { entries: [{ itemId: 'braze', storeUpdates: { realtime: 0.7 } }] },
    }));
  });

  it('is read-only when the host says so', async () => {
    const source = fakeSource();
    render(
      <TrackersUIProvider dataSource={source} identity={null}>
        <TrackerViewEmbed view={scoreView} readOnly />
      </TrackersUIProvider>,
    );
    await screen.findByText('1 item');
    expect(document.querySelector('revo-grid')!.getAttribute('data-readonly')).toBe('true');
    editCell('0.7');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.command).not.toHaveBeenCalled();
  });

  it('is read-only under an ancestor the host marked read-only, with no create row', async () => {
    const source = fakeSource();
    render(
      <div {...{ [TRACKER_EMBEDS_READ_ONLY_ATTRIBUTE]: 'true' }}>
        <TrackersUIProvider dataSource={source} identity={null}>
          <TrackerViewEmbed view={scoreView} />
        </TrackersUIProvider>
      </div>,
    );
    await screen.findByText('1 item');
    expect(document.querySelector('revo-grid')!.getAttribute('data-readonly')).toBe('true');
    expect(screen.queryByText('+ New')).toBeNull();
    editCell('0.7');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.command).not.toHaveBeenCalled();
  });

  it('refuses edits and creates through stale callbacks once an ancestor turns read-only', async () => {
    const source = fakeSource();
    const { container } = render(
      <div data-testid="host">
        <TrackersUIProvider dataSource={source} identity={null}>
          <TrackerViewEmbed view={scoreView} />
        </TrackersUIProvider>
      </div>,
    );
    await screen.findByText('1 item');
    fireEvent.click(screen.getByText('+ New'));
    container.querySelector('[data-testid="host"]')!.setAttribute(TRACKER_EMBEDS_READ_ONLY_ATTRIBUTE, 'true');

    fireEvent.change(screen.getByLabelText('New item title'), { target: { value: 'Late' } });
    fireEvent.submit(screen.getByLabelText('New item title').closest('form')!);
    editCell('0.7');
    await waitFor(() => expect(document.querySelector('revo-grid')!.getAttribute('data-readonly')).toBe('true'));
    expect(source.command).not.toHaveBeenCalled();
  });

  it('shows the host refusal instead of pretending the edit saved', async () => {
    const source = fakeSource();
    vi.mocked(source.command).mockRejectedValueOnce(new Error('This type is archived'));
    render(
      <TrackersUIProvider dataSource={source} identity={null}>
        <TrackerViewEmbed view={scoreView} />
      </TrackersUIProvider>,
    );
    await screen.findByText('1 item');
    editCell('0.7');
    expect((await screen.findByRole('alert')).textContent).toContain('This type is archived');
  });
});

describe('PlacedViewEmbed', () => {
  it.each(['realtime', 'missing:yes', 'realtime:nope'])('shows an invalid-view message and no data for filter %s', async (filter) => {
    render(
      <TrackersUIProvider dataSource={fakeSource()} identity={null}>
        <PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-target' }} label="Targets" attrs={{ filter }} />
      </TrackersUIProvider>,
    );
    const note = await screen.findByRole('alert');
    expect(note.textContent).toContain('Invalid filter');
    expect(note.textContent).toContain(filter.split(':')[0]);
    expect(screen.queryByTestId('tracker-saved-view-embed')).toBeNull();
  });

  it('draws a 2x2 of the type by two fields, with pinned points highlighted', async () => {
    render(
      <TrackersUIProvider dataSource={fakeSource()} identity={null}>
        <PlacedViewEmbed
          target={{ kind: 'type', typeId: 'ev-target' }}
          label="Landscape"
          attrs={{ mode: '2x2', x: 'realtime', y: 'realtime', pin: 'Us@0.9,0.9' }}
        />
      </TrackersUIProvider>,
    );
    await screen.findByText('1 placed');
    expect(screen.getByText('Braze')).toBeDefined();
    expect(screen.getByText('Us').closest('g')!.getAttribute('data-pinned')).toBe('true');
  });

  const projectA = { orgId: 'org-1', projectId: 'proj-a' };
  const projectB = { orgId: 'org-1', projectId: 'proj-b' };

  it.each([
    ['another team project', projectA, { team: projectB, local: true }],
    ['a local view on a team page', 'local' as const, { team: projectB, local: false }],
    ['a team view in a window with no team', projectB, { team: null, local: true }],
  ])('never draws or edits the items of %s; it offers the link instead', async (_name, scope, reach) => {
    const source = fakeSource();
    const onOpenLink = vi.fn();
    render(
      <TrackersUIProvider dataSource={source} identity={null}>
        <PlacedViewEmbed
          target={{ kind: 'type', typeId: 'ev-target', scope }}
          label="Targets"
          attrs={{}}
          reach={reach}
          onOpenLink={onOpenLink}
        />
      </TrackersUIProvider>,
    );
    const note = await screen.findByTestId('placed-view-out-of-scope');
    expect(note.textContent).toContain('another project');
    expect(screen.queryByText('Braze')).toBeNull();
    expect(document.querySelector('revo-grid')).toBeNull();
    fireEvent.click(screen.getByTestId('placed-view-open-link'));
    expect(onOpenLink).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/console\.nimbalyst\.com\/.*\/view\/type\/ev-target$/));
    expect(source.command).not.toHaveBeenCalled();
  });

  it('draws a view whose scope this window reaches', async () => {
    render(
      <TrackersUIProvider dataSource={fakeSource()} identity={null}>
        <PlacedViewEmbed target={{ kind: 'type', typeId: 'ev-target', scope: projectB }} label="Targets" attrs={{}} reach={{ team: projectB, local: false }} />
      </TrackersUIProvider>,
    );
    await screen.findByText('1 item');
    expect(screen.queryByTestId('placed-view-out-of-scope')).toBeNull();
  });
});

describe('MarksListEmbed', () => {
  const decided = {
    id: 'tracker://cmp_1#4', kind: 'decided' as const, text: 'Use **Yjs**', plainText: 'Use Yjs',
    by: 'Greg', on: '2026-10-02', over: 'Automerge', line: 4,
    page: { kind: 'typed-page' as const, scope: 'team' as const, id: 'cmp_1', title: 'Sync engine', uri: 'tracker://cmp_1', typeId: 'module', issueKey: null },
  };
  afterEach(() => setPageMarksSource(null));

  it('lists marks of one kind from the host source, and opens the page a mark is on', async () => {
    const listMarks = vi.fn(async () => [decided]);
    setPageMarksSource({ listMarks });
    const onOpenPage = vi.fn();
    render(<MarksListEmbed kind="decided" label="Decisions" attrs={{ type: 'module' }} onOpenPage={onOpenPage} />);

    await screen.findByText('Use Yjs');
    expect(listMarks).toHaveBeenCalledWith({ kind: 'decided', typeId: 'module' });
    expect(screen.getByTestId('marks-list-meta').textContent).toBe('Greg, 2026-10-02, over Automerge');
    fireEvent.click(screen.getByText('Sync engine'));
    expect(onOpenPage).toHaveBeenCalledWith('tracker://cmp_1', { newTab: false });
  });

  it('says so when the host cannot read marks', () => {
    render(<MarksListEmbed kind="open" label="Open questions" attrs={{}} />);
    expect(screen.getByTestId('placed-view-note').textContent).toContain('Open questions');
  });
});
