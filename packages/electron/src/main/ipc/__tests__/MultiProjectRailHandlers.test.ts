// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WindowState } from '../../types';

/**
 * Mocks must use `vi.hoisted` so the references they expose survive the
 * module-mock hoisting that vitest performs. Top-level `const` references
 * inside the factories would be `undefined` at mock evaluation time.
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: any, data: any) => Promise<any>>();
  return {
    handlers,
    notifyWorkspaceUsageChanged: vi.fn(),
    startWorkspaceWatcher: vi.fn(),
    stopWorkspaceWatcher: vi.fn(),
    stopProjectFileSync: vi.fn(),
    setFileSystemService: vi.fn(),
    clearFileSystemService: vi.fn(),
    setFileSystemServiceFor: vi.fn(),
    clearFileSystemServiceFor: vi.fn(),
    documentServices: new Map<string, any>(),
    fileSystemServices: new Map<string, any>(),
    windowStates: new Map<number, WindowState>(),
    addToRecentItems: vi.fn(),
    getWorkspaceNavigationHistory: vi.fn(() => null),
    setupDocumentServiceHandlers: vi.fn(),
    addNimAssetRoot: vi.fn(),
    getMcpConfigService: vi.fn(() => ({ stopWatchingWorkspaceConfig: vi.fn() })),
    restoreNavigationState: vi.fn(),
    fakeBrowserWindowId: 1,
    windows: new Map<number, any>(),
    openWorkspaceWindow: vi.fn().mockResolvedValue({ success: true }),
    cursor: { x: 0, y: 0 },
    windowBounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
  };
});

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: any, data: any) => Promise<any>) => {
    mocks.handlers.set(channel, fn);
  },
}));

vi.mock('../../file/WorkspaceWatcher.ts', () => ({
  startWorkspaceWatcher: mocks.startWorkspaceWatcher,
  stopWorkspaceWatcher: mocks.stopWorkspaceWatcher,
  stopProjectFileSync: mocks.stopProjectFileSync,
}));

vi.mock('@nimbalyst/runtime', () => ({
  setFileSystemService: mocks.setFileSystemService,
  clearFileSystemService: mocks.clearFileSystemService,
  setFileSystemServiceFor: mocks.setFileSystemServiceFor,
  clearFileSystemServiceFor: mocks.clearFileSystemServiceFor,
}));

vi.mock('../../protocols/nimAssetProtocol', () => ({
  addNimAssetRoot: mocks.addNimAssetRoot,
}));

vi.mock('../../utils/store', () => ({
  addToRecentItems: mocks.addToRecentItems,
  getWorkspaceNavigationHistory: mocks.getWorkspaceNavigationHistory,
}));

vi.mock('../../services/NavigationHistoryService', () => ({
  navigationHistoryService: { restoreNavigationState: mocks.restoreNavigationState },
}));

vi.mock('../../index', () => ({
  getMcpConfigService: mocks.getMcpConfigService,
}));

vi.mock('../../window/WindowManager', () => ({
  documentServices: mocks.documentServices,
  windowStates: mocks.windowStates,
  getWindowId: (window: any) => window?.id ?? null,
}));

vi.mock('../../window/WorkspaceManagerWindow', () => ({
  openWorkspaceWindow: mocks.openWorkspaceWindow,
}));

vi.mock('../../window/windowState', () => ({
  windowStates: mocks.windowStates,
  windows: mocks.windows,
  getWindowIdForWindow: (window: any) => window?.id ?? null,
  resolveActiveWorkspacePath: (state: WindowState | undefined) => {
    if (!state) return null;
    return state.activeWorkspacePath ?? state.workspacePath;
  },
  windowReferencesWorkspace: (state: WindowState | undefined, path: string) => {
    if (!state) return false;
    if (state.workspacePath === path) return true;
    return state.additionalWorkspacePaths?.includes(path) === true;
  },
  anyWindowReferencesWorkspace: (path: string, excludeWindowId?: number) => {
    for (const [id, state] of mocks.windowStates) {
      if (excludeWindowId !== undefined && id === excludeWindowId) continue;
      if (state.workspacePath === path) return true;
      if (state.additionalWorkspacePaths?.includes(path)) return true;
    }
    return false;
  },
}));

vi.mock('../../window/serviceRegistry', () => ({
  fileSystemServices: mocks.fileSystemServices,
  getFileSystemService: (workspacePath: string) => mocks.fileSystemServices.get(workspacePath),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: () => true };
});

class FakeService {
  destroy = vi.fn();
}

vi.mock('../../services/ElectronDocumentService', () => ({
  ElectronDocumentService: vi.fn(function () {
    return new FakeService();
  }),
  setupDocumentServiceHandlers: mocks.setupDocumentServiceHandlers,
}));

vi.mock('../../services/ElectronFileSystemService', () => ({
  ElectronFileSystemService: vi.fn(function () {
    return new FakeService();
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: () => ({ id: mocks.fakeBrowserWindowId }),
    getAllWindows: () => mocks.windowBounds.map(bounds => ({
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      getBounds: () => bounds,
    })),
  },
  screen: { getCursorScreenPoint: () => mocks.cursor },
}));

vi.mock('../../file/GitWatcherLifecycle', () => ({ notifyWorkspaceUsageChanged: mocks.notifyWorkspaceUsageChanged, pruneUnusedGitWatchers: vi.fn().mockResolvedValue(undefined), releaseWhenWorkspaceUnused: (path: string, release: () => void) => { if (![...mocks.windowStates.values()].some(s => s.workspacePath === path || s.additionalWorkspacePaths?.includes(path))) release(); } }));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
  },
}));

// Imported AFTER mocks are wired so `safeHandle` calls capture into our map.
import { registerMultiProjectRailHandlers } from '../MultiProjectRailHandlers';

function makeState(partial: Partial<WindowState> = {}): WindowState {
  return {
    mode: 'workspace',
    filePath: null,
    workspacePath: null,
    documentEdited: false,
    ...partial,
  };
}

function event() {
  return { sender: {} as any };
}

async function invoke(channel: string, data: any, windowId: number) {
  mocks.fakeBrowserWindowId = windowId;
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler(event(), data);
}

describe('MultiProjectRailHandlers', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.documentServices.clear();
    mocks.fileSystemServices.clear();
    mocks.windowStates.clear();
    mocks.startWorkspaceWatcher.mockReset();
    mocks.stopWorkspaceWatcher.mockReset();
    mocks.stopProjectFileSync.mockReset();
    mocks.notifyWorkspaceUsageChanged.mockReset();
    mocks.setFileSystemService.mockReset();
    mocks.clearFileSystemService.mockReset();
    registerMultiProjectRailHandlers();
  });

  describe('workspace:register-additional', () => {
    it('rejects missing workspacePath', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/a' }));
      const result = await invoke('workspace:register-additional', { workspacePath: '' }, 1);
      expect(result).toMatchObject({ success: false });
    });

    it('creates services and tracks the path as additional', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/a' }));

      const result = await invoke(
        'workspace:register-additional',
        { workspacePath: '/ws/b' },
        1
      );

      expect(result).toMatchObject({ success: true });
      expect(mocks.documentServices.has('/ws/b')).toBe(true);
      expect(mocks.fileSystemServices.has('/ws/b')).toBe(true);
      expect(mocks.windowStates.get(1)?.additionalWorkspacePaths).toEqual(['/ws/b']);
      expect(mocks.notifyWorkspaceUsageChanged).toHaveBeenCalledTimes(1);
    });

    it('does NOT start the watcher (regression guard for fix #1)', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/a' }));
      await invoke('workspace:register-additional', { workspacePath: '/ws/b' }, 1);
      expect(mocks.startWorkspaceWatcher).not.toHaveBeenCalled();
    });

    it('does NOT flip the global FileSystemService (regression guard for fix #3)', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/a' }));
      await invoke('workspace:register-additional', { workspacePath: '/ws/b' }, 1);
      expect(mocks.setFileSystemService).not.toHaveBeenCalled();
    });

    it('is idempotent for an already-registered path', async () => {
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
      }));

      const result = await invoke(
        'workspace:register-additional',
        { workspacePath: '/ws/b' },
        1
      );

      expect(result).toMatchObject({ success: true, alreadyRegistered: true });
      expect(mocks.windowStates.get(1)?.additionalWorkspacePaths).toEqual(['/ws/b']);
    });
  });

  describe('workspace:set-active', () => {
    beforeEach(() => {
      mocks.windowStates.set(
        1,
        makeState({ workspacePath: '/ws/a', additionalWorkspacePaths: ['/ws/b'] })
      );
      mocks.fileSystemServices.set('/ws/a', new FakeService() as any);
      mocks.fileSystemServices.set('/ws/b', new FakeService() as any);
    });

    it('rejects an unregistered path', async () => {
      const result = await invoke('workspace:set-active', { workspacePath: '/ws/never' }, 1);
      expect(result).toMatchObject({ success: false });
      expect(mocks.startWorkspaceWatcher).not.toHaveBeenCalled();
    });

    it('flips watcher and FS global on transition', async () => {
      // Make /ws/a the current active first.
      await invoke('workspace:set-active', { workspacePath: '/ws/a' }, 1);
      mocks.stopWorkspaceWatcher.mockClear();
      mocks.startWorkspaceWatcher.mockClear();
      mocks.setFileSystemService.mockClear();

      const result = await invoke('workspace:set-active', { workspacePath: '/ws/b' }, 1);

      expect(result).toMatchObject({ success: true });
      // Doc sync for /ws/a stays connected: the project is still open in the rail,
      // and restarting it rescans every synced file on each switch.
      expect(mocks.stopWorkspaceWatcher).toHaveBeenCalledWith(1, { keepProjectFileSync: true });
      expect(mocks.startWorkspaceWatcher).toHaveBeenCalledWith(expect.anything(), '/ws/b');
      expect(mocks.setFileSystemService).toHaveBeenCalledTimes(1);
      expect(mocks.windowStates.get(1)?.activeWorkspacePath).toBe('/ws/b');
    });

    it('is idempotent when the path is already active', async () => {
      await invoke('workspace:set-active', { workspacePath: '/ws/a' }, 1);
      mocks.stopWorkspaceWatcher.mockClear();
      mocks.startWorkspaceWatcher.mockClear();

      const result = await invoke('workspace:set-active', { workspacePath: '/ws/a' }, 1);

      expect(result).toMatchObject({ alreadyActive: true });
      expect(mocks.stopWorkspaceWatcher).not.toHaveBeenCalled();
      expect(mocks.startWorkspaceWatcher).not.toHaveBeenCalled();
    });
  });

  describe('workspace:unregister-additional', () => {
    beforeEach(() => {
      mocks.windowStates.set(
        1,
        makeState({
          workspacePath: '/ws/primary',
          additionalWorkspacePaths: ['/ws/warm'],
          activeWorkspacePath: '/ws/primary',
        })
      );
      mocks.fileSystemServices.set('/ws/warm', new FakeService() as any);
      mocks.documentServices.set('/ws/warm', new FakeService() as any);
    });

    it('releases the startup project and promotes a remaining project', async () => {
      mocks.fileSystemServices.set('/ws/primary', new FakeService() as any);
      mocks.documentServices.set('/ws/primary', new FakeService() as any);
      await invoke('workspace:unregister-additional', { workspacePath: '/ws/primary' }, 1);
      expect(mocks.windowStates.get(1)?.workspacePath).toBe('/ws/warm');
      expect(mocks.windowStates.get(1)?.additionalWorkspacePaths).toEqual([]);
      expect(mocks.documentServices.has('/ws/primary')).toBe(false);
      expect(mocks.fileSystemServices.has('/ws/primary')).toBe(false);
      await invoke('workspace:set-active', { workspacePath: '/ws/warm' }, 1);
      expect(mocks.startWorkspaceWatcher).toHaveBeenCalledWith(expect.anything(), '/ws/warm');
    });

    it('removes the path from additionalWorkspacePaths', async () => {
      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(mocks.windowStates.get(1)?.additionalWorkspacePaths).toEqual([]);
    });

    it('destroys services when no other window references the path', async () => {
      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(mocks.documentServices.has('/ws/warm')).toBe(false);
      expect(mocks.fileSystemServices.has('/ws/warm')).toBe(false);
    });

    it('keeps services alive when another window still references the path', async () => {
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/warm' }));

      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(mocks.documentServices.has('/ws/warm')).toBe(true);
      expect(mocks.fileSystemServices.has('/ws/warm')).toBe(true);
      expect(mocks.stopProjectFileSync).not.toHaveBeenCalled();
    });

    it('does not stop the watcher when the closed path was not active', async () => {
      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(mocks.stopWorkspaceWatcher).not.toHaveBeenCalled();
      expect(mocks.clearFileSystemService).not.toHaveBeenCalled();
    });

    it('stops watcher and clears FS global only when closing the active path', async () => {
      mocks.windowStates.set(
        1,
        makeState({
          workspacePath: '/ws/primary',
          additionalWorkspacePaths: ['/ws/warm'],
          activeWorkspacePath: '/ws/warm',
        })
      );

      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(mocks.stopWorkspaceWatcher).toHaveBeenCalledWith(1, { keepProjectFileSync: true });
      expect(mocks.clearFileSystemService).toHaveBeenCalled();
      expect(mocks.windowStates.get(1)?.activeWorkspacePath).toBeNull();
      expect(mocks.stopProjectFileSync).toHaveBeenCalledWith('/ws/warm');
    });
  });

  describe('dragging a rail project between windows', () => {
    const sourceSend = vi.fn();

    beforeEach(() => {
      sourceSend.mockReset();
      mocks.openWorkspaceWindow.mockClear();
      mocks.windows.clear();
      mocks.windows.set(1, { isDestroyed: () => false, webContents: { send: sourceSend } });
      mocks.windowBounds = [{ x: 0, y: 0, width: 800, height: 600 }, { x: 900, y: 0, width: 800, height: 600 }];
    });

    it('releases the project from the source window when another window receives it', async () => {
      await invoke('workspace:rail-drag-start', { workspacePath: '/ws/b' }, 1);
      // The source's drag end can arrive before the target's report; it must not consume the drag.
      mocks.cursor = { x: 1000, y: 100 };
      await invoke('workspace:rail-drag-end', { workspacePath: '/ws/b', dropEffect: 'move', isOnlyProject: false }, 1);
      const result = await invoke('workspace:rail-drag-received', { workspacePath: '/ws/b' }, 2);

      expect(result).toMatchObject({ success: true });
      expect(sourceSend).toHaveBeenCalledWith('workspace:rail-release-project', { workspacePath: '/ws/b' });
      expect(mocks.openWorkspaceWindow).not.toHaveBeenCalled();
    });

    it('ignores a drop report from the window the drag started in', async () => {
      await invoke('workspace:rail-drag-start', { workspacePath: '/ws/b' }, 1);
      const result = await invoke('workspace:rail-drag-received', { workspacePath: '/ws/b' }, 1);

      expect(result).toMatchObject({ success: false });
      expect(sourceSend).not.toHaveBeenCalled();
    });

    it('tears the project off into a new window at the cursor when dropped outside every window', async () => {
      mocks.cursor = { x: 850, y: 700 };
      await invoke('workspace:rail-drag-start', { workspacePath: '/ws/b' }, 1);
      const result = await invoke('workspace:rail-drag-end', { workspacePath: '/ws/b', dropEffect: 'none', isOnlyProject: false }, 1);

      expect(result).toMatchObject({ success: true, action: 'torn-off' });
      expect(mocks.openWorkspaceWindow).toHaveBeenCalledWith('/ws/b', { forceNewWindow: true, position: { x: 850, y: 700 } });
      expect(sourceSend).toHaveBeenCalledWith('workspace:rail-release-project', { workspacePath: '/ws/b' });
    });

    it('keeps the project when a cancelled drag ends over a window', async () => {
      mocks.cursor = { x: 400, y: 300 };
      await invoke('workspace:rail-drag-start', { workspacePath: '/ws/b' }, 1);
      await invoke('workspace:rail-drag-end', { workspacePath: '/ws/b', dropEffect: 'none', isOnlyProject: false }, 1);

      expect(mocks.openWorkspaceWindow).not.toHaveBeenCalled();
      expect(sourceSend).not.toHaveBeenCalled();
    });

    it('does not tear off the only project in a window', async () => {
      mocks.cursor = { x: 850, y: 700 };
      await invoke('workspace:rail-drag-start', { workspacePath: '/ws/b' }, 1);
      await invoke('workspace:rail-drag-end', { workspacePath: '/ws/b', dropEffect: 'none', isOnlyProject: true }, 1);

      expect(mocks.openWorkspaceWindow).not.toHaveBeenCalled();
      expect(sourceSend).not.toHaveBeenCalled();
    });
  });
});
