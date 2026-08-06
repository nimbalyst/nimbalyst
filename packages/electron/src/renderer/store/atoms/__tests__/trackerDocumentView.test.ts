// @vitest-environment jsdom
/**
 * Tracker Mode's per-item document presentation lives in the persisted layout
 * blob, so it has to survive workspace state written by builds that predate it
 * (or by a build that wrote something else entirely) and stay bounded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import {
  initTrackerPanelLayout,
  openTrackerItemAsDocumentAtom,
  setTrackerDocumentChatSessionAtom,
  setTrackerItemViewAtom,
  setTrackerModeLayoutAtom,
  trackerModeDocumentItemIdAtom,
  trackerModeLayoutAtom,
  MAX_PERSISTED_ITEM_VIEWS,
} from '../trackers';

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  (window as any).electronAPI = { invoke };
});

async function loadWith(trackerModeLayout: Record<string, unknown>): Promise<void> {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'workspace:get-state') return { trackerModeLayout };
    return undefined;
  });
  await initTrackerPanelLayout('/ws/document-view');
}

describe('tracker document-view layout state', () => {
  it('defaults the document-view fields for state saved before they existed', async () => {
    await loadWith({ viewMode: 'list', viewModeMigrated: true });

    const layout = store.get(trackerModeLayoutAtom);
    expect(layout.itemViews).toEqual({});
    expect(layout.documentListPaneVisible).toBe(true);
    expect(layout.documentListPaneWidth).toBe(280);
    expect(layout.documentRightPanelVisible).toBe(true);
    expect(layout.documentRightPanelWidth).toBe(380);
    expect(layout.documentRightPanelMode).toBe('chat');
    expect(layout.documentChatSessions).toEqual({});
  });

  it('keeps only document entries and clamps a stored pane width', async () => {
    await loadWith({
      viewModeMigrated: true,
      itemViews: { 'item-a': 'document', 'item-b': 'item', 'item-c': 42 },
      documentListPaneVisible: false,
      documentListPaneWidth: 5000,
    });

    const layout = store.get(trackerModeLayoutAtom);
    expect(layout.itemViews).toEqual({ 'item-a': 'document' });
    expect(layout.documentListPaneVisible).toBe(false);
    expect(layout.documentListPaneWidth).toBe(480);
  });

  it('ignores an itemViews value that is not a map', async () => {
    await loadWith({ viewModeMigrated: true, itemViews: ['item-a'] });

    expect(store.get(trackerModeLayoutAtom).itemViews).toEqual({});
  });

  it('only reports document view for the selected item', async () => {
    await loadWith({ viewModeMigrated: true });

    store.set(setTrackerItemViewAtom, { itemId: 'item-a', view: 'document' });
    expect(store.get(trackerModeDocumentItemIdAtom)).toBeNull();

    store.set(setTrackerModeLayoutAtom, { selectedItemId: 'item-a' });
    expect(store.get(trackerModeDocumentItemIdAtom)).toBe('item-a');

    // Selecting a sibling that was never opened as a document leaves the
    // focused layout instead of showing it the wrong item.
    store.set(setTrackerModeLayoutAtom, { selectedItemId: 'item-b' });
    expect(store.get(trackerModeDocumentItemIdAtom)).toBeNull();
  });

  it('collapsing back to the item view drops the stored entry', async () => {
    await loadWith({ viewModeMigrated: true });

    store.set(openTrackerItemAsDocumentAtom, 'item-a');
    expect(store.get(trackerModeLayoutAtom).selectedItemId).toBe('item-a');
    expect(store.get(trackerModeDocumentItemIdAtom)).toBe('item-a');

    store.set(setTrackerItemViewAtom, { itemId: 'item-a', view: 'item' });
    expect(store.get(trackerModeLayoutAtom).itemViews).toEqual({});
    expect(store.get(trackerModeDocumentItemIdAtom)).toBeNull();
  });

  it('restores a saved right panel and rejects an unknown surface', async () => {
    await loadWith({
      viewModeMigrated: true,
      documentRightPanelVisible: false,
      documentRightPanelWidth: 5000,
      documentRightPanelMode: 'timeline',
      documentChatSessions: { 'item-a': 'session-1', 'item-b': 42 },
    });

    const layout = store.get(trackerModeLayoutAtom);
    expect(layout.documentRightPanelVisible).toBe(false);
    expect(layout.documentRightPanelWidth).toBe(720);
    expect(layout.documentRightPanelMode).toBe('chat');
    expect(layout.documentChatSessions).toEqual({ 'item-a': 'session-1' });
  });

  it('pairs a chat session with an item, and forgets it on request', async () => {
    await loadWith({ viewModeMigrated: true });

    store.set(setTrackerDocumentChatSessionAtom, { itemId: 'item-a', sessionId: 'session-1' });
    expect(store.get(trackerModeLayoutAtom).documentChatSessions).toEqual({ 'item-a': 'session-1' });

    store.set(setTrackerDocumentChatSessionAtom, { itemId: 'item-a', sessionId: null });
    expect(store.get(trackerModeLayoutAtom).documentChatSessions).toEqual({});
  });

  it('keeps the chat pairings bounded, dropping the oldest', async () => {
    await loadWith({ viewModeMigrated: true });

    for (let index = 0; index < MAX_PERSISTED_ITEM_VIEWS + 3; index += 1) {
      store.set(setTrackerDocumentChatSessionAtom, {
        itemId: `item-${index}`,
        sessionId: `session-${index}`,
      });
    }

    const pairings = store.get(trackerModeLayoutAtom).documentChatSessions;
    expect(Object.keys(pairings)).toHaveLength(MAX_PERSISTED_ITEM_VIEWS);
    expect(pairings['item-0']).toBeUndefined();
    expect(pairings[`item-${MAX_PERSISTED_ITEM_VIEWS + 2}`]).toBe(`session-${MAX_PERSISTED_ITEM_VIEWS + 2}`);
  });

  it('keeps the remembered document views bounded, dropping the oldest', async () => {
    await loadWith({ viewModeMigrated: true });

    for (let index = 0; index < MAX_PERSISTED_ITEM_VIEWS + 5; index += 1) {
      store.set(setTrackerItemViewAtom, { itemId: `item-${index}`, view: 'document' });
    }

    const itemViews = store.get(trackerModeLayoutAtom).itemViews;
    expect(Object.keys(itemViews)).toHaveLength(MAX_PERSISTED_ITEM_VIEWS);
    expect(itemViews['item-0']).toBeUndefined();
    expect(itemViews[`item-${MAX_PERSISTED_ITEM_VIEWS + 4}`]).toBe('document');
  });
});
