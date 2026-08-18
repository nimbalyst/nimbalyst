import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    subscribe: vi.fn(async (_workspacePath: string, _subscriberId: string, _listener: any) => {}),
    unsubscribe: vi.fn(),
    addWatchedPath: vi.fn(),
    removeWatchedPath: vi.fn(),
    getStats: vi.fn(() => ({ type: 'chokidar' })),
    getFolderContents: vi.fn(async () => []),
    getWindowId: vi.fn((window: any) => window?.id ?? null),
    markRecentlyDeleted: vi.fn(),
    windows: new Map<number, any>(),
    windowStates: new Map<number, any>(),
  };
});

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
  windows: mocks.windows,
  windowStates: mocks.windowStates,
}));

vi.mock('../../window/windowState', () => ({
  windowReferencesWorkspace: (state: any, path: string) => {
    if (!state) return false;
    if (state.workspacePath === path) return true;
    return state.additionalWorkspacePaths?.includes(path) === true;
  },
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
    mocks.windows.clear();
    mocks.windowStates.clear();
    watcher = new OptimizedWorkspaceWatcher();
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

    it('start after start replaces the previous subscription (single-active per window)', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');
      await watcher.start(window, '/ws/b');

      // First subscription was unsubscribed before the second one was created.
      expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/a', 'workspace-watcher-1');
      expect(mocks.subscribe).toHaveBeenCalledTimes(2);
      expect(mocks.subscribe).toHaveBeenLastCalledWith(
        '/ws/b',
        'workspace-watcher-1',
        expect.any(Object),
      );
    });

    it('stop releases internal state and unsubscribes', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');

      watcher.stop(1);

      expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/a', 'workspace-watcher-1');
      const stats = watcher.getStats();
      expect(stats.activeWorkspaces).toBe(0);
    });

    it('stop is idempotent', () => {
      expect(() => watcher.stop(99)).not.toThrow();
    });

    it('stopAll tears down every window subscription', async () => {
      await watcher.start(fakeWindow(1), '/ws/a');
      await watcher.start(fakeWindow(2), '/ws/b');

      await watcher.stopAll();

      expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
      expect(watcher.getStats().activeWorkspaces).toBe(0);
    });
  });

  describe('addWatchedFolder', () => {
    it('adds a folder inside the workspace and forwards to the event bus', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');

      watcher.addWatchedFolder(1, '/ws/a/sub');

      expect(mocks.addWatchedPath).toHaveBeenCalledWith('/ws/a', '/ws/a/sub');
    });

    it('rejects folders outside the workspace', async () => {
      const window = fakeWindow(1);
      await watcher.start(window, '/ws/a');

      watcher.addWatchedFolder(1, '/elsewhere/sub');

      expect(mocks.addWatchedPath).not.toHaveBeenCalled();
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
    it('counts active workspaces and reports paths', async () => {
      await watcher.start(fakeWindow(1), '/ws/a');
      await watcher.start(fakeWindow(2), '/ws/b');

      const stats = watcher.getStats();
      expect(stats.activeWorkspaces).toBe(2);
      expect(stats.workspaces.map((w: any) => w.workspacePath).sort()).toEqual(['/ws/a', '/ws/b']);
    });
  });

  describe('startBackground / stopBackground', () => {
    it('subscribes once for a warm (not-visible) rail project', async () => {
      await watcher.startBackground('/ws/warm');

      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
      expect(mocks.subscribe).toHaveBeenCalledWith(
        '/ws/warm',
        'workspace-watcher-bg-/ws/warm',
        expect.any(Object),
      );
      expect(watcher.getBackgroundWatchCount()).toBe(1);
    });

    it('is ref-counted: a second caller for the same path does not re-subscribe', async () => {
      await watcher.startBackground('/ws/warm');
      await watcher.startBackground('/ws/warm');

      expect(mocks.subscribe).toHaveBeenCalledTimes(1);
      expect(watcher.getBackgroundWatchCount()).toBe(1);
    });

    it('does not unsubscribe until every caller has released it', async () => {
      await watcher.startBackground('/ws/warm');
      await watcher.startBackground('/ws/warm');

      watcher.stopBackground('/ws/warm');
      expect(mocks.unsubscribe).not.toHaveBeenCalled();

      watcher.stopBackground('/ws/warm');
      expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/warm', 'workspace-watcher-bg-/ws/warm');
      expect(watcher.getBackgroundWatchCount()).toBe(0);
    });

    it('stopBackground is a no-op for a path that was never backgrounded', () => {
      expect(() => watcher.stopBackground('/ws/never')).not.toThrow();
      expect(mocks.unsubscribe).not.toHaveBeenCalled();
    });

    it('forwards file-changed-on-disk only to windows referencing the path, never a tree rebuild', async () => {
      const visible = fakeWindow(1);
      const unrelated = fakeWindow(2);
      mocks.windows.set(1, visible);
      mocks.windows.set(2, unrelated);
      mocks.windowStates.set(1, { workspacePath: '/ws/warm' });
      mocks.windowStates.set(2, { workspacePath: '/ws/other' });

      await watcher.startBackground('/ws/warm');
      const listener = mocks.subscribe.mock.calls[0][2];

      listener.onChange('/ws/warm/file.md');

      expect(visible.webContents.send).toHaveBeenCalledWith('file-changed-on-disk', { path: '/ws/warm/file.md' });
      expect(unrelated.webContents.send).not.toHaveBeenCalled();
      // The whole point of a background watch: never push a tree rebuild for
      // a project nobody is looking at (the renderer's file tree atom is
      // global, not workspace-scoped -- see WorkspaceWatcher.ts).
      expect(visible.webContents.send).not.toHaveBeenCalledWith(
        'workspace-file-tree-updated',
        expect.anything(),
      );
      expect(mocks.getFolderContents).not.toHaveBeenCalled();
    });

    it('forwards file-deleted and marks the path recently-deleted on unlink', async () => {
      const visible = fakeWindow(1);
      mocks.windows.set(1, visible);
      mocks.windowStates.set(1, { workspacePath: '/ws/warm' });

      await watcher.startBackground('/ws/warm');
      const listener = mocks.subscribe.mock.calls[0][2];

      listener.onUnlink('/ws/warm/deleted.md');

      expect(mocks.markRecentlyDeleted).toHaveBeenCalledWith('/ws/warm/deleted.md');
      expect(visible.webContents.send).toHaveBeenCalledWith('file-changed-on-disk', { path: '/ws/warm/deleted.md' });
      expect(visible.webContents.send).toHaveBeenCalledWith('file-deleted', { filePath: '/ws/warm/deleted.md' });
    });

    it('skips gitignore-bypassed add/unlink notifications (SessionFileWatcher already handles those)', async () => {
      const visible = fakeWindow(1);
      mocks.windows.set(1, visible);
      mocks.windowStates.set(1, { workspacePath: '/ws/warm' });

      await watcher.startBackground('/ws/warm');
      const listener = mocks.subscribe.mock.calls[0][2];

      listener.onAdd('/ws/warm/bypassed.md', true);
      listener.onUnlink('/ws/warm/bypassed.md', true);

      expect(visible.webContents.send).not.toHaveBeenCalled();
      // Deletion tracking still needs to happen regardless of bypass status.
      expect(mocks.markRecentlyDeleted).toHaveBeenCalledWith('/ws/warm/bypassed.md');
    });

    it('stopAll releases every background watch', async () => {
      await watcher.startBackground('/ws/warm-a');
      await watcher.startBackground('/ws/warm-b');

      await watcher.stopAll();

      expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/warm-a', 'workspace-watcher-bg-/ws/warm-a');
      expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/warm-b', 'workspace-watcher-bg-/ws/warm-b');
      expect(watcher.getBackgroundWatchCount()).toBe(0);
    });
  });
});
