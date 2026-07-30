/**
 * The workspace watcher must keep ElectronDocumentService's metadata cache warm.
 *
 * A WorkspaceEventBus watcher already existed, but no subscriber told the
 * document service anything, so an external edit to a tracker-backed .md left
 * the open Tracker view showing pre-edit frontmatter until the app restarted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(async () => {}),
  unsubscribe: vi.fn(),
  refreshFileMetadata: vi.fn(async () => {}),
  refreshWorkspaceData: vi.fn(async () => {}),
  documentServices: new Map<string, any>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../WorkspaceEventBus', () => ({
  subscribe: mocks.subscribe,
  unsubscribe: mocks.unsubscribe,
  setGitignoreChangeHandler: vi.fn(),
  stopAll: vi.fn(async () => {}),
  getStats: vi.fn(() => ({})),
}));

vi.mock('../../window/WindowManager', () => ({
  getWindowId: vi.fn(() => 1),
  windowStates: new Map(),
  documentServices: mocks.documentServices,
}));

vi.mock('../OptimizedWorkspaceWatcher', () => ({
  optimizedWorkspaceWatcher: {
    start: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(async () => {}),
    addWatchedFolder: vi.fn(),
    removeWatchedFolder: vi.fn(),
    getStats: vi.fn(() => ({})),
  },
}));

vi.mock('../GitRefWatcher', () => ({
  gitRefWatcher: { start: vi.fn(async () => {}), stopAll: vi.fn(async () => {}) },
}));

vi.mock('../../ipc/GitStatusHandlers', () => ({ clearGitStatusCache: vi.fn() }));

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

vi.mock('../../services/ProjectFileSyncService', () => ({
  getProjectFileSyncService: () => ({
    isRecentlyWrittenFromRemote: () => false,
    handleFileSaved: vi.fn(async () => {}),
    handleFileDeletedByPath: vi.fn(),
    syncProject: vi.fn(async () => {}),
    disconnectProject: vi.fn(),
    getProjectStats: () => ({ connected: false, fileCount: 0 }),
    pushLocalFileNow: vi.fn(async () => {}),
  }),
}));

// Project file sync is gated off so its own bus subscription doesn't appear
// alongside the one under test.
vi.mock('../../services/SyncManager', () => ({ isSyncEnabled: () => false }));

vi.mock('../../utils/store', () => ({
  getReleaseChannel: () => 'stable',
  getSessionSyncConfig: () => ({ docSyncEnabledProjects: [] }),
}));

vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: {
    workspaceWatcher: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  startTrackerMetadataWatch,
  stopTrackerMetadataWatch,
  startWorkspaceWatcher,
} from '../WorkspaceWatcher';

const WORKSPACE = path.join(path.sep, 'tmp', 'workspace');

/**
 * Grab the listener the most recent tracker-metadata subscription registered.
 * Most recent, not first: a subscription that failed still recorded a call on
 * the mock, but its listener was never registered on the real bus.
 */
function trackerListener() {
  const call = [...mocks.subscribe.mock.calls]
    .reverse()
    .find((c: any[]) => typeof c[1] === 'string' && c[1].startsWith('tracker-metadata'));
  if (!call) throw new Error('tracker-metadata subscription was never registered');
  return (call as any[])[2];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.documentServices.clear();
  mocks.documentServices.set(WORKSPACE, {
    refreshFileMetadata: mocks.refreshFileMetadata,
    refreshWorkspaceData: mocks.refreshWorkspaceData,
  });
});

afterEach(() => {
  stopTrackerMetadataWatch(WORKSPACE);
  vi.useRealTimers();
});

