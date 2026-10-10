// @vitest-environment node
import type { FileTreeItem } from '../../types';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    subscribe: vi.fn(async (_root: string, _subscriber: string, _callbacks: any) => {}),
    unsubscribe: vi.fn(),
    addWatchedPath: vi.fn(),
    removeWatchedPath: vi.fn(),
    getStats: vi.fn(() => ({ type: 'chokidar', activeWorkspaces: 1, workspaces: [] })),
    getFolderContents: vi.fn<(_root: string, _depth?: number, signal?: AbortSignal) => Promise<FileTreeItem[]>>(async () => []),
    getWindowId: vi.fn((window: any) => window?.id ?? null),
    markRecentlyDeleted: vi.fn(),
    scan: vi.fn(async () => [] as Array<{ path: string; name: string; type: 'file' }>),
  };
});

vi.mock('../QuickOpenFileScanner', () => ({ buildQuickOpenCacheForRoot: mocks.scan }));

vi.mock('electron', () => ({
  BrowserWindow: class FakeBrowserWindow {},
}));

vi.mock('../WorkspaceEventBus', () => ({
  subscribe: mocks.subscribe,
  unsubscribe: mocks.unsubscribe,
  addWatchedPath: mocks.addWatchedPath,
  removeWatchedPath: mocks.removeWatchedPath,
  getStats: mocks.getStats,
}));

vi.mock('../../utils/FileTree', () => ({
  getFolderContents: mocks.getFolderContents,
}));

