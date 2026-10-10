// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { TabsProvider, useTabs } from '../../../contexts/TabsContext';
import { documentAvailability, isPagesEntryAvailable, planPagesOpen, type PagesEntryLookup } from '../pagesTabNavigation';

const DOC_A = 'collab://org:org-a:doc:a';
const DOC_B = 'collab://org:org-a:doc:b';

function tabsOf(activeTabId: string | null, entries: Array<[string, string]>) {
  return { activeTabId, tabs: new Map(entries.map(([id, filePath]) => [id, { id, filePath }])) };
}

describe('planPagesOpen', () => {
  it('replaces the active Pages tab on a plain click and opens a new tab on Cmd/Ctrl', () => {
    const tabs = tabsOf('t1', [['t1', DOC_A]]);
    expect(planPagesOpen('tracker://T1', { newTab: false }, tabs)).toEqual({ action: 'replace', tabId: 't1' });
    expect(planPagesOpen('tracker://T1', { newTab: true }, tabs)).toEqual({ action: 'new' });
    // Every kind of Pages tab navigates in place, Search and Types included.
    expect(planPagesOpen(DOC_B, { newTab: false }, tabsOf('s', [['s', 'virtual://pages-search/team']]))).toEqual({ action: 'replace', tabId: 's' });
    expect(planPagesOpen(DOC_B, { newTab: false }, tabsOf('p', [['p', 'personal://doc-1']]))).toEqual({ action: 'replace', tabId: 'p' });
  });

  it('navigates the current tab even when another tab shows the target; Cmd/Ctrl focuses that tab', () => {
    const tabs = tabsOf('t1', [['t1', DOC_A], ['t2', 'type://module']]);
    expect(planPagesOpen('type://module', { newTab: false }, tabs)).toEqual({ action: 'replace', tabId: 't1' });
    expect(planPagesOpen('type://module', { newTab: true }, tabs)).toEqual({ action: 'new' });
  });

  it('opens a new tab with no active tab or when the active tab is not a Pages tab', () => {
    expect(planPagesOpen(DOC_B, { newTab: false }, tabsOf(null, []))).toEqual({ action: 'new' });
    expect(planPagesOpen(DOC_B, { newTab: false }, tabsOf('f', [['f', 'virtual://feedback-request/r1']]))).toEqual({ action: 'new' });
    expect(planPagesOpen(DOC_B, { newTab: false }, tabsOf('f', [['f', '/repo/a.md']]))).toEqual({ action: 'new' });
  });

  it('navigates in place from a Local wiki page, which is a markdown file tab', () => {
    const isLocalPage = (path: string) => path.startsWith('/repo/docs/wiki/');
    const tabs = tabsOf('w', [['w', '/repo/docs/wiki/Home.md']]);
    expect(planPagesOpen('/repo/docs/wiki/Product.md', { newTab: false }, tabs, isLocalPage)).toEqual({ action: 'replace', tabId: 'w' });
    expect(planPagesOpen(DOC_B, { newTab: false }, tabsOf('f', [['f', '/repo/a.md']]), isLocalPage)).toEqual({ action: 'new' });
  });
});

describe('per-tab Back and Forward', () => {
  beforeEach(() => {
    (globalThis as any).window.electronAPI = { invoke: vi.fn().mockResolvedValue(undefined), send: vi.fn() };
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return <TabsProvider workspacePath={null} disablePersistence>{children}</TabsProvider>;
  }

  it('walks one tab back and forward through what it showed, re-deriving the tab kind each step', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    let tabId = '';
    act(() => { tabId = result.current.addTab(DOC_A, '', true, 'Alpha')!; });
    act(() => { result.current.navigateTab(tabId, 'tracker://T1', 'Item one'); });
    act(() => { result.current.navigateTab(tabId, 'type://module', 'Modules'); });

    const tab = () => result.current.tabs.find((entry) => entry.id === tabId)!;
    expect(tab()).toMatchObject({ filePath: 'type://module', kind: 'type', trackerTypeId: 'module', fileName: 'Modules' });

    act(() => { result.current.stepTab(tabId, -1); });
    expect(tab()).toMatchObject({ filePath: 'tracker://T1', kind: 'tracker', trackerItemId: 'T1', trackerTypeId: undefined, fileName: 'Item one' });
    act(() => { result.current.stepTab(tabId, -1); });
    expect(tab()).toMatchObject({ filePath: DOC_A, kind: 'file', trackerItemId: undefined, fileName: 'Alpha' });
    expect(result.current.stepTab(tabId, -1)).toBe(false);

    act(() => { result.current.stepTab(tabId, 1); });
    expect(tab().filePath).toBe('tracker://T1');
    // Opening something new from the middle drops what was ahead.
    act(() => { result.current.navigateTab(tabId, DOC_B, 'Beta'); });
    expect(result.current.stepTab(tabId, 1)).toBe(false);
    act(() => { result.current.stepTab(tabId, -1); });
    expect(tab().filePath).toBe('tracker://T1');
    expect(result.current.tabs).toHaveLength(1);
  });

  it('keeps each tab its own history, and steps back onto a page another tab shows without leaving the tab', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    let first = '';
    let second = '';
    act(() => { first = result.current.addTab(DOC_A, '', true, 'Alpha')!; });
    act(() => { result.current.navigateTab(first, DOC_B, 'Beta'); });
    act(() => { second = result.current.addTab(DOC_A, '', true, 'Alpha')!; });
    expect(second).not.toBe(first);

    // The second tab never navigated, so it has nothing behind it.
    expect(result.current.stepTab(second, -1)).toBe(false);
    act(() => { result.current.switchTab(first); });
    act(() => { result.current.stepTab(first, -1); });
    expect(result.current.activeTabId).toBe(first);
    expect(result.current.tabs.find((entry) => entry.id === first)!.filePath).toBe(DOC_A);

    // The return journey: Forward in the same tab comes back to B.
    act(() => { result.current.stepTab(first, 1); });
    expect(result.current.activeTabId).toBe(first);
    expect(result.current.tabs.find((entry) => entry.id === first)!.filePath).toBe(DOC_B);
    expect(result.current.tabs.find((entry) => entry.id === second)!.filePath).toBe(DOC_A);
  });

  it('skips Back and Forward past pages that are gone, dropping them from the history', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    let tabId = '';
    act(() => { tabId = result.current.addTab('personal://kept', '', true, 'Kept')!; });
    act(() => { result.current.navigateTab(tabId, 'personal://trashed', 'Trashed'); });
    act(() => { result.current.navigateTab(tabId, 'tracker://T1', 'Item'); });
    const available = (entry: { filePath: string }) => entry.filePath !== 'personal://trashed';

    act(() => { result.current.stepTab(tabId, -1, available); });
    expect(result.current.tabs[0].filePath).toBe('personal://kept');
    // Nothing is left behind it, and the gone page is not ahead of it either.
    expect(result.current.stepTab(tabId, -1, available)).toBe(false);
    act(() => { result.current.stepTab(tabId, 1, available); });
    expect(result.current.tabs[0].filePath).toBe('tracker://T1');
    expect(result.current.tabs[0].history).toEqual({ back: [{ filePath: 'personal://kept', fileName: 'Kept' }], forward: [] });

    // With every page behind it gone, Back does nothing and clears them.
    let stepped = true;
    act(() => { stepped = result.current.stepTab(tabId, -1, () => false); });
    expect(stepped).toBe(false);
    expect(result.current.tabs[0].history?.back).toEqual([]);
  });
});