describe('workspace watcher -> document metadata', () => {
  it('is wired into startWorkspaceWatcher', async () => {
    startWorkspaceWatcher({ id: 1 } as any, WORKSPACE);
    await vi.runAllTimersAsync();

    const ids = mocks.subscribe.mock.calls.map((c: any[]) => c[1]);
    expect(ids.some((id: string) => id.startsWith('tracker-metadata'))).toBe(true);
  });

  it('refreshes metadata for an externally changed .md file', async () => {
    await startTrackerMetadataWatch(WORKSPACE);
    const filePath = path.join(WORKSPACE, 'docs', 'facts', 'thing.md');

    trackerListener().onChange(filePath);
    // Debounced, so nothing synchronous.
    expect(mocks.refreshFileMetadata).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();

    expect(mocks.refreshFileMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.refreshFileMetadata).toHaveBeenCalledWith(filePath);
  });

  it('adopts a newly added .md file', async () => {
    await startTrackerMetadataWatch(WORKSPACE);
    const filePath = path.join(WORKSPACE, 'docs', 'facts', 'new.md');

    trackerListener().onAdd(filePath);
    await vi.runAllTimersAsync();

    expect(mocks.refreshFileMetadata).toHaveBeenCalledWith(filePath);
  });

  it('ignores files that cannot carry tracker frontmatter', async () => {
    await startTrackerMetadataWatch(WORKSPACE);

    trackerListener().onChange(path.join(WORKSPACE, 'src', 'index.ts'));
    trackerListener().onChange(path.join(WORKSPACE, 'assets', 'logo.png'));
    await vi.runAllTimersAsync();

    expect(mocks.refreshFileMetadata).not.toHaveBeenCalled();
    expect(mocks.refreshWorkspaceData).not.toHaveBeenCalled();
  });

  it('coalesces a burst of edits to one file into a single refresh', async () => {
    await startTrackerMetadataWatch(WORKSPACE);
    const filePath = path.join(WORKSPACE, 'docs', 'facts', 'thing.md');

    for (let i = 0; i < 10; i++) trackerListener().onChange(filePath);
    await vi.runAllTimersAsync();

    expect(mocks.refreshFileMetadata).toHaveBeenCalledTimes(1);
  });

  it('falls back to one full refresh when a bulk rewrite touches many files', async () => {
    await startTrackerMetadataWatch(WORKSPACE);

    // e.g. a git checkout / branch switch rewriting a whole docs tree.
    for (let i = 0; i < 60; i++) {
      trackerListener().onChange(path.join(WORKSPACE, 'docs', `doc-${i}.md`));
    }
    await vi.runAllTimersAsync();

    expect(mocks.refreshWorkspaceData).toHaveBeenCalledTimes(1);
    expect(mocks.refreshFileMetadata).not.toHaveBeenCalled();
  });

  it('reconciles a deleted .md through a full refresh', async () => {
    await startTrackerMetadataWatch(WORKSPACE);

    trackerListener().onUnlink(path.join(WORKSPACE, 'docs', 'facts', 'thing.md'));
    await vi.runAllTimersAsync();

    // No per-path removal API exists; the scan's mtime diffing emits the
    // `removed` metadata events the Tracker view already listens for.
    expect(mocks.refreshWorkspaceData).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no document service owns the workspace', async () => {
    mocks.documentServices.clear();
    await startTrackerMetadataWatch(WORKSPACE);

    trackerListener().onChange(path.join(WORKSPACE, 'docs', 'thing.md'));
    await expect(vi.runAllTimersAsync()).resolves.toBeDefined();

    expect(mocks.refreshFileMetadata).not.toHaveBeenCalled();
  });

  it('can retry after a failed subscription', async () => {
    mocks.subscribe.mockRejectedValueOnce(new Error('bus unavailable'));
    await expect(startTrackerMetadataWatch(WORKSPACE)).rejects.toThrow('bus unavailable');

    // A poisoned entry would make this a silent no-op and leave the workspace
    // permanently unwatched.
    await startTrackerMetadataWatch(WORKSPACE);
    trackerListener().onChange(path.join(WORKSPACE, 'docs', 'thing.md'));
    await vi.runAllTimersAsync();

    expect(mocks.refreshFileMetadata).toHaveBeenCalledTimes(1);
  });

  it('stops refreshing after the workspace is torn down', async () => {
    await startTrackerMetadataWatch(WORKSPACE);
    const filePath = path.join(WORKSPACE, 'docs', 'thing.md');

    trackerListener().onChange(filePath);
    stopTrackerMetadataWatch(WORKSPACE);
    await vi.runAllTimersAsync();

    expect(mocks.unsubscribe).toHaveBeenCalled();
    expect(mocks.refreshFileMetadata).not.toHaveBeenCalled();
  });
});