vi.mock('../../window/WindowManager', () => ({
  getWindowId: mocks.getWindowId,
  markRecentlyDeleted: mocks.markRecentlyDeleted,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    workspaceWatcher: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { OptimizedWorkspaceWatcher } from '../OptimizedWorkspaceWatcher';
import { quickOpenFileNameCache } from '../QuickOpenFileNameCache';

function fakeWindow(id: number) {
  return {
    id,
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as any;
}

describe('OptimizedWorkspaceWatcher', () => {
  let watcher: OptimizedWorkspaceWatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    watcher = new OptimizedWorkspaceWatcher();
  });

  it('refreshes search snapshots after add, rename/delete and watcher recovery without Quick Open', async () => {
    const root = '/ws/mention-cache';
    const file = (name: string) => ({ path: `${root}/${name}`, name, type: 'file' as const });
    mocks.scan.mockResolvedValue([file('old.md')]);
    await watcher.start(fakeWindow(1), root);
    const listener = (mocks.subscribe.mock.calls[0] as unknown as [string, string, any])[2];
    expect(await quickOpenFileNameCache.get(root)).toEqual([file('old.md')]);
    try {
      mocks.scan.mockResolvedValue([file('old.md'), file('new.md')]);
      listener.onAdd(`${root}/new.md`);
      expect(await quickOpenFileNameCache.get(root)).toEqual([file('old.md'), file('new.md')]);

      mocks.scan.mockResolvedValue([file('renamed.md')]);
      listener.onUnlink(`${root}/old.md`);
      listener.onUnlink(`${root}/new.md`);
      listener.onAdd(`${root}/renamed.md`);
      expect(await quickOpenFileNameCache.get(root)).toEqual([file('renamed.md')]);

      listener.onHealthChanged({ state: 'recovering', generation: 1 });
      mocks.scan.mockResolvedValue([file('created-during-outage.md')]);
      listener.onHealthChanged({ state: 'watching', generation: 2 });
      expect(await quickOpenFileNameCache.get(root)).toEqual([file('created-during-outage.md')]);
    } finally {
      watcher.stop(1);
    }
  });

  afterEach(() => {
    watcher.stopAll();
    vi.useRealTimers();
    mocks.getFolderContents.mockReset().mockResolvedValue([]);
  });

  describe('slow file-tree scans', () => {
    it('coalesces changes during a scan into one follow-up without overlapping scans', async () => {
      vi.useFakeTimers();
      const pending: Array<(tree: any[]) => void> = [];
      mocks.getFolderContents.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/large');
      const events = mocks.subscribe.mock.calls[0][2] as any;
      events.onAdd('/ws/large/first.md');
      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.getFolderContents).toHaveBeenCalledTimes(1);

      for (let i = 0; i < 5; i++) {
        events.onAdd(`/ws/large/${i}.md`);
        await vi.advanceTimersByTimeAsync(600);
      }
      expect(mocks.getFolderContents).toHaveBeenCalledTimes(1);
      pending.shift()!([]);
      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.getFolderContents).toHaveBeenCalledTimes(2);
      pending.shift()!([]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(mocks.getFolderContents).toHaveBeenCalledTimes(2);
    });

    it('runs the pending refresh after a failed scan and keeps roots independent', async () => {
      vi.useFakeTimers();
      let fail!: (error: Error) => void;
      mocks.getFolderContents.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/b');
      const a = mocks.subscribe.mock.calls[0][2];
      const b = mocks.subscribe.mock.calls[1][2];
      a.onAdd('/ws/a/one.md');
      await vi.advanceTimersByTimeAsync(500);
      a.onUnlink('/ws/a/one.md');
      b.onAdd('/ws/b/two.md');
      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.getFolderContents.mock.calls.map(call => call[0])).toEqual(['/ws/a', '/ws/b']);
      fail(new Error('filesystem read failed'));
      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.getFolderContents.mock.calls.map(call => call[0])).toEqual(['/ws/a', '/ws/b', '/ws/a']);
    });

    it('discards a stopped root scan even if that root is immediately watched again', async () => {
      vi.useFakeTimers();
      let finish!: (tree: any[]) => void;
      mocks.getFolderContents.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/large');
      const events = mocks.subscribe.mock.calls[0][2] as any;
      events.onAdd('/ws/large/first.md');
      await vi.advanceTimersByTimeAsync(500);
      events.onAdd('/ws/large/second.md');
      watcher.stopRoot(1, '/ws/large');
      expect(mocks.getFolderContents.mock.calls[0][2]?.aborted).toBe(true);
      await watcher.start(window, '/ws/large');
      finish([{ name: 'stale.md', type: 'file', path: '/ws/large/stale.md' }]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(window.webContents.send).not.toHaveBeenCalledWith('workspace-file-tree-updated', expect.anything());
      expect(mocks.getFolderContents).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle', () => {
    it('start subscribes to the workspace event bus once', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');

      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
      expect(mocks.subscribe).toHaveBeenCalledWith(
        '/ws/a',
        'workspace-watcher-1',
        expect.any(Object),
      );
    });

    it('start after start adds a second root rather than replacing the first', async () => {
      // A multi-root window watches its primary root and every attached folder
      // at once. If start still replaced, attaching a folder would silently
      // stop watching the project you actually opened.
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/b');

      expect(mocks.unsubscribe).not.toHaveBeenCalled();
      expect(mocks.subscribe).toHaveBeenCalledTimes(2);
      expect(watcher.getRoots(1)).toEqual(['/ws/a', '/ws/b']);
    });

    it('starting the same root twice does not double-subscribe', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/a');

      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
      expect(watcher.getRoots(1)).toEqual(['/ws/a']);
    });

    it('stopRoot detaches one root and leaves the others watching', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/b');

      watcher.stopRoot(1, '/ws/b');

      expect(mocks.unsubscribe).toHaveBeenCalledExactlyOnceWith('/ws/b', 'workspace-watcher-1');
      expect(watcher.getRoots(1)).toEqual(['/ws/a']);
    });

    it('stop releases internal state and unsubscribes every root', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/b');

      watcher.stop(1);

      expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/a', 'workspace-watcher-1');
      expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/b', 'workspace-watcher-1');
      const stats = watcher.getStats();
      expect(stats.registeredWorkspaces).toBe(0);
    });

    it('stop is idempotent', () => {
      expect(() => watcher.stop(99)).not.toThrow();
    });

    it('stopAll tears down every window subscription', async () => {
      await watcher.start(fakeWindow(1), '/ws/a');
      await watcher.start(fakeWindow(2), '/ws/b');

      await watcher.stopAll();

      expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
      expect(watcher.getStats().registeredWorkspaces).toBe(0);
    });
  });

  describe('addWatchedFolder', () => {
    it('adds a folder inside the workspace and forwards to the event bus', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');

      watcher.addWatchedFolder(1, '/ws/a/sub');

      expect(mocks.addWatchedPath).toHaveBeenCalledWith('/ws/a', '/ws/a/sub');
    });

    it('rejects folders outside every root', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');

      watcher.addWatchedFolder(1, '/elsewhere/sub');

      expect(mocks.addWatchedPath).not.toHaveBeenCalled();
    });

    it('routes an expanded folder to the root that owns it', async () => {
      // The bus is keyed by root, so expanding a folder in an attached folder
      // has to reach that folder's subscription, not the primary root's.
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/b');

      watcher.addWatchedFolder(1, '/ws/b/sub');

      expect(mocks.addWatchedPath).toHaveBeenCalledExactlyOnceWith('/ws/b', '/ws/b/sub');
    });

    it('re-adds an expanded folder after its root is detached and re-attached', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/b');
      watcher.addWatchedFolder(1, '/ws/b/sub');

      watcher.stopRoot(1, '/ws/b');
      await watcher.start(window, '/ws/b');
      mocks.addWatchedPath.mockClear();
      watcher.addWatchedFolder(1, '/ws/b/sub');

      expect(mocks.addWatchedPath).toHaveBeenCalledExactlyOnceWith('/ws/b', '/ws/b/sub');
    });

    it('is a no-op for an unknown windowId', () => {
      watcher.addWatchedFolder(99, '/ws/a/sub');
      expect(mocks.addWatchedPath).not.toHaveBeenCalled();
    });
  });

  describe('removeWatchedFolder', () => {
    it('removes a previously watched folder and notifies the event bus', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      watcher.addWatchedFolder(1, '/ws/a/sub');
      mocks.addWatchedPath.mockClear();

      watcher.removeWatchedFolder(1, '/ws/a/sub');

      expect(mocks.removeWatchedPath).toHaveBeenCalledWith('/ws/a', '/ws/a/sub');
    });

    it('is a no-op for a folder that was never added', async () => {
      await watcher.start(fakeWindow(1), '/ws/a');
      watcher.removeWatchedFolder(1, '/ws/a/never-added');
      expect(mocks.removeWatchedPath).not.toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('distinguishes native health from registered window roots', async () => {
      await watcher.start(fakeWindow(1), '/ws/a');
      await watcher.start(fakeWindow(2), '/ws/b');

      const stats = watcher.getStats();
      expect(stats.registeredWorkspaces).toBe(2);
      expect(stats.activeWorkspaces).toBe(1);
      expect(stats.workspaces.map((w: any) => w.workspacePath).sort()).toEqual(['/ws/a', '/ws/b']);
    });
  });
});
