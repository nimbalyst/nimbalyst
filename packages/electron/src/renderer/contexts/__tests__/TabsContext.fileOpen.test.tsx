// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabsProvider, pruneTabsSlot, useTabs } from '../TabsContext';
import { handleWorkspaceFileSelect } from '../../utils/workspaceFileOperations';
import { usePendingFileOpen } from '../../hooks/usePendingFileOpen';
import { initFileOpenListeners, pendingFileOpensAtom } from '../../store/listeners/fileOpenListeners';
import { errorNotificationService } from '../../services/ErrorNotificationService';

vi.mock('../../services/ErrorNotificationService', () => ({ errorNotificationService: { showError: vi.fn(), showWarning: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const savedTabs = { tabs: { tabs: [{ id: 'saved', filePath: '/ws/saved.md', fileName: 'saved.md' }], activeTabId: 'saved' } };

let disposeListener: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); store.set(pendingFileOpensAtom, []); });
afterEach(() => {
  cleanup();
  disposeListener?.();
  disposeListener = undefined;
  pruneTabsSlot('/ws');
  pruneTabsSlot('/other');
  vi.useRealTimers();
});

function Files({ workspacePath }: { workspacePath: string }) {
  usePendingFileOpen(workspacePath, () => {});
  const tabs = useTabs();
  return <div data-testid="files">{tabs.tabs.map(tab => tab.filePath).join(',')}|active:{tabs.activeTab?.filePath}</div>;
}

function Editor({ workspacePath = '/ws', ready = true }: { workspacePath?: string; ready?: boolean }) {
  return <Provider store={store}>{ready && <TabsProvider workspacePath={workspacePath}><Files workspacePath={workspacePath} /></TabsProvider>}</Provider>;
}

function mockTransport(pending: Array<{ requestId: number; path: string; workspacePath: string }>, restore: Promise<any> = Promise.resolve(null)) {
  const handlers = new Set<(data: any) => void>();
  const invoke = vi.fn(async (channel: string, workspacePath: string, id?: number) => {
    if (channel === 'workspace:get-state') return workspacePath === '/ws' ? restore : null;
    if (channel === 'file:pending-opens') return pending.filter(request => request.workspacePath === workspacePath).map(request => ({ ...request }));
    if (channel === 'file:acknowledge-open') {
      const index = pending.findIndex(request => request.requestId === id && request.workspacePath === workspacePath);
      if (index !== -1) pending.splice(index, 1);
    }
  });
  const switchWorkspaceFile = vi.fn(async (filePath: string) => ({ filePath, content: `content:${filePath}` }));
  window.electronAPI = {
    invoke, switchWorkspaceFile, send: vi.fn(),
    on: vi.fn((_channel: string, handler: (data: any) => void) => { handlers.add(handler); return () => handlers.delete(handler); }),
  } as any;
  return { invoke, switchWorkspaceFile, handlers };
}

describe('file opens during tab initialization', () => {
  it('recovers an early request and waits for the workspace, editor and saved tabs before draining multiple opens', async () => {
    const restore = deferred<any>();
    const pending = [{ requestId: 1, path: '/ws/first.md', workspacePath: '/ws' }];
    const transport = mockTransport(pending, restore.promise);
    // Request 1 existed before listener registration, so only the pull can recover it.
    disposeListener = initFileOpenListeners();
    const view = render(<Editor ready={false} />);
    const second = { requestId: 2, path: '/ws/second.md', workspacePath: '/ws' };
    pending.push(second);
    act(() => transport.handlers.forEach(handler => handler(second)));
    expect(transport.switchWorkspaceFile).not.toHaveBeenCalled();
    view.rerender(<Editor />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(transport.switchWorkspaceFile).not.toHaveBeenCalled();
    expect(pending).toHaveLength(2);
    await act(async () => { restore.resolve(savedTabs); });
    expect(transport.switchWorkspaceFile.mock.calls.map(call => call[0])).toEqual(['/ws/first.md', '/ws/second.md']);
    expect(view.getByTestId('files').textContent).toBe('/ws/saved.md,/ws/first.md,/ws/second.md|active:/ws/second.md');
    expect(pending).toEqual([]);
  });

  it('retains a cancelled in-flight request through listener/editor remount and never puts it in another workspace', async () => {
    const pending = [{ requestId: 3, path: '/ws/first.md', workspacePath: '/ws' }];
    const transport = mockTransport(pending);
    const read = deferred<any>();
    transport.switchWorkspaceFile.mockImplementationOnce(() => read.promise);
    disposeListener = initFileOpenListeners();
    const view = render(<Editor />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(transport.switchWorkspaceFile).toHaveBeenCalledTimes(1);
    view.rerender(<Editor workspacePath="/other" />);
    disposeListener();
    disposeListener = initFileOpenListeners();
    await act(async () => { read.resolve({ filePath: '/ws/first.md', content: 'old' }); await vi.advanceTimersByTimeAsync(500); });
    expect(view.getByTestId('files').textContent).toBe('|active:');
    expect(pending).toHaveLength(1);
    view.rerender(<Editor />);
    await act(async () => {});
    expect(view.getByTestId('files').textContent).toBe('/ws/first.md|active:/ws/first.md');
    expect(pending).toEqual([]);
  });

  it('delivers live opens after readiness and repeated opens select one existing tab', async () => {
    const pending: Array<{ requestId: number; path: string; workspacePath: string }> = [];
    const transport = mockTransport(pending);
    disposeListener = initFileOpenListeners();
    const view = render(<Editor />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    for (const requestId of [4, 5]) {
      const request = { requestId, path: '/ws/live.md', workspacePath: '/ws' };
      pending.push(request);
      await act(async () => { transport.handlers.forEach(handler => handler(request)); });
    }
    expect(view.getByTestId('files').textContent).toBe('/ws/live.md|active:/ws/live.md');
    expect(transport.switchWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(pending).toEqual([]);
  });

  it('reports an unreadable file and continues with the following request', async () => {
    const pending = [
      { requestId: 6, path: '/ws/missing.md', workspacePath: '/ws' },
      { requestId: 7, path: '/ws/valid.md', workspacePath: '/ws' },
    ];
    const transport = mockTransport(pending);
    transport.switchWorkspaceFile.mockResolvedValueOnce({ error: 'File does not exist' } as any);
    disposeListener = initFileOpenListeners();
    const view = render(<Editor />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(errorNotificationService.showWarning).toHaveBeenCalledWith('Cannot Open File', 'File does not exist', { duration: 5000 });
    expect(view.getByTestId('files').textContent).toBe('/ws/valid.md|active:/ws/valid.md');
    expect(pending).toEqual([]);
  });

  it('keeps draining when an acknowledgement fails', async () => {
    const pending = [
      { requestId: 10, path: '/ws/first.md', workspacePath: '/ws' },
      { requestId: 11, path: '/ws/second.md', workspacePath: '/ws' },
    ];
    const transport = mockTransport(pending);
    const invoke = transport.invoke.getMockImplementation()!;
    transport.invoke.mockImplementation(async (channel, workspacePath, id) => {
      if (channel === 'file:acknowledge-open' && id === 10) throw new Error('ack failed');
      return invoke(channel, workspacePath, id);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      disposeListener = initFileOpenListeners();
      const view = render(<Editor />);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(view.getByTestId('files').textContent).toBe('/ws/first.md,/ws/second.md|active:/ws/second.md');
      expect(store.get(pendingFileOpensAtom)).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it('ignores a restore response from a disposed provider and retries hydration on remount', async () => {
    const restore = deferred<any>();
    const transport = mockTransport([], restore.promise);
    disposeListener = initFileOpenListeners();
    const view = render(<Editor />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    view.rerender(<Editor ready={false} />);
    await act(async () => { restore.resolve(savedTabs); });
    view.rerender(<Editor />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(view.getByTestId('files').textContent).toBe('/ws/saved.md|active:/ws/saved.md');
    expect(transport.invoke.mock.calls.filter(call => call[0] === 'workspace:get-state')).toHaveLength(2);
  });

  it('opens files after failed restoration without saving over unknown tabs, then retries and merges on remount', async () => {
    const restore = deferred<any>();
    const pending = [{ requestId: 9, path: '/ws/new.md', workspacePath: '/ws' }];
    const transport = mockTransport(pending, restore.promise);
    const invoke = transport.invoke.getMockImplementation()!;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      disposeListener = initFileOpenListeners();
      const view = render(<Editor />);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      await act(async () => { restore.reject(new Error('state unavailable')); });
      expect(view.getByTestId('files').textContent).toBe('/ws/new.md|active:/ws/new.md');
      expect(pending).toEqual([]);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(transport.invoke.mock.calls.filter(call => call[0] === 'workspace:update-state')).toEqual([]);

      view.rerender(<Editor ready={false} />);
      transport.invoke.mockImplementation(async (channel, workspacePath, id) => channel === 'workspace:get-state' ? savedTabs : invoke(channel, workspacePath, id));
      view.rerender(<Editor />);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(view.getByTestId('files').textContent).toBe('/ws/saved.md,/ws/new.md|active:/ws/new.md');
      expect(transport.invoke.mock.calls.filter(call => call[0] === 'workspace:get-state')).toHaveLength(2);
      const writes = transport.invoke.mock.calls.filter(call => call[0] === 'workspace:update-state');
      expect(writes.length).toBeGreaterThan(0);
      expect((writes.at(-1)![2] as any).tabs.tabs.map((tab: any) => tab.filePath)).toEqual(['/ws/saved.md', '/ws/new.md']);
    } finally {
      log.mockRestore();
    }
  });

  it('does not replay an acknowledged request from a late snapshot after remount', async () => {
    const request = { requestId: 8, path: '/ws/once.md', workspacePath: '/ws' };
    const transport = mockTransport([request]);
    const stale = deferred<any>();
    const invoke = transport.invoke.getMockImplementation()!;
    transport.invoke.mockImplementationOnce(() => stale.promise);
    disposeListener = initFileOpenListeners();
    const view = render(<Editor />);
    await act(async () => {});
    view.rerender(<Editor ready={false} />);
    transport.invoke.mockImplementation(invoke);
    view.rerender(<Editor />);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(store.get(pendingFileOpensAtom)).toEqual([]);
    await act(async () => { stale.resolve([request]); });
    expect(store.get(pendingFileOpensAtom)).toEqual([]);
    expect(transport.invoke.mock.calls.filter(call => call[0] === 'file:acknowledge-open')).toHaveLength(1);
  });

  it('preserves a newly opened and selected file when delayed saved tabs arrive', async () => {
    const restore = deferred<any>();
    window.electronAPI = { invoke: vi.fn((channel: string) => channel === 'workspace:get-state' ? restore.promise : Promise.resolve()), send: vi.fn() } as any;
    const { result } = renderHook(() => useTabs(), {
      wrapper: ({ children }) => <TabsProvider workspacePath="/ws">{children}</TabsProvider>,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => { result.current.addTab('/ws/new.md', 'new content'); });
    await act(async () => { restore.resolve(savedTabs); });
    expect(result.current.tabs.map(tab => tab.filePath)).toEqual(['/ws/saved.md', '/ws/new.md']);
    expect(result.current.activeTab?.filePath).toBe('/ws/new.md');
    expect(result.current.activeTab?.content).toBe('new content');
    expect(vi.mocked(window.electronAPI.invoke).mock.calls.filter(call => call[0] === 'start-watching-file' && call[1] === '/ws/new.md')).toHaveLength(1);
  });

  it('keeps a saved tab pin and position when the same file is opened during restoration', async () => {
    const restore = deferred<any>();
    window.electronAPI = { invoke: vi.fn((channel: string) => channel === 'workspace:get-state' ? restore.promise : Promise.resolve()), send: vi.fn() } as any;
    const { result } = renderHook(() => useTabs(), {
      wrapper: ({ children }) => <TabsProvider workspacePath="/ws">{children}</TabsProvider>,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => { result.current.addTab('/ws/first.md', 'live content'); });
    await act(async () => {
      restore.resolve({ tabs: { tabs: [
        { id: 'pinned', filePath: '/ws/first.md', fileName: 'first.md', isPinned: true },
        { id: 'saved', filePath: '/ws/saved.md', fileName: 'saved.md' },
      ], activeTabId: 'saved' } });
    });
    expect(result.current.tabs.map(tab => [tab.filePath, Boolean(tab.isPinned)])).toEqual([['/ws/first.md', true], ['/ws/saved.md', false]]);
    expect(result.current.activeTab?.filePath).toBe('/ws/first.md');
    expect(result.current.activeTab?.content).toBe('live content');
  });

  it('does not finish an asynchronous open in a replacement workspace/editor', async () => {
    const read = deferred<any>();
    window.electronAPI = { switchWorkspaceFile: vi.fn(() => read.promise) } as any;
    const tabs = { findTabByPath: () => undefined, addTab: vi.fn(() => 'tab') };
    let mounted = true;
    const opening = handleWorkspaceFileSelect({ filePath: '/ws/new.md', currentFilePath: null, tabs, isInitializedRef: { current: false }, isCurrent: () => mounted });
    mounted = false;
    read.resolve({ filePath: '/ws/new.md', content: 'new' });
    await opening;
    expect(tabs.addTab).not.toHaveBeenCalled();
  });
});
