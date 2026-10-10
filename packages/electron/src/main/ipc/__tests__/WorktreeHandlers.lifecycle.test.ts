// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  createWorktree: vi.fn(),
  store: { create: vi.fn().mockResolvedValue(undefined) },
  start: vi.fn().mockResolvedValue(undefined),
  inUse: true,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../services/GitWorktreeService', () => ({ GitWorktreeService: class { createWorktree = mocks.createWorktree; } }));
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
  // The handler resolves the source repo (async discovery) before git starts.
  await vi.waitFor(() => expect(mocks.createWorktree).toHaveBeenCalled());
  // The owning window can close while Git is still creating the worktree.
  mocks.inUse = inUse;
  const worktree = { id: 'branch', path: '/project_worktrees/branch', branch: 'branch', projectPath: '/project' };
  finish(worktree);
  expect((await creating).success).toBe(true);
  expect(mocks.store.create).toHaveBeenCalledWith(expect.objectContaining(worktree));
  expect(mocks.start).toHaveBeenCalledTimes(inUse ? 1 : 0);
});
