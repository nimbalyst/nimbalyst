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
