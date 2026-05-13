import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(),
    addWatchedPath: vi.fn(),
    removeWatchedPath: vi.fn(),
    getStats: vi.fn(() => ({ type: 'chokidar' })),
    getFolderContents: vi.fn(async () => []),
    getWindowId: vi.fn((window: any) => window?.id ?? null),
    markRecentlyDeleted: vi.fn(),
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
});
