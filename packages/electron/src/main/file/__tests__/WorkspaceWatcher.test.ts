/**
 * Covers the orphan-sweep behavior added to `stopWorkspaceWatcher` for
 * Phase 2 of single-window-multi-project: a warm rail project's background
 * watch (content-only file-changed-on-disk/file-deleted forwarding +
 * GitRefWatcher) must be released once no window references it any more,
 * even when that happens via a window closing outright rather than an
 * explicit `workspace:unregister-additional` call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    windowStates: new Map<number, any>(),
    getWindowId: vi.fn((window: any) => window?.id ?? null),
    optimizedStop: vi.fn(),
    optimizedReleaseAllBackgroundRefs: vi.fn(),
    getBackgroundWatchPaths: vi.fn(() => [] as string[]),
    gitRefWatcherStop: vi.fn(async () => {}),
    anyWindowReferencesWorkspace: vi.fn((_path: string) => false),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../window/WindowManager', () => ({
  getWindowId: mocks.getWindowId,
  windowStates: mocks.windowStates,
}));

vi.mock('../../window/windowState', () => ({
  anyWindowReferencesWorkspace: mocks.anyWindowReferencesWorkspace,
}));

vi.mock('../../ipc/GitStatusHandlers', () => ({
  clearGitStatusCache: vi.fn(),
}));

vi.mock('../OptimizedWorkspaceWatcher', () => ({
  optimizedWorkspaceWatcher: {
    start: vi.fn(),
    stop: mocks.optimizedStop,
    releaseAllBackgroundRefs: mocks.optimizedReleaseAllBackgroundRefs,
    getBackgroundWatchPaths: mocks.getBackgroundWatchPaths,
  },
}));

vi.mock('../GitRefWatcher', () => ({
  gitRefWatcher: {
    start: vi.fn(async () => {}),
    stop: mocks.gitRefWatcherStop,
    stopAll: vi.fn(async () => {}),
  },
}));

vi.mock('../WorkspaceEventBus', () => ({
  setGitignoreChangeHandler: vi.fn(),
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(),
  stopAll: vi.fn(async () => {}),
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
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    workspaceWatcher: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { info: vi.fn(), error: vi.fn() },
  },
}));

import { stopWorkspaceWatcher } from '../WorkspaceWatcher';

describe('stopWorkspaceWatcher orphan sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.windowStates.clear();
    mocks.getBackgroundWatchPaths.mockReturnValue([]);
    mocks.anyWindowReferencesWorkspace.mockReturnValue(false);
  });

  it('releases a background watch that no window references any more', () => {
    mocks.getBackgroundWatchPaths.mockReturnValue(['/ws/orphan']);
    mocks.anyWindowReferencesWorkspace.mockReturnValue(false);

    stopWorkspaceWatcher(1);

    expect(mocks.optimizedReleaseAllBackgroundRefs).toHaveBeenCalledWith('/ws/orphan');
    expect(mocks.gitRefWatcherStop).toHaveBeenCalledWith('/ws/orphan');
  });

  it('leaves a background watch alone when another window still references it', () => {
    mocks.getBackgroundWatchPaths.mockReturnValue(['/ws/still-warm']);
    mocks.anyWindowReferencesWorkspace.mockReturnValue(true);

    stopWorkspaceWatcher(1);

    expect(mocks.optimizedReleaseAllBackgroundRefs).not.toHaveBeenCalled();
    expect(mocks.gitRefWatcherStop).not.toHaveBeenCalled();
  });

  it('sweeps every orphaned background path, not just ones tied to the closing window', () => {
    mocks.getBackgroundWatchPaths.mockReturnValue(['/ws/orphan-a', '/ws/orphan-b', '/ws/still-warm']);
    mocks.anyWindowReferencesWorkspace.mockImplementation((path: string) => path === '/ws/still-warm');

    stopWorkspaceWatcher(1);

    expect(mocks.optimizedReleaseAllBackgroundRefs).toHaveBeenCalledWith('/ws/orphan-a');
    expect(mocks.optimizedReleaseAllBackgroundRefs).toHaveBeenCalledWith('/ws/orphan-b');
    expect(mocks.optimizedReleaseAllBackgroundRefs).not.toHaveBeenCalledWith('/ws/still-warm');
  });

  it('is a no-op sweep when there are no background watches', () => {
    mocks.getBackgroundWatchPaths.mockReturnValue([]);

    expect(() => stopWorkspaceWatcher(1)).not.toThrow();
    expect(mocks.optimizedReleaseAllBackgroundRefs).not.toHaveBeenCalled();
    expect(mocks.gitRefWatcherStop).not.toHaveBeenCalled();
  });
});
