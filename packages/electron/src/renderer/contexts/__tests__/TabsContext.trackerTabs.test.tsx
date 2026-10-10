// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import {
  TabsProvider,
  useTabs,
  isTrackerTabPath,
} from '../TabsContext';

/**
 * Slice 2 foundation: tracker resource tabs in the shared TabsContext.
 *
 * A tracker tab is represented with `filePath = tracker://<itemId>` so the
 * existing path-based dedup keeps working, while file-watching and disk reads
 * are skipped (a tracker is not a real file). These tests pin that behavior and
 * prove file-tab behavior is unchanged.
 */

const invoke = vi.fn().mockResolvedValue(undefined);
const send = vi.fn();

beforeEach(() => {
  invoke.mockClear();
  send.mockClear();
  (globalThis as any).window.electronAPI = { invoke, send };
});

function wrapper({ children }: { children: React.ReactNode }) {
  // disablePersistence avoids the workspace-state restore/save IPC path.
  return (
    <TabsProvider workspacePath={null} disablePersistence>
      {children}
    </TabsProvider>
  );
}

function watchedPaths(kind: 'start' | 'stop'): string[] {
  const channel = kind === 'start' ? 'start-watching-file' : 'stop-watching-file';
  return invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c[1]);
}

describe('isTrackerTabPath', () => {
  it('recognizes tracker resource ids and rejects real paths', () => {
    expect(isTrackerTabPath('tracker://item-123')).toBe(true);
    expect(isTrackerTabPath('/Users/me/notes.md')).toBe(false);
    expect(isTrackerTabPath('virtual://foo')).toBe(false);
    expect(isTrackerTabPath('collab://tracker-content/x')).toBe(false);
  });
});

describe('TabsContext tracker tabs', () => {
  it('creates a collaborative tab with its display name atomically', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    act(() => {
      result.current.addTab(
        'collab://org:org-a:doc:1af74157-fe92-481b-9be3-4ed7cc6f5625',
        '',
        true,
        'Architecture Plan',
      );
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].fileName).toBe('Architecture Plan');
    expect(result.current.tabs[0].fileName).not.toContain('1af74157');
  });

  it('uses a neutral collaborative placeholder when no title has resolved', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    act(() => {
      result.current.addTab(
        'collab://org:org-a:doc:1af74157-fe92-481b-9be3-4ed7cc6f5625',
      );
    });

    expect(result.current.tabs[0].fileName).toBe('Shared document');
  });

  it('reopens a collaborative tab with its last-known title, never its id', async () => {
    const { result } = renderHook(() => useTabs(), { wrapper });
    let tabId: string | null = null;

    act(() => {
      tabId = result.current.addTab(
        'collab://org:org-a:doc:1af74157-fe92-481b-9be3-4ed7cc6f5625',
        '',
        true,
        'Architecture Plan',
      );
    });
    act(() => result.current.removeTab(tabId!));
    await act(async () => {
      await result.current.reopenLastClosedTab(async () => {});
    });

    expect(result.current.tabs[0].fileName).toBe('Architecture Plan');
  });

  it('adds a tracker tab with kind/trackerItemId and does NOT watch it as a file', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    act(() => {
      result.current.addTab('tracker://T1');
    });

    const tab = result.current.tabs.find((t) => t.filePath === 'tracker://T1');
    expect(tab).toBeDefined();
    expect(tab!.kind).toBe('tracker');
    expect(tab!.trackerItemId).toBe('T1');
    expect(tab!.isVirtual).toBe(false);
    // Label falls back to the item id (live title is resolved in the tab bar).
    expect(tab!.fileName).toBe('T1');
    // No filesystem watch for a tracker resource.
    expect(watchedPaths('start')).not.toContain('tracker://T1');
  });

  it('adds a type page tab with kind/trackerTypeId and never watches or stop-watches it', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    let typeTabId: string | null = null;
    act(() => {
      typeTabId = result.current.addTab('type://module', '', true, 'Modules');
    });

    const tab = result.current.tabs.find((t) => t.filePath === 'type://module');
    expect(tab!.kind).toBe('type');
    expect(tab!.trackerTypeId).toBe('module');
    expect(tab!.trackerItemId).toBeUndefined();
    expect(tab!.fileName).toBe('Modules');
    act(() => result.current.removeTab(typeTabId!));
    expect(watchedPaths('start')).not.toContain('type://module');
    expect(watchedPaths('stop')).not.toContain('type://module');
  });

  it('adds a personal page tab with kind/personalDocumentId and never watches or stop-watches it', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    let pageTabId: string | null = null;
    act(() => {
      pageTabId = result.current.addTab('personal://doc-1', '', true, 'Notes');
    });

    const tab = result.current.tabs.find((t) => t.filePath === 'personal://doc-1');
    expect(tab!.kind).toBe('personal-page');
    expect(tab!.personalDocumentId).toBe('doc-1');
    expect(tab!.fileName).toBe('Notes');
    act(() => result.current.removeTab(pageTabId!));
    expect(watchedPaths('start')).not.toContain('personal://doc-1');
    expect(watchedPaths('stop')).not.toContain('personal://doc-1');
  });

  it('still watches real file tabs (file behavior unchanged)', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    act(() => {
      result.current.addTab('/repo/a.ts');
    });

    const tab = result.current.tabs.find((t) => t.filePath === '/repo/a.ts');
    expect(tab!.kind).toBe('file');
    expect(tab!.trackerItemId).toBeUndefined();
    expect(watchedPaths('start')).toContain('/repo/a.ts');
  });

  it('dedups a tracker tab by resource id (opening twice focuses one tab)', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    act(() => {
      result.current.addTab('tracker://T1');
      result.current.addTab('/repo/a.ts');
      result.current.addTab('tracker://T1');
    });

    const trackerTabs = result.current.tabs.filter((t) => t.filePath === 'tracker://T1');
    expect(trackerTabs).toHaveLength(1);
    expect(result.current.tabs).toHaveLength(2);
  });

  it('does not stop-watch a tracker tab on close', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    let trackerId: string | null = null;
    act(() => {
      trackerId = result.current.addTab('tracker://T1');
    });
    act(() => {
      result.current.removeTab(trackerId!);
    });

    expect(watchedPaths('stop')).not.toContain('tracker://T1');
    expect(result.current.tabs.find((t) => t.filePath === 'tracker://T1')).toBeUndefined();
  });

  it('interleaves tracker and file tabs in order', () => {
    const { result } = renderHook(() => useTabs(), { wrapper });

    act(() => {
      result.current.addTab('/repo/a.ts');
      result.current.addTab('tracker://T1');
      result.current.addTab('/repo/b.ts');
    });

    expect(result.current.tabs.map((t) => t.filePath)).toEqual([
      '/repo/a.ts',
      'tracker://T1',
      '/repo/b.ts',
    ]);
  });
});
