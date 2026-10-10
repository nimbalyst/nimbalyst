// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  createWorktree: vi.fn(),
  getWorktreeStatus: vi.fn(),
  fetch: vi.fn(),
  store: { create: vi.fn().mockResolvedValue(undefined), getByPath: vi.fn() },
  start: vi.fn().mockResolvedValue(undefined),
  inUse: true,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../services/GitWorktreeService', () => ({ GitWorktreeService: class { createWorktree = mocks.createWorktree; getWorktreeStatus = mocks.getWorktreeStatus; } }));
vi.mock('simple-git', () => ({ default: () => ({ fetch: mocks.fetch }) }));
vi.mock('../../services/WorktreeStore', () => ({ createWorktreeStore: () => mocks.store }));
vi.mock('../../services/SuperLoopStore', () => ({ createSuperLoopStore: vi.fn() }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/ArchiveProgressManager', () => ({ archiveProgressManager: {} }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: {} }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: {} }));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../../services/FeatureUsageService', () => ({ FeatureUsageService: { getInstance: () => ({ recordUsage: vi.fn() }) }, FEATURES: {} }));
vi.mock('../../services/TerminalSessionManager', () => ({ getTerminalSessionManager: vi.fn() }));
vi.mock('../../utils/terminalStore', () => ({ getTerminalsByWorktreeId: vi.fn(), deleteTerminalInstance: vi.fn() }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: { start: mocks.start } }));
vi.mock('../../file/GitWatcherLifecycle', () => ({ isGitRepositoryInUse: () => mocks.inUse }));
vi.mock('../../services/workspaceRepos', () => ({ listReposForRoot: () => [], resolveDefaultRepo: () => null }));
vi.mock('../../services/GitOperationLock', () => ({ gitOperationLock: {} }));
vi.mock('../../services/ai/archiveSessionProviderLifecycle', () => ({ archiveSessionsAndDestroyProviders: vi.fn() }));
import { registerWorktreeHandlers } from '../WorktreeHandlers';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inUse = true;
  registerWorktreeHandlers();
});

it.each([false, true])('starts monitoring after creation only while the project is in use (%s)', async (inUse) => {
  let finish!: (value: unknown) => void;
  mocks.createWorktree.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const creating = mocks.handlers.get('worktree:create')!({}, '/project', { name: 'branch' });
  expect(mocks.createWorktree).toHaveBeenCalled();
  // The owning window can close while Git is still creating the worktree.
  mocks.inUse = inUse;
  const worktree = { id: 'branch', path: '/project_worktrees/branch', branch: 'branch', projectPath: '/project' };
  finish(worktree);
  expect((await creating).success).toBe(true);
  expect(mocks.store.create).toHaveBeenCalledWith(expect.objectContaining(worktree));
  expect(mocks.start).toHaveBeenCalledTimes(inUse ? 1 : 0);
});

// #282: Archive on a worktree session waits for this status check. A fetch
// that never returns (no network, a stalled remote) left the click doing nothing.
it('returns local status when the pre-archive fetch hangs', async () => {
  vi.useFakeTimers();
  try {
    mocks.store.getByPath.mockResolvedValue({ baseBranch: 'main' });
    mocks.fetch.mockReturnValue(new Promise(() => {}));
    mocks.getWorktreeStatus.mockResolvedValue({ hasUncommittedChanges: false, isMerged: true });
    const status = mocks.handlers.get('worktree:get-status')!({}, '/project_worktrees/branch', { fetchFirst: true });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(status).resolves.toMatchObject({ success: true, status: { isMerged: true } });
  } finally {
    vi.useRealTimers();
  }
});
