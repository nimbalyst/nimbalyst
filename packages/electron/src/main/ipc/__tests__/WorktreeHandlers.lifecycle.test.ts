// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  createWorktree: vi.fn(),
  deleteWorktree: vi.fn().mockResolvedValue(undefined),
  checkWorktreeRemovable: vi.fn().mockResolvedValue(null),
  getTerminalSessionManager: vi.fn(),
  archiveSessions: vi.fn(),
  store: {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    getWorktreeSessions: vi.fn().mockResolvedValue([]),
    updateArchived: vi.fn().mockResolvedValue(undefined),
  },
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  inUse: true,
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../services/GitWorktreeService', () => ({
  GitWorktreeService: class {
    createWorktree = mocks.createWorktree;
    deleteWorktree = mocks.deleteWorktree;
    checkWorktreeRemovable = mocks.checkWorktreeRemovable;
  },
}));
vi.mock('../../services/WorktreeStore', () => ({ createWorktreeStore: () => mocks.store }));
vi.mock('../../services/SuperLoopStore', () => ({ createSuperLoopStore: vi.fn() }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/ArchiveProgressManager', () => ({ archiveProgressManager: {} }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: {} }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: {} }));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../../services/FeatureUsageService', () => ({ FeatureUsageService: { getInstance: () => ({ recordUsage: vi.fn() }) }, FEATURES: {} }));
vi.mock('../../services/TerminalSessionManager', () => ({ getTerminalSessionManager: mocks.getTerminalSessionManager }));
vi.mock('../../utils/terminalStore', () => ({ getTerminalsByWorktreeId: vi.fn(), deleteTerminalInstance: vi.fn() }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: { start: mocks.start, stop: mocks.stop } }));
vi.mock('../../file/GitWatcherLifecycle', () => ({ isGitRepositoryInUse: () => mocks.inUse }));
vi.mock('../../services/workspaceRepos', () => ({ listReposForRoot: () => [], resolveDefaultRepo: () => null }));
vi.mock('../../services/GitOperationLock', () => ({ gitOperationLock: {} }));
vi.mock('../../services/ai/archiveSessionProviderLifecycle', () => ({ archiveSessionsAndDestroyProviders: mocks.archiveSessions }));
import { registerWorktreeHandlers } from '../WorktreeHandlers';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkWorktreeRemovable.mockResolvedValue(null);
  mocks.store.getWorktreeSessions.mockResolvedValue([]);
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

// The row's branch is the only branch a removal may delete, so every removal
// names it.
it('removes a worktree whose record failed to save, naming its branch', async () => {
  mocks.createWorktree.mockResolvedValue({ id: 'b', path: '/project_worktrees/b', branch: 'worktree/b', projectPath: '/project' });
  mocks.store.create.mockRejectedValueOnce(new Error('database is locked'));
  expect((await mocks.handlers.get('worktree:create')!({}, '/project', { name: 'b' })).success).toBe(false);
  expect(mocks.deleteWorktree).toHaveBeenCalledWith('/project_worktrees/b', '/project', { expectedBranch: 'worktree/b' });
});

it('deletes a worktree through the repo it was branched from, naming its branch', async () => {
  mocks.store.get.mockResolvedValue({ id: 'b', path: '/project_worktrees/b', branch: 'worktree/b', sourceFolderPath: '/collab' });
  expect((await mocks.handlers.get('worktree:delete')!({}, 'b', '/project')).success).toBe(true);
  expect(mocks.deleteWorktree).toHaveBeenCalledWith('/project_worktrees/b', '/collab', { expectedBranch: 'worktree/b' });
  expect(mocks.store.delete).toHaveBeenCalledWith('b');
});

// A refusal deletes nothing, so it must also come before anything is torn
// down: terminals destroyed and the ref watcher stopped are not brought back.
it('refuses to archive a worktree its repository will not remove, before tearing anything down', async () => {
  mocks.store.get.mockResolvedValue({
    id: 'b', path: '/project_worktrees/b', branch: 'worktree/b', projectPath: '/project', sourceFolderPath: '/collab',
    isArchived: false,
  });
  mocks.store.getWorktreeSessions.mockResolvedValue(['s-1']);
  mocks.checkWorktreeRemovable.mockResolvedValue(new Error('Worktree /project_worktrees/b is locked. Unlock it first'));

  expect(await mocks.handlers.get('worktree:archive')!({}, 'b', '/project')).toEqual({
    success: false,
    error: 'Worktree /project_worktrees/b is locked. Unlock it first',
  });

  expect(mocks.checkWorktreeRemovable).toHaveBeenCalledWith('/project_worktrees/b', '/collab', { expectedBranch: 'worktree/b' });
  expect(mocks.getTerminalSessionManager).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.archiveSessions).not.toHaveBeenCalled();
  expect(mocks.store.updateArchived).not.toHaveBeenCalled();
});

it('refuses to delete a worktree its repository will not remove, before stopping its ref watcher', async () => {
  mocks.store.get.mockResolvedValue({ id: 'b', path: '/project_worktrees/b', branch: 'worktree/b', sourceFolderPath: '/collab' });
  mocks.checkWorktreeRemovable.mockResolvedValue(new Error('Refusing to delete /project_worktrees/b'));

  expect(await mocks.handlers.get('worktree:delete')!({}, 'b', '/project')).toEqual({
    success: false,
    error: 'Refusing to delete /project_worktrees/b',
  });

  expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.deleteWorktree).not.toHaveBeenCalled();
  expect(mocks.store.delete).not.toHaveBeenCalled();
});
