// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  globalRegistry,
  type TrackerDataModel,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { trackerQuickCreateRequestAtom } from '../../../store/atoms/appCommands';
import { createEmptyTrackerQuickCreateDraft, trackerQuickCreateDraftAtom } from '../../../store/atoms/trackerQuickCreate';
import { trackerModeLayoutAtom } from '../../../store/atoms/trackers';
import { windowModeAtom } from '../../../store/atoms/windowMode';
import { TrackerQuickCreatePopup } from '../TrackerQuickCreatePopup';

const bug: TrackerDataModel = {
  type: 'qc-bug',
  displayName: 'Bug',
  displayNamePlural: 'Bugs',
  icon: 'bug_report',
  color: '#f00',
  modes: { inline: true, fullDocument: false },
  idPrefix: 'qcb',
  idFormat: 'uuid',
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'status', type: 'select', default: 'to-do', options: [{ value: 'to-do', label: 'To Do' }] },
    { name: 'priority', type: 'select', default: 'medium', options: [
      { value: 'medium', label: 'Medium' },
      { value: 'critical', label: 'Critical' },
    ] },
  ],
};

const task: TrackerDataModel = { ...bug, type: 'qc-task', displayName: 'Task', idPrefix: 'qct' };

function record(id: string, title: string): TrackerRecord {
  return {
    id,
    primaryType: 'qc-bug',
    typeTags: ['qc-bug'],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    localKey: 'QCB.7',
    system: {
      workspace: '/workspace',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    fields: { title, status: 'to-do' },
  };
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function renderPopup(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <TrackerQuickCreatePopup workspacePath="/workspace" />
    </Provider>,
  );
}

describe('TrackerQuickCreatePopup', () => {
  let createTrackerItem: ReturnType<typeof vi.fn>;

  it('sends Content as the body and retains the draft until creation is acknowledged', async () => {
    let finish!: (value: unknown) => void;
    createTrackerItem.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const store = createStore();
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-task');
    const draftAtom = trackerQuickCreateDraftAtom('/workspace');
    act(() => store.set(draftAtom, (draft) => ({ ...draft, description: 'First paragraph\n\n**Details** Ω' })));
    fireEvent.change(title, { target: { value: 'Keep my content' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => expect(createTrackerItem).toHaveBeenCalledTimes(1));
    expect(createTrackerItem.mock.calls[0][0]).toMatchObject({ content: 'First paragraph\n\n**Details** Ω' });
    expect(store.get(draftAtom)).toMatchObject({ title: 'Keep my content', description: 'First paragraph\n\n**Details** Ω' });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(createTrackerItem).toHaveBeenCalledTimes(1);
    await act(async () => finish({ success: true, item: { id: createTrackerItem.mock.calls[0][0].id } }));
    await waitFor(() => expect(store.get(draftAtom).title).toBe(''));
  });

  it('retains a rejected create for retry with the same item identity', async () => {
    createTrackerItem.mockResolvedValueOnce({ success: false, error: 'Disk full' });
    const store = createStore();
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-task');
    fireEvent.change(title, { target: { value: 'Retry this item' } });
    fireEvent.keyDown(title, { key: 'Enter', ctrlKey: true });
    await screen.findByRole('alert');
    expect((screen.getByTestId('tracker-quick-create-title') as HTMLInputElement).value).toBe('Retry this item');
    fireEvent.click(screen.getByTestId('tracker-quick-create-submit'));
    await waitFor(() => expect(createTrackerItem).toHaveBeenCalledTimes(2));
    expect(createTrackerItem.mock.calls[1][0].id).toBe(createTrackerItem.mock.calls[0][0].id);
  });

  it('does not clear a newer draft when an earlier submission finishes', async () => {
    let finish!: (value: unknown) => void;
    createTrackerItem.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const store = createStore();
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-task');
    fireEvent.change(title, { target: { value: 'First item' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => expect(createTrackerItem).toHaveBeenCalledTimes(1));
    const draftAtom = trackerQuickCreateDraftAtom('/workspace');
    const newer = { ...createEmptyTrackerQuickCreateDraft(), type: 'qc-task', title: 'Newer draft', description: 'Do not clear this' };
    act(() => store.set(draftAtom, newer));
    await act(async () => finish({ success: true }));
    expect(store.get(draftAtom)).toEqual(newer);
  });

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    globalRegistry.register(bug);
    globalRegistry.register(task);
    createTrackerItem = vi.fn().mockResolvedValue({ success: true, item: { id: 'created' } });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        documentService: { createTrackerItem, listPendingTrackerCreations: vi.fn().mockResolvedValue([]), getTrackerCreationStatus: vi.fn().mockResolvedValue(null) },
        semanticSearch: {
          isAvailable: vi.fn().mockResolvedValue(false),
          query: vi.fn().mockResolvedValue([]),
        },
        settingsGetAll: vi.fn().mockResolvedValue({}),
        settingsSet: vi.fn().mockResolvedValue(undefined),
        extensions: { setEnabled: vi.fn().mockResolvedValue(undefined) },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    globalRegistry.unregister('qc-bug');
    globalRegistry.unregister('qc-task');
  });

  /** Open the popup and drive the type stage from the keyboard, as a user does. */
  async function openAndPickType(store: ReturnType<typeof createStore>, slug: string) {
    act(() => store.set(trackerQuickCreateRequestAtom, 1));
    const search = await screen.findByTestId('tracker-quick-create-type-search');
    // Filter by the slug: unique regardless of what other suites registered.
    fireEvent.change(search, { target: { value: slug } });
    fireEvent.keyDown(search, { key: 'Enter' });
    return (await screen.findByTestId('tracker-quick-create-title')) as HTMLInputElement;
  }

  it('picks a type by filtering and Enter, then captures the title', async () => {
    const store = createStore();
    renderPopup(store);

    // The popup opens on the picker, not the title — the type comes first.
    act(() => store.set(trackerQuickCreateRequestAtom, 1));
    await screen.findByTestId('tracker-quick-create-type-search');
    expect(screen.queryByTestId('tracker-quick-create-title')).toBeNull();

    const search = screen.getByTestId('tracker-quick-create-type-search');
    fireEvent.change(search, { target: { value: 'qc-task' } });
    expect(screen.queryByTestId('tracker-quick-create-type-qc-bug')).toBeNull();
    fireEvent.keyDown(search, { key: 'Enter' });

    const title = await screen.findByTestId('tracker-quick-create-title');
    fireEvent.change(title, { target: { value: 'Filtered to the task type' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(createTrackerItem).toHaveBeenCalledTimes(1));
    expect(createTrackerItem.mock.calls[0][0].type).toBe('qc-task');
  });

  it('creates on Enter and stays on the content stage with the same type', async () => {
    const store = createStore();
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-bug');

    fireEvent.change(title, { target: { value: 'Editor hangs on paste' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(createTrackerItem).toHaveBeenCalledTimes(1));
    expect(createTrackerItem.mock.calls[0][0]).toMatchObject({
      type: 'qc-bug',
      title: 'Editor hangs on paste',
      status: 'to-do',
      priority: 'medium',
      workspace: '/workspace',
    });

    // The whole point of the feature: still up, still on Bug, ready for the next
    // one — no second trip through the type picker.
    const next = screen.getByTestId('tracker-quick-create-title') as HTMLInputElement;
    expect(next.value).toBe('');
    expect(screen.getByTestId('tracker-quick-create-type-chip').textContent).toContain('Bug');
  });

  it('creates and closes into the new item on Cmd+Enter', async () => {
    const store = createStore();
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-bug');

    fireEvent.change(title, { target: { value: 'Sidebar width resets' } });
    fireEvent.keyDown(title, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(screen.queryByTestId('tracker-quick-create-title')).toBeNull());
    expect(createTrackerItem).toHaveBeenCalledTimes(1);
    expect(store.get(windowModeAtom)).toBe('tracker');
    expect(store.get(trackerModeLayoutAtom).selectedItemId).toBe(
      createTrackerItem.mock.calls[0][0].id,
    );
  });

  it.each([
    ['Backspace on an empty title', (title: HTMLElement) => fireEvent.keyDown(title, { key: 'Backspace' })],
    ['Cmd+T', (title: HTMLElement) => fireEvent.keyDown(title, { key: 't', metaKey: true })],
  ])('reopens the type picker via %s and keeps the typed title', async (_label, goBack) => {
    const store = createStore();
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-bug');

    // Cmd+T must work with a title present; Backspace only steps back when the
    // field is empty, so it is exercised on the empty field it is scoped to.
    if (_label === 'Cmd+T') fireEvent.change(title, { target: { value: 'Needs a different type' } });
    goBack(screen.getByTestId('tracker-quick-create-title'));

    const search = await screen.findByTestId('tracker-quick-create-type-search');
    fireEvent.change(search, { target: { value: 'qc-task' } });
    fireEvent.keyDown(search, { key: 'Enter' });

    const back = (await screen.findByTestId('tracker-quick-create-title')) as HTMLInputElement;
    expect(back.value).toBe(_label === 'Cmd+T' ? 'Needs a different type' : '');
    fireEvent.change(back, { target: { value: 'Now a task' } });
    fireEvent.keyDown(back, { key: 'Enter' });

    await waitFor(() => expect(createTrackerItem).toHaveBeenCalled());
    expect(createTrackerItem.mock.calls[0][0].type).toBe('qc-task');
  });

  it('opens the existing item from the duplicate strip instead of creating a second one', async () => {
    const store = createStore();
    store.set(trackerItemsMapAtom, new Map([
      ['existing-1', record('existing-1', 'Editor hangs on input when pasting')],
    ]));
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-bug');
    fireEvent.change(title, { target: { value: 'Editor hangs on input while pasting' } });
    await screen.findByTestId('tracker-quick-create-duplicate-existing-1');

    fireEvent.keyDown(title, { key: 'ArrowDown' });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(screen.queryByTestId('tracker-quick-create-title')).toBeNull());
    expect(createTrackerItem).not.toHaveBeenCalled();
    expect(store.get(trackerModeLayoutAtom).selectedItemId).toBe('existing-1');
  });

  it('returns Enter to create after the user resumes editing an armed duplicate title', async () => {
    const store = createStore();
    store.set(trackerItemsMapAtom, new Map([
      ['existing-1', record('existing-1', 'Editor hangs on input when pasting')],
    ]));
    renderPopup(store);
    const title = await openAndPickType(store, 'qc-bug');
    fireEvent.change(title, { target: { value: 'Editor hangs on input while pasting' } });
    await screen.findByTestId('tracker-quick-create-duplicate-existing-1');

    fireEvent.keyDown(title, { key: 'ArrowDown' });
    fireEvent.change(title, { target: { value: 'Editor hangs on input every time pasting' } });
    fireEvent.keyDown(title, { key: 'Enter' });

    await waitFor(() => expect(createTrackerItem).toHaveBeenCalledTimes(1));
    expect(store.get(trackerModeLayoutAtom).selectedItemId).toBeNull();
  });
});
