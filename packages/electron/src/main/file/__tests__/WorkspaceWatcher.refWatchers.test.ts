// @vitest-environment node
/**
 * Git-ref watchers follow the repos a root holds, and a repo root now holds its
 * gitignored nested clones too, found asynchronously. A detach clears the
 * discovery cache before stopping the root, so stopping has to use the repos
 * that were started, not a fresh scan.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listReposForRoot: vi.fn<(root: string) => Promise<string[]>>(),
  refStart: vi.fn().mockResolvedValue(undefined),
  refStop: vi.fn().mockResolvedValue(undefined),
  referenced: new Set<string>(),
  send: vi.fn(),
  gitignoreHandler: null as null | ((workspacePath: string) => void),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
}));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { workspaceWatcher: { error: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn() } },
}));
vi.mock('../../window/WindowManager', () => ({ getWindowId: vi.fn(), windowStates: new Map() }));
vi.mock('../../ipc/GitStatusHandlers', () => ({ clearGitStatusCache: vi.fn() }));
vi.mock('../OptimizedWorkspaceWatcher', () => ({
  optimizedWorkspaceWatcher: { start: vi.fn().mockResolvedValue(undefined), stopRoot: vi.fn() },
}));
vi.mock('../GitRefWatcher', () => ({ gitRefWatcher: { start: mocks.refStart, stop: mocks.refStop } }));
vi.mock('../GitWatcherLifecycle', () => ({ initGitWatcherLifecycle: vi.fn(), pruneUnusedGitWatchers: vi.fn() }));
vi.mock('../WorkspaceEventBus', () => ({
  setGitignoreChangeHandler: (handler: (workspacePath: string) => void) => {
    mocks.gitignoreHandler = handler;
  },
}));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: vi.fn() } }));
vi.mock('../../services/ProjectFileSyncService', () => ({ getProjectFileSyncService: vi.fn() }));
vi.mock('../../services/sync/projectSyncWikiRules', () => ({ isProjectSyncPath: vi.fn() }));
vi.mock('../../services/SyncManager', () => ({ isSyncEnabled: vi.fn() }));
vi.mock('../../utils/store', () => ({
  getReleaseChannel: vi.fn(),
  getSessionSyncConfig: vi.fn(),
  getWorkspaceRoots: (path: string) => [path],
}));
vi.mock('../../window/windowState', () => ({
  anyWindowReferencesWorkspace: (path: string) => mocks.referenced.has(path),
}));
vi.mock('../../services/workspaceRepos', () => ({
  listReposForRoot: mocks.listReposForRoot,
  clearWorkspaceRepoCache: vi.fn(),
}));

import { startRootWatcher, stopRootWatcher } from '../WorkspaceWatcher';

const window = {} as Parameters<typeof startRootWatcher>[0];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.listReposForRoot.mockReset();
  mocks.refStart.mockClear();
  mocks.refStop.mockClear();
  mocks.send.mockClear();
  mocks.referenced.clear();
});

it('stops the repos it started on detach, without rediscovering them', async () => {
  mocks.listReposForRoot.mockResolvedValue(['/umbrella', '/umbrella/service-a']);
  startRootWatcher(window, '/umbrella');
  await flush();
  expect(mocks.refStart.mock.calls.map(([repo]) => repo)).toEqual(['/umbrella', '/umbrella/service-a']);

  // Detach clears the discovery cache first; a rescan could answer differently.
  mocks.listReposForRoot.mockClear();
  stopRootWatcher(1, '/umbrella');

  expect(mocks.listReposForRoot).not.toHaveBeenCalled();
  expect(mocks.refStop.mock.calls.map(([repo]) => repo)).toEqual(['/umbrella', '/umbrella/service-a']);
});

it('moves the ref watchers and tells the repo pickers when a .gitignore change adds a clone', async () => {
  mocks.listReposForRoot.mockResolvedValue(['/umbrella']);
  startRootWatcher(window, '/umbrella');
  await flush();
  mocks.refStart.mockClear();

  mocks.listReposForRoot.mockResolvedValue(['/umbrella', '/umbrella/service-a']);
  mocks.gitignoreHandler!('/umbrella');
  await flush();

  expect(mocks.refStart).toHaveBeenCalledWith('/umbrella/service-a', '/umbrella');
  expect(mocks.send).toHaveBeenCalledWith('workspace:repos-changed', { workspacePath: '/umbrella' });
});

it('starts nothing when the root is stopped before discovery answers', async () => {
  let answer!: (repos: string[]) => void;
  mocks.listReposForRoot.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
  startRootWatcher(window, '/umbrella');
  stopRootWatcher(1, '/umbrella');

  answer(['/umbrella', '/umbrella/service-a']);
  await flush();

  expect(mocks.refStart).not.toHaveBeenCalled();
});
