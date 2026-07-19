import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WindowState } from '../../types';

/**
 * Mocks must use `vi.hoisted` so the references they expose survive the
 * module-mock hoisting that vitest performs. Top-level `const` references
 * inside the factories would be `undefined` at mock evaluation time.
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: any, data: any) => any>();
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
    windowFocusOrder: new Map<number, number>(),
    addToRecentItems: vi.fn(),
    getWorkspaceNavigationHistory: vi.fn(() => null),
    setupDocumentServiceHandlers: vi.fn(),
    addNimAssetRoot: vi.fn(),
    getMcpConfigService: vi.fn(() => ({ stopWatchingWorkspaceConfig: vi.fn() })),
    initializeWorkspaceTabBackground: vi.fn(),
    activateWorkspaceTabContext: vi.fn(),
    releaseWorkspaceTabBackground: vi.fn(),
    restoreNavigationState: vi.fn(),
    createWindow: vi.fn(() => ({ id: 99 })),
    electronFileSystemService: vi.fn(function () {
      return { destroy: vi.fn() };
    }),
    fakeBrowserWindows: new Map<number, any>(),
    fakeBrowserWindowId: 1,
    focusedBrowserWindowId: 1,
  };
});

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: any, data: any) => Promise<any>) => {
    mocks.handlers.set(channel, fn);
  },
  safeOn: (channel: string, fn: (event: any, data: any) => void) => {
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

vi.mock('../../protocols/nimPreviewProtocol', () => ({
  addNimPreviewWorkspaceRoot: vi.fn(),
}));

vi.mock('../../utils/store', () => ({
  addToRecentItems: mocks.addToRecentItems,
  getWorkspaceNavigationHistory: mocks.getWorkspaceNavigationHistory,
}));

vi.mock('../../services/NavigationHistoryService', () => ({
  navigationHistoryService: { restoreNavigationState: mocks.restoreNavigationState },
}));

vi.mock('../../mcpConfigServiceRef', () => ({
  getMcpConfigService: mocks.getMcpConfigService,
}));

vi.mock('../../services/TeamService', () => ({
  autoMatchTeamForWorkspace: vi.fn(async () => undefined),
}));

vi.mock('../../services/TrackerSyncManager', () => ({
  initializeTrackerSync: vi.fn(async () => undefined),
}));

vi.mock('../../services/TrackerSchemaService', () => ({
  updateTrackerSchemaWorkspace: vi.fn(),
}));

vi.mock('../../services/WorkspaceTabBackground', () => ({
  initializeWorkspaceTabBackground: mocks.initializeWorkspaceTabBackground,
  activateWorkspaceTabContext: mocks.activateWorkspaceTabContext,
  releaseWorkspaceTabBackground: mocks.releaseWorkspaceTabBackground,
}));

vi.mock('../../window/WindowManager', () => ({
  createWindow: mocks.createWindow,
  documentServices: mocks.documentServices,
  windowStates: mocks.windowStates,
  windowFocusOrder: mocks.windowFocusOrder,
  getWindowId: (window: any) => window?.id ?? null,
}));

vi.mock('../../window/windowState', () => ({
  windowStates: mocks.windowStates,
  resolveActiveWorkspacePath: (state: WindowState | undefined) => {
    if (!state) return null;
    return state.activeWorkspacePath ?? state.workspacePath;
  },
  resolveDocumentServicePath: (state: WindowState | undefined) => {
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
  ElectronFileSystemService: mocks.electronFileSystemService,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: () => {
      let window = mocks.fakeBrowserWindows.get(mocks.fakeBrowserWindowId);
      if (!window) {
        const windowId = mocks.fakeBrowserWindowId;
        window = {
          id: windowId,
          getBounds: () => ({ x: 20, y: 20, width: 1000, height: 700 }),
          isDestroyed: () => false,
          isFocused: () => mocks.focusedBrowserWindowId === windowId,
          webContents: { send: vi.fn() },
          close: vi.fn(),
        };
        mocks.fakeBrowserWindows.set(windowId, window);
      }
      return window;
    },
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
    mocks.windowFocusOrder.clear();
    mocks.fakeBrowserWindows.clear();
    mocks.focusedBrowserWindowId = 1;
    mocks.startWorkspaceWatcher.mockReset();
    mocks.stopWorkspaceWatcher.mockReset();
    mocks.setFileSystemService.mockReset();
    mocks.clearFileSystemService.mockReset();
    mocks.initializeWorkspaceTabBackground.mockReset();
    mocks.activateWorkspaceTabContext.mockReset();
    mocks.releaseWorkspaceTabBackground.mockReset();
    mocks.createWindow.mockClear();
    mocks.electronFileSystemService.mockReset();
    mocks.electronFileSystemService.mockImplementation(function () {
      return { destroy: vi.fn() };
    });
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

    it('does not leave a ghost reference when service construction fails', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/a' }));
      mocks.electronFileSystemService.mockImplementationOnce(function () {
        throw new Error('filesystem unavailable');
      });

      const result = await invoke('workspace:register-additional', { workspacePath: '/ws/b' }, 1);

      expect(result).toMatchObject({ success: false, error: 'filesystem unavailable' });
      expect(mocks.windowStates.get(1)?.additionalWorkspacePaths).toBeUndefined();
      expect(mocks.documentServices.has('/ws/b')).toBe(false);
      expect(mocks.fileSystemServices.has('/ws/b')).toBe(false);
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

    it('keeps queued tab opens until the renderer acknowledges them', async () => {
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/a',
        pendingProjectTabPaths: ['/ws/b', '/ws/b'],
      }));

      expect(await invoke('workspace:consume-pending-project-tabs', undefined, 1)).toEqual(['/ws/b']);
      expect(await invoke('workspace:consume-pending-project-tabs', undefined, 1)).toEqual(['/ws/b']);
      expect(await invoke(
        'workspace:ack-project-tab-open',
        { workspacePath: '/ws/b' },
        1,
      )).toEqual({ success: true });
      expect(await invoke('workspace:consume-pending-project-tabs', undefined, 1)).toEqual([]);
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
      expect(mocks.activateWorkspaceTabContext).toHaveBeenCalledWith('/ws/b');
      expect(mocks.initializeWorkspaceTabBackground).not.toHaveBeenCalled();
    });

    it('is idempotent when the path is already active', async () => {
      await invoke('workspace:set-active', { workspacePath: '/ws/a' }, 1);
      mocks.stopWorkspaceWatcher.mockClear();
      mocks.startWorkspaceWatcher.mockClear();

      const result = await invoke('workspace:set-active', { workspacePath: '/ws/a' }, 1);

      expect(result).toMatchObject({ alreadyActive: true });
      expect(mocks.stopWorkspaceWatcher).not.toHaveBeenCalled();
      expect(mocks.startWorkspaceWatcher).not.toHaveBeenCalled();
      expect(mocks.activateWorkspaceTabContext).toHaveBeenCalledWith('/ws/a');
      expect(mocks.initializeWorkspaceTabBackground).not.toHaveBeenCalled();
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

    it('rejects a close for a path the source window does not reference', async () => {
      const result = await invoke(
        'workspace:unregister-additional',
        { workspacePath: '/ws/missing' },
        1,
      );

      expect(result).toMatchObject({ success: false });
      expect(mocks.documentServices.has('/ws/warm')).toBe(true);
    });

    it('destroys services when no other window references the path', async () => {
      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(mocks.documentServices.has('/ws/warm')).toBe(false);
      expect(mocks.fileSystemServices.has('/ws/warm')).toBe(false);
      expect(mocks.releaseWorkspaceTabBackground).toHaveBeenCalledWith('/ws/warm');
    });

    it('keeps services alive when another window still references the path', async () => {
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/warm' }));

      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(mocks.documentServices.has('/ws/warm')).toBe(true);
      expect(mocks.fileSystemServices.has('/ws/warm')).toBe(true);
      expect(mocks.releaseWorkspaceTabBackground).not.toHaveBeenCalled();
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
      expect(mocks.windowStates.get(1)?.activeWorkspacePath).toBe('/ws/primary');
    });

    it('stops the watcher before removing the active path from window state', async () => {
      mocks.windowStates.set(
        1,
        makeState({
          workspacePath: '/ws/primary',
          additionalWorkspacePaths: ['/ws/warm'],
          activeWorkspacePath: '/ws/warm',
        }),
      );
      let pathsAtStop: string[] = [];
      mocks.stopWorkspaceWatcher.mockImplementationOnce(() => {
        const state = mocks.windowStates.get(1);
        pathsAtStop = [state?.workspacePath, ...(state?.additionalWorkspacePaths ?? [])]
          .filter((path): path is string => Boolean(path));
      });

      await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

      expect(pathsAtStop).toContain('/ws/warm');
    });

    it('selects the detached destination service when the source loses its last tab', async () => {
      const detachedService = new FakeService() as any;
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/primary',
        activeWorkspacePath: '/ws/primary',
      }));
      mocks.windowStates.set(2, makeState({
        workspacePath: '/ws/primary',
        activeWorkspacePath: '/ws/primary',
      }));
      mocks.windowFocusOrder.set(2, 10);
      mocks.fileSystemServices.set('/ws/primary', detachedService);

      await invoke('workspace:unregister-additional', { workspacePath: '/ws/primary' }, 1);

      expect(mocks.setFileSystemService).toHaveBeenCalledWith(detachedService);
      expect(mocks.clearFileSystemService).not.toHaveBeenCalled();
    });

    it('promotes a remaining tab when the primary project closes', async () => {
      mocks.windowStates.set(
        1,
        makeState({
          workspacePath: '/ws/primary',
          additionalWorkspacePaths: ['/ws/next', '/ws/other'],
          activeWorkspacePath: '/ws/primary',
        }),
      );
      mocks.fileSystemServices.set('/ws/next', new FakeService() as any);

      await invoke(
        'workspace:unregister-additional',
        { workspacePath: '/ws/primary', replacementWorkspacePath: '/ws/next' },
        1,
      );

      expect(mocks.windowStates.get(1)).toMatchObject({
        workspacePath: '/ws/next',
        additionalWorkspacePaths: ['/ws/other'],
        activeWorkspacePath: '/ws/next',
      });
      expect(mocks.startWorkspaceWatcher).toHaveBeenCalledWith(expect.anything(), '/ws/next');
    });
  });

  describe('workspace:move-project-tab', () => {
    async function beginDrag(workspacePath = '/ws/b', dragId = 'drag-1') {
      await invoke('workspace:begin-project-tab-drag', {
        version: 1,
        dragId,
        workspacePath,
      }, 1);
      await invoke('workspace:project-tab-drag-ready', { dragId }, 1);
    }

    it('moves a project into the destination before publishing renderer mutations', async () => {
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
        activeWorkspacePath: '/ws/b',
      }));
      mocks.windowStates.set(2, makeState({
        workspacePath: '/ws/c',
        activeWorkspacePath: '/ws/c',
      }));

      await beginDrag();
      const result = await invoke('workspace:move-project-tab', {
        dragId: 'drag-1',
      }, 2);

      expect(result).toEqual({ success: true });
      expect(mocks.windowStates.get(1)).toMatchObject({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: [],
        activeWorkspacePath: '/ws/a',
      });
      expect(mocks.windowStates.get(2)).toMatchObject({
        workspacePath: '/ws/c',
        additionalWorkspacePaths: ['/ws/b'],
        activeWorkspacePath: '/ws/b',
      });
      expect(mocks.stopWorkspaceWatcher).toHaveBeenCalledWith(1);
      expect(mocks.stopWorkspaceWatcher).toHaveBeenCalledWith(2);
      expect(mocks.startWorkspaceWatcher).toHaveBeenCalledWith(
        mocks.fakeBrowserWindows.get(1),
        '/ws/a',
      );
      expect(mocks.startWorkspaceWatcher).toHaveBeenCalledWith(
        mocks.fakeBrowserWindows.get(2),
        '/ws/b',
      );
      expect(mocks.releaseWorkspaceTabBackground).not.toHaveBeenCalled();
      expect(mocks.fakeBrowserWindows.get(1).webContents.send).toHaveBeenCalledWith(
        'workspace:project-tab-mutation',
        expect.objectContaining({ kind: 'remove', workspacePath: '/ws/b' }),
      );
      expect(mocks.fakeBrowserWindows.get(2).webContents.send).toHaveBeenCalledWith(
        'workspace:project-tab-mutation',
        expect.objectContaining({ kind: 'add', workspacePath: '/ws/b' }),
      );
    });

    it('does not let the unfocused source reclaim global context after an active-tab move', async () => {
      const sourceReplacementService = new FakeService() as any;
      const movedService = new FakeService() as any;
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
        activeWorkspacePath: '/ws/b',
      }));
      mocks.windowStates.set(2, makeState({
        workspacePath: '/ws/c',
        activeWorkspacePath: '/ws/c',
      }));
      mocks.fileSystemServices.set('/ws/a', sourceReplacementService);
      mocks.fileSystemServices.set('/ws/b', movedService);

      await beginDrag();
      mocks.focusedBrowserWindowId = 2;
      expect(await invoke('workspace:move-project-tab', { dragId: 'drag-1' }, 2))
        .toEqual({ success: true });

      // Applying the source renderer's queued remove mutation updates its atom
      // to /ws/a and sends this idempotent notification after main committed
      // the move. It must not overwrite the focused destination's globals.
      mocks.setFileSystemService.mockClear();
      mocks.activateWorkspaceTabContext.mockClear();
      expect(await invoke('workspace:set-active', { workspacePath: '/ws/a' }, 1))
        .toMatchObject({ success: true, alreadyActive: true });
      expect(mocks.setFileSystemService).not.toHaveBeenCalled();
      expect(mocks.activateWorkspaceTabContext).not.toHaveBeenCalled();
    });

    it('treats a drop back on the source strip as a claimed no-op', async () => {
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
        activeWorkspacePath: '/ws/b',
      }));

      await beginDrag();
      expect(await invoke('workspace:move-project-tab', { dragId: 'drag-1' }, 1)).toEqual({
        success: true,
        alreadyInWindow: true,
      });
      expect(await invoke('workspace:wait-project-tab-drag-result', { dragId: 'drag-1' }, 1))
        .toEqual({ handled: true, moved: false });
      expect(mocks.windowStates.get(1)).toMatchObject({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
        activeWorkspacePath: '/ws/b',
      });
    });

    it('allows only one destination to claim a drag while preparation is pending', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b' }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c' }));
      mocks.windowStates.set(3, makeState({ workspacePath: '/ws/d' }));
      await invoke('workspace:begin-project-tab-drag', {
        version: 1,
        dragId: 'drag-concurrent',
        workspacePath: '/ws/b',
      }, 1);

      const firstMove = invoke('workspace:move-project-tab', { dragId: 'drag-concurrent' }, 2);
      const secondMove = invoke('workspace:move-project-tab', { dragId: 'drag-concurrent' }, 3);
      await invoke('workspace:project-tab-drag-ready', { dragId: 'drag-concurrent' }, 1);
      const [firstResult, secondResult] = await Promise.all([firstMove, secondMove]);

      expect(firstResult).toEqual({ success: true });
      expect(secondResult).toMatchObject({
        success: false,
        error: 'Project tab drag was already claimed by a destination window',
      });
      expect(mocks.windowStates.get(2)?.additionalWorkspacePaths).toEqual(['/ws/b']);
      expect(mocks.windowStates.get(3)?.additionalWorkspacePaths).toBeUndefined();
    });

    it('revalidates the destination after preparation before removing the source tab', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b' }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c' }));
      await invoke('workspace:begin-project-tab-drag', {
        version: 1,
        dragId: 'drag-closed-destination',
        workspacePath: '/ws/b',
      }, 1);

      const move = invoke('workspace:move-project-tab', { dragId: 'drag-closed-destination' }, 2);
      mocks.windowStates.delete(2);
      await invoke('workspace:project-tab-drag-ready', { dragId: 'drag-closed-destination' }, 1);

      expect(await move).toMatchObject({ success: false });
      expect(mocks.windowStates.get(1)?.workspacePath).toBe('/ws/b');
      expect(mocks.stopWorkspaceWatcher).not.toHaveBeenCalled();
    });

    it('marks the source mutation to close a window that lost its last tab', async () => {
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/b',
        activeWorkspacePath: '/ws/b',
      }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c' }));

      await beginDrag();
      expect(await invoke('workspace:move-project-tab', {
        dragId: 'drag-1',
      }, 2)).toEqual({ success: true });

      expect(mocks.windowStates.get(1)?.workspacePath).toBeNull();
      expect(mocks.windowStates.get(1)?.pendingProjectTabMutations).toEqual([
        expect.objectContaining({
          kind: 'remove',
          closeWindowWhenEmpty: true,
          replacementWorkspacePath: null,
        }),
      ]);
    });

    it('keeps the source active tab unchanged when moving an inactive tab', async () => {
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
        activeWorkspacePath: '/ws/a',
      }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c' }));

      await beginDrag();
      expect(await invoke('workspace:move-project-tab', {
        dragId: 'drag-1',
      }, 2)).toEqual({ success: true });

      expect(mocks.windowStates.get(1)?.activeWorkspacePath).toBe('/ws/a');
      expect(mocks.windowStates.get(1)?.pendingProjectTabMutations).toEqual([
        expect.objectContaining({
          kind: 'remove',
          replacementWorkspacePath: null,
        }),
      ]);
      expect(mocks.stopWorkspaceWatcher).not.toHaveBeenCalledWith(1);
    });

    it('keeps the committed move when live renderer delivery throws', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b' }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c' }));

      await beginDrag();
      await invoke('workspace:consume-pending-project-tab-mutations', undefined, 2);
      mocks.fakeBrowserWindows.get(2).webContents.send.mockImplementationOnce(() => {
        throw new Error('renderer reloading');
      });

      expect(await invoke('workspace:move-project-tab', {
        dragId: 'drag-1',
      }, 2)).toEqual({ success: true });
      expect(mocks.windowStates.get(1)?.workspacePath).toBeNull();
      expect(mocks.windowStates.get(2)?.additionalWorkspacePaths).toEqual(['/ws/b']);
      expect(mocks.windowStates.get(2)?.pendingProjectTabMutations).toEqual([
        expect.objectContaining({ kind: 'add', workspacePath: '/ws/b' }),
      ]);
    });

    it('leaves both windows unchanged when the destination is at the tab cap', async () => {
      const fullDestination = makeState({
        workspacePath: '/ws/c0',
        additionalWorkspacePaths: Array.from({ length: 7 }, (_, index) => `/ws/c${index + 1}`),
        activeWorkspacePath: '/ws/c0',
      });
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b' }));
      mocks.windowStates.set(2, fullDestination);

      await beginDrag();
      const result = await invoke('workspace:move-project-tab', {
        dragId: 'drag-1',
      }, 2);

      expect(result).toMatchObject({ success: false });
      expect(mocks.windowStates.get(1)?.workspacePath).toBe('/ws/b');
      expect(mocks.windowStates.get(2)).toEqual(fullDestination);
      expect(mocks.stopWorkspaceWatcher).not.toHaveBeenCalled();
      expect(await invoke('workspace:wait-project-tab-drag-result', {
        dragId: 'drag-1',
      }, 1)).toEqual({ handled: true, moved: false });
    });

    it('restores window and global active context when activation throws', async () => {
      const previousDestinationService = new FakeService() as any;
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b', activeWorkspacePath: '/ws/b' }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c', activeWorkspacePath: '/ws/c' }));
      mocks.windowFocusOrder.set(2, 2);
      mocks.fileSystemServices.set('/ws/c', previousDestinationService);
      mocks.activateWorkspaceTabContext.mockImplementationOnce(() => {
        throw new Error('activation failed');
      });

      await beginDrag();
      const result = await invoke('workspace:move-project-tab', { dragId: 'drag-1' }, 2);

      expect(result).toMatchObject({ success: false, error: 'activation failed' });
      expect(mocks.windowStates.get(1)).toMatchObject({
        workspacePath: '/ws/b',
        activeWorkspacePath: '/ws/b',
      });
      expect(mocks.windowStates.get(2)).toMatchObject({
        workspacePath: '/ws/c',
        activeWorkspacePath: '/ws/c',
      });
      expect(mocks.setFileSystemService).toHaveBeenLastCalledWith(previousDestinationService);
      expect(mocks.activateWorkspaceTabContext).toHaveBeenLastCalledWith('/ws/c');
    });

    it('restores the most recently focused global context when activation throws', async () => {
      const focusedService = new FakeService() as any;
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b', activeWorkspacePath: '/ws/b' }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c', activeWorkspacePath: '/ws/c' }));
      mocks.windowStates.set(3, makeState({ workspacePath: '/ws/d', activeWorkspacePath: '/ws/d' }));
      mocks.windowFocusOrder.set(1, 2);
      mocks.windowFocusOrder.set(2, 1);
      mocks.windowFocusOrder.set(3, 3);
      mocks.fileSystemServices.set('/ws/d', focusedService);
      mocks.activateWorkspaceTabContext.mockImplementationOnce(() => {
        throw new Error('activation failed');
      });

      await beginDrag();
      expect(await invoke('workspace:move-project-tab', { dragId: 'drag-1' }, 2))
        .toMatchObject({ success: false, error: 'activation failed' });

      expect(mocks.setFileSystemService).toHaveBeenLastCalledWith(focusedService);
      expect(mocks.activateWorkspaceTabContext).toHaveBeenLastCalledWith('/ws/d');
    });

    it('leaves the source in place when editor preparation fails', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b' }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c' }));
      await invoke('workspace:begin-project-tab-drag', {
        version: 1,
        dragId: 'drag-failed-save',
        workspacePath: '/ws/b',
      }, 1);
      await invoke('workspace:project-tab-drag-ready', {
        dragId: 'drag-failed-save',
        error: 'Could not save dirty editor',
      }, 1);

      expect(await invoke('workspace:move-project-tab', {
        dragId: 'drag-failed-save',
      }, 2)).toEqual({ success: false, error: 'Could not save dirty editor' });
      expect(mocks.windowStates.get(1)?.workspacePath).toBe('/ws/b');
      expect(mocks.windowStates.get(2)?.workspacePath).toBe('/ws/c');
      expect(await invoke('workspace:wait-project-tab-drag-result', {
        dragId: 'drag-failed-save',
      }, 1)).toEqual({ handled: true, moved: false });
    });

    it('rejects an unregistered or already-consumed drag token', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/b' }));
      mocks.windowStates.set(2, makeState({ workspacePath: '/ws/c' }));

      const result = await invoke('workspace:move-project-tab', {
        dragId: 'missing',
      }, 2);

      expect(result).toMatchObject({ success: false });
      expect(mocks.windowStates.get(1)?.workspacePath).toBe('/ws/b');
      expect(mocks.windowStates.get(2)?.workspacePath).toBe('/ws/c');
    });
  });

  describe('workspace:detach-project-tab', () => {
    it('creates the destination window at the drop point', async () => {
      mocks.windowStates.set(1, makeState({
        workspacePath: '/ws/a',
        additionalWorkspacePaths: ['/ws/b'],
      }));

      const result = await invoke(
        'workspace:detach-project-tab',
        { workspacePath: '/ws/b', position: { screenX: 600, screenY: 240 } },
        1,
      );

      expect(result).toMatchObject({ success: true, windowId: 99 });
      expect(mocks.createWindow).toHaveBeenCalledWith(
        false,
        true,
        '/ws/b',
        { x: 480, y: 220, width: 1000, height: 700 },
      );
      expect(mocks.initializeWorkspaceTabBackground).toHaveBeenCalledWith('/ws/b');
      expect(mocks.activateWorkspaceTabContext).toHaveBeenCalledWith('/ws/b');
    });

    it('rejects a project that is not open in the source window', async () => {
      mocks.windowStates.set(1, makeState({ workspacePath: '/ws/a' }));

      const result = await invoke(
        'workspace:detach-project-tab',
        { workspacePath: '/ws/missing' },
        1,
      );

      expect(result).toMatchObject({ success: false });
      expect(mocks.createWindow).not.toHaveBeenCalled();
    });
  });
});
