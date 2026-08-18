/**
 * Regression coverage for the background-watch refcount leak described in
 * the single-window-multi-project review (Fix 1): `startBackground` counts
 * once per WINDOW that keeps a path warm, but every release site
 * (`WorkspaceWatcher.ts`'s orphan sweep, `workspace:unregister-additional`,
 * `WindowManager.ts`'s `closed` handler) gates on the BOOLEAN
 * `anyWindowReferencesWorkspace(path)` and then calls `stopBackground`
 * exactly once. With two windows both keeping the same path warm, the
 * refcount reaches 2 but only ONE gated decrement ever fires (the second
 * window's close/unregister is the first call to see the boolean flip to
 * false), leaving the `WorkspaceEventBus` subscription and the
 * `backgroundRefCounts` entry alive forever.
 *
 * Deliberately drives the REAL `OptimizedWorkspaceWatcher`, `WorkspaceWatcher`,
 * and `MultiProjectRailHandlers` modules through the actual
 * `workspace:register-additional` / `workspace:unregister-additional` IPC
 * handlers -- only the leaf `WorkspaceEventBus` (the chokidar/fs.watch
 * boundary) and unrelated services are mocked. A test that mocks
 * `OptimizedWorkspaceWatcher` or `stopBackground` itself (as the existing
 * per-module unit tests do) cannot see this bug: the leak is in how the real
 * release contract between these three modules disagrees, not in any single
 * function's own logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WindowState } from '../../types';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: any, data: any) => Promise<any>>();
  return {
    handlers,
    windowStates: new Map<number, WindowState>(),
    windows: new Map<number, any>(),
    documentServices: new Map<string, any>(),
    fileSystemServices: new Map<string, any>(),
    subscribe: vi.fn(async (_workspacePath: string, _subscriberId: string, _listener: any) => {}),
    unsubscribe: vi.fn(),
    getWindowId: vi.fn((window: any) => window?.id ?? null),
    markRecentlyDeleted: vi.fn(),
    gitRefWatcherStart: vi.fn(async () => {}),
    gitRefWatcherStop: vi.fn(async () => {}),
    addToRecentItems: vi.fn(),
    getWorkspaceNavigationHistory: vi.fn(() => null),
    setupDocumentServiceHandlers: vi.fn(),
    addNimAssetRoot: vi.fn(),
    addNimPreviewWorkspaceRoot: vi.fn(),
    getMcpConfigService: vi.fn(() => ({ stopWatchingWorkspaceConfig: vi.fn() })),
    restoreNavigationState: vi.fn(),
    setFileSystemService: vi.fn(),
    clearFileSystemService: vi.fn(),
    setFileSystemServiceFor: vi.fn(),
    clearFileSystemServiceFor: vi.fn(),
    fakeBrowserWindowId: 1,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: () => ({ id: mocks.fakeBrowserWindowId }),
    getAllWindows: () => [],
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: any, data: any) => Promise<any>) => {
    mocks.handlers.set(channel, fn);
  },
}));

vi.mock('../WorkspaceEventBus', () => ({
  subscribe: mocks.subscribe,
  unsubscribe: mocks.unsubscribe,
  addWatchedPath: vi.fn(),
  removeWatchedPath: vi.fn(),
  getStats: vi.fn(() => ({ type: 'chokidar' })),
  setGitignoreChangeHandler: vi.fn(),
}));

vi.mock('../GitRefWatcher', () => ({
  gitRefWatcher: {
    start: mocks.gitRefWatcherStart,
    stop: mocks.gitRefWatcherStop,
    stopAll: vi.fn(async () => {}),
  },
}));

vi.mock('../../ipc/GitStatusHandlers', () => ({
  clearGitStatusCache: vi.fn(),
}));

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

vi.mock('../../services/ProjectFileSyncService', () => ({
  getProjectFileSyncService: () => ({
    isRecentlyWrittenFromRemote: () => false,
    handleFileSaved: vi.fn(),
    handleFileDeletedByPath: vi.fn(),
    syncProject: vi.fn(async () => {}),
    disconnectProject: vi.fn(),
  }),
}));

vi.mock('../../services/SyncManager', () => ({
  isSyncEnabled: () => false,
}));

vi.mock('../../utils/store', () => ({
  getReleaseChannel: () => 'stable',
  getSessionSyncConfig: () => null,
  addToRecentItems: mocks.addToRecentItems,
  getWorkspaceNavigationHistory: mocks.getWorkspaceNavigationHistory,
}));

vi.mock('../../utils/FileTree', () => ({
  getFolderContents: vi.fn(async () => []),
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    workspaceWatcher: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

vi.mock('../../window/WindowManager', () => ({
  getWindowId: mocks.getWindowId,
  markRecentlyDeleted: mocks.markRecentlyDeleted,
  windows: mocks.windows,
  windowStates: mocks.windowStates,
  documentServices: mocks.documentServices,
}));

vi.mock('../../window/windowState', () => ({
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
  resolveDocumentServicePath: (state: WindowState | undefined) => {
    if (!state) return null;
    return state.activeWorkspacePath ?? state.workspacePath ?? null;
  },
}));

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

vi.mock('../../protocols/nimAssetProtocol', () => ({
  addNimAssetRoot: mocks.addNimAssetRoot,
}));

vi.mock('../../protocols/nimPreviewProtocol', () => ({
  addNimPreviewWorkspaceRoot: mocks.addNimPreviewWorkspaceRoot,
}));

vi.mock('../../index', () => ({
  getMcpConfigService: mocks.getMcpConfigService,
}));

vi.mock('../../services/NavigationHistoryService', () => ({
  navigationHistoryService: { restoreNavigationState: mocks.restoreNavigationState },
}));

vi.mock('@nimbalyst/runtime', () => ({
  setFileSystemService: mocks.setFileSystemService,
  clearFileSystemService: mocks.clearFileSystemService,
  setFileSystemServiceFor: mocks.setFileSystemServiceFor,
  clearFileSystemServiceFor: mocks.clearFileSystemServiceFor,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: () => true };
});

// Imported AFTER mocks: the real OptimizedWorkspaceWatcher / WorkspaceWatcher
// modules are exercised for real (only WorkspaceEventBus is a leaf mock), and
// `registerMultiProjectRailHandlers` is the real handler registration so
// `safeHandle` captures the real `workspace:register-additional` /
// `workspace:unregister-additional` logic.
import { registerMultiProjectRailHandlers } from '../../ipc/MultiProjectRailHandlers';
import { optimizedWorkspaceWatcher } from '../OptimizedWorkspaceWatcher';

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

describe('background watch refcount leak (Fix 1)', () => {
  beforeEach(async () => {
    mocks.handlers.clear();
    mocks.windowStates.clear();
    mocks.windows.clear();
    mocks.documentServices.clear();
    mocks.fileSystemServices.clear();
    vi.clearAllMocks();
    // The watcher is a module-level singleton shared across the whole file
    // graph in production; reset it between tests so leftover state from a
    // previous test can't mask (or fake) red/green here.
    await optimizedWorkspaceWatcher.stopAll();
    registerMultiProjectRailHandlers();
  });

  it('fully releases the background watch once the last of two windows sharing it unregisters', async () => {
    mocks.windowStates.set(1, makeState({ workspacePath: '/ws/primary1' }));
    mocks.windowStates.set(2, makeState({ workspacePath: '/ws/primary2' }));

    // Both windows independently keep /ws/warm warm in their rail -- the real
    // production path for two windows sharing a project (each user action
    // goes through `workspace:register-additional`, which calls
    // `startWarmWorkspaceWatch` -> `OptimizedWorkspaceWatcher.startBackground`).
    await invoke('workspace:register-additional', { workspacePath: '/ws/warm' }, 1);
    await invoke('workspace:register-additional', { workspacePath: '/ws/warm' }, 2);

    expect(mocks.subscribe).toHaveBeenCalledTimes(1); // subscribe-once guarantee held
    expect(optimizedWorkspaceWatcher.getBackgroundWatchPaths()).toEqual(['/ws/warm']);

    // Window 1 closes the project from its rail first. Window 2 still
    // references /ws/warm, so `anyWindowReferencesWorkspace` gates this
    // release off -- nothing should be torn down yet.
    await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 1);

    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(optimizedWorkspaceWatcher.getBackgroundWatchPaths()).toEqual(['/ws/warm']);

    // Window 2 is now the LAST window referencing /ws/warm. This is the
    // provably-final release: `anyWindowReferencesWorkspace('/ws/warm')` is
    // false by the time this call's gate check runs.
    await invoke('workspace:unregister-additional', { workspacePath: '/ws/warm' }, 2);

    // The bug: a plain per-caller decrement only drops the refcount from 2
    // to 1 here (this is the ONLY gated release call that ever fires for this
    // path), so the bus subscription and the refcount map entry never clear.
    expect(mocks.unsubscribe).toHaveBeenCalledWith('/ws/warm', 'workspace-watcher-bg-/ws/warm');
    expect(optimizedWorkspaceWatcher.getBackgroundWatchCount()).toBe(0);
    expect(optimizedWorkspaceWatcher.getBackgroundWatchPaths()).toEqual([]);
  });
});