describe('which history entries can still be shown', () => {
  const docs = [{ documentId: 'live', trashedAt: null }, { documentId: 'binned', trashedAt: 5 }];

  it('reads a page as gone when it is trashed or no longer listed, and unknown before its list has loaded', () => {
    expect(documentAvailability(docs, 'live', true)).toBe('live');
    expect(documentAvailability(docs, 'binned', true)).toBe('gone');
    expect(documentAvailability(docs, 'purged', true)).toBe('gone');
    // A loaded list with nothing in it still says the page is gone.
    expect(documentAvailability([], 'purged', true)).toBe('gone');
    expect(documentAvailability([], 'anything', false)).toBe('unknown');
    expect(documentAvailability(docs, 'not-yet-synced', false)).toBe('unknown');
  });

  it('skips the only Personal page once it is purged, so Back never mounts it as an empty page', () => {
    (globalThis as any).window.electronAPI = { invoke: vi.fn().mockResolvedValue(undefined), send: vi.fn() };
    const wrapper = ({ children }: { children: React.ReactNode }) => <TabsProvider workspacePath={null} disablePersistence>{children}</TabsProvider>;
    const { result } = renderHook(() => useTabs(), { wrapper });
    let tabId = '';
    act(() => { tabId = result.current.addTab('personal://only', '', true, 'Only page')!; });
    act(() => { result.current.navigateTab(tabId, 'type://module', 'Modules'); });

    // The page is purged: the loaded Personal list is now empty.
    const lookup: PagesEntryLookup = {
      teamPage: () => 'unknown',
      personalPage: (id) => documentAvailability([], id, true),
      typedPage: () => 'unknown',
      type: () => 'live',
    };
    let stepped = true;
    act(() => { stepped = result.current.stepTab(tabId, -1, (entry) => isPagesEntryAvailable(entry.filePath, lookup)); });
    expect(stepped).toBe(false);
    expect(result.current.tabs[0].filePath).toBe('type://module');
    expect(result.current.tabs[0].history?.back).toEqual([]);
  });

  it('refuses an entry only when its page, typed page or type is gone', () => {
    const lookup: PagesEntryLookup = {
      teamPage: (id) => (id === 'doc-gone' ? 'gone' : 'live'),
      personalPage: (id) => (id === 'p-gone' ? 'gone' : 'unknown'),
      typedPage: (id) => (id === 'archived' ? 'gone' : 'live'),
      type: (id) => (id === 'dropped' ? 'gone' : 'live'),
    };
    expect(isPagesEntryAvailable('collab://org:org-a:doc:doc-gone', lookup)).toBe(false);
    expect(isPagesEntryAvailable(DOC_A, lookup)).toBe(true);
    expect(isPagesEntryAvailable('personal://p-gone', lookup)).toBe(false);
    expect(isPagesEntryAvailable('personal://p-new', lookup)).toBe(true);
    expect(isPagesEntryAvailable('tracker://archived', lookup)).toBe(false);
    expect(isPagesEntryAvailable('type://dropped', lookup)).toBe(false);
    expect(isPagesEntryAvailable('virtual://pages-search/team', lookup)).toBe(true);
  });
});
