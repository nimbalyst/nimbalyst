/**
 * Tests for OffscreenEditorManager
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock Electron
vi.mock('electron', () => {
  const MockBrowserWindow = vi.fn(function () {
    return {
      isDestroyed: () => false,
      on: vi.fn(),
      close: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      loadFile: vi.fn().mockResolvedValue(undefined),
      webContents: {
        send: vi.fn(),
        executeJavaScript: vi.fn().mockResolvedValue(undefined),
      },
    };
  });
  (MockBrowserWindow as any).getAllWindows = vi.fn(() => []);

  const app = {
    getAppPath: vi.fn(() => '/mock/app'),
    isPackaged: false,
  };

  return {
    default: { app },
    app,
    BrowserWindow: MockBrowserWindow,
  };
});

// Mock window routing to keep this as a pure unit test.
vi.mock('../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(() => null),
}));

// Mock logger
vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { OffscreenEditorManager } from '../OffscreenEditorManager';

describe('OffscreenEditorManager', () => {
  let manager: OffscreenEditorManager;

  beforeEach(() => {
    manager = OffscreenEditorManager.getInstance();
    // Clear any existing editors
    manager.cleanup();
  });

  afterEach(() => {
    manager.cleanup();
  });

  it('should be a singleton', () => {
    const instance1 = OffscreenEditorManager.getInstance();
    const instance2 = OffscreenEditorManager.getInstance();
    expect(instance1).toBe(instance2);
  });

  it('should mount an editor', async () => {
    await manager.mountOffscreen('/test/file.excalidraw', '/test');
    expect(manager.isAvailable('/test/file.excalidraw')).toBe(true);
  });

  it('should increment ref count on duplicate mount', async () => {
    await manager.mountOffscreen('/test/file.excalidraw', '/test');
    await manager.mountOffscreen('/test/file.excalidraw', '/test');

    const stats = manager.getStats();
    expect(stats.mounted).toBe(1);
    const cacheEntry = stats.cache.get('/test/file.excalidraw');
    expect(cacheEntry?.refCount).toBe(2);
  });

  it('should schedule unmount when ref count reaches 0', async () => {
    vi.useFakeTimers();

    // mountOffscreen has internal setTimeout waits (1000ms captureWindow + 3000ms mount)
    const mountPromise = manager.mountOffscreen('/test/file.excalidraw', '/test');
    await vi.advanceTimersByTimeAsync(5000);
    await mountPromise;

    manager.unmountOffscreen('/test/file.excalidraw');

    // Should still be available (waiting for TTL)
    expect(manager.isAvailable('/test/file.excalidraw')).toBe(true);

    // Fast-forward past TTL
    vi.advanceTimersByTime(31000);

    // Should be unmounted now
    expect(manager.isAvailable('/test/file.excalidraw')).toBe(false);

    vi.useRealTimers();
  });

  it('should not unmount if ref count > 0', async () => {
    vi.useFakeTimers();

    const mountPromise = manager.mountOffscreen('/test/file.excalidraw', '/test');
    await vi.advanceTimersByTimeAsync(5000);
    await mountPromise;

    await manager.mountOffscreen('/test/file.excalidraw', '/test'); // ref count = 2 (no wait, already mounted)
    manager.unmountOffscreen('/test/file.excalidraw'); // ref count = 1

    // Fast-forward past TTL
    vi.advanceTimersByTime(31000);

    // Should still be mounted (ref count = 1)
    expect(manager.isAvailable('/test/file.excalidraw')).toBe(true);

    vi.useRealTimers();
  });

  it('should evict LRU when cache is full', async () => {
    vi.useFakeTimers();

    // Mount 5 editors (cache limit)
    // First mount needs 5000ms (1000ms captureWindow + 3000ms mount + margin)
    // Subsequent mounts reuse captureWindow, only need 3000ms
    for (let i = 0; i < 5; i++) {
      const mountPromise = manager.mountOffscreen(`/test/file${i}.excalidraw`, '/test');
      await vi.advanceTimersByTimeAsync(5000);
      await mountPromise;
    }

    expect(manager.getStats().mounted).toBe(5);

    // Mount 6th editor - should evict LRU
    const mountPromise = manager.mountOffscreen('/test/file5.excalidraw', '/test');
    await vi.advanceTimersByTimeAsync(5000);
    await mountPromise;

    expect(manager.getStats().mounted).toBe(5);
    // First file should be evicted
    expect(manager.isAvailable('/test/file0.excalidraw')).toBe(false);

    vi.useRealTimers();
  });

  it('should track last used time', async () => {
    vi.useFakeTimers();

    const mountPromise = manager.mountOffscreen('/test/file1.excalidraw', '/test');
    await vi.advanceTimersByTimeAsync(5000);
    await mountPromise;
    const stats1 = manager.getStats();
    const entry1 = stats1.cache.get('/test/file1.excalidraw');
    const firstUsed = entry1?.lastUsed;

    // Advance time
    vi.advanceTimersByTime(5000);

    // Mount again (should update lastUsed) - no wait needed, already mounted
    await manager.mountOffscreen('/test/file1.excalidraw', '/test');
    const stats2 = manager.getStats();
    const entry2 = stats2.cache.get('/test/file1.excalidraw');
    const secondUsed = entry2?.lastUsed;

    expect(secondUsed).not.toEqual(firstUsed);
    expect(secondUsed!.getTime()).toBeGreaterThan(firstUsed!.getTime());

    vi.useRealTimers();
  });
});
