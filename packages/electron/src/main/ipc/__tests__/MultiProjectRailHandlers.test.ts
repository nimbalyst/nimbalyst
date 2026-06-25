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
    startWorkspaceWatcher: vi.fn(),
    stopWorkspaceWatcher: vi.fn(),
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

vi.mock('../../window/windowState', () => ({
  windowStates: mocks.windowStates,
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
  },
}));

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
      expect(mocks.stopWorkspaceWatcher).toHaveBeenCalledWith(1);
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

      expect(mocks.stopWorkspaceWatcher).toHaveBeenCalledWith(1);
      expect(mocks.clearFileSystemService).toHaveBeenCalled();
      expect(mocks.windowStates.get(1)?.activeWorkspacePath).toBeNull();
    });
  });
});
