// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  tree: { id: 'tree', path: '/trees/tree', projectPath: '/project', sourceFolderPath: '/source', name: 'tree', createdAt: Date.now(), isArchived: false },
  store: { get: vi.fn(), getWorktreeSessions: vi.fn(), updateArchived: vi.fn(), delete: vi.fn() },
  loops: { getLoopByWorktreeId: vi.fn(), updateLoop: vi.fn() },
  metadata: vi.fn(), provider: vi.fn(), terminals: vi.fn(), stop: vi.fn(),
  disk: vi.fn(), status: vi.fn(), queue: vi.fn(), progress: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: any) => m.handlers.set(name, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../services/GitWorktreeService', () => ({ GitWorktreeService: class { deleteWorktree = m.disk; getWorktreeStatus = m.status; } }));
vi.mock('../../services/WorktreeStore', () => ({ createWorktreeStore: () => m.store }));
vi.mock('../../services/SuperLoopStore', () => ({ createSuperLoopStore: () => m.loops }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/ArchiveProgressManager', () => ({ archiveProgressManager: { addTask: m.queue, updateTaskStatus: m.progress } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { updateMetadata: m.metadata } }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ ProviderFactory: { destroyProvider: m.provider } }));
vi.mock('../../services/analytics/AnalyticsService', () => ({ AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) } }));
vi.mock('../../services/FeatureUsageService', () => ({ FeatureUsageService: { getInstance: () => ({ recordUsage: vi.fn() }) }, FEATURES: {} }));
vi.mock('../../services/TerminalSessionManager', () => ({ getTerminalSessionManager: () => ({ destroyTerminalsForSessions: m.terminals }) }));
vi.mock('../../utils/terminalStore', () => ({ getTerminalsByWorktreeId: () => [], deleteTerminalInstance: vi.fn() }));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: { stop: m.stop } }));
vi.mock('../../file/GitWatcherLifecycle', () => ({ isGitRepositoryInUse: () => false }));
vi.mock('../../services/workspaceRepos', () => ({ listReposForRoot: () => [], resolveDefaultRepo: () => null }));
vi.mock('../../services/GitOperationLock', () => ({ gitOperationLock: {} }));
import { registerWorktreeHandlers } from '../WorktreeHandlers';

const remove = (id = 'tree', workspace = '/project') => m.handlers.get('worktree:delete')!({}, id, workspace);
const cleanup = () => m.queue.mock.calls[0][2]() as Promise<void>;
beforeEach(() => {
  vi.resetAllMocks();
  m.tree.isArchived = false;
  m.store.get.mockResolvedValue(m.tree);
  m.store.getWorktreeSessions.mockResolvedValue(['session']);
  m.store.updateArchived.mockImplementation(async (_id, archived) => { m.tree.isArchived = archived; });
  m.metadata.mockResolvedValue(undefined);
  m.terminals.mockResolvedValue(undefined);
  m.stop.mockResolvedValue(undefined);
  m.disk.mockResolvedValue(undefined);
  m.status.mockResolvedValue({ hasUncommittedChanges: false, isMerged: true });
  m.loops.getLoopByWorktreeId.mockResolvedValue(null);
  registerWorktreeHandlers();
});

it.each([['', '/project'], ['tree', '']])('rejects missing identity/owner (%s, %s)', async (id, workspace) => {
  expect((await remove(id, workspace)).success).toBe(false);
  expect(m.store.get).not.toHaveBeenCalled();
  expect(m.disk).not.toHaveBeenCalled();
});
it('rejects a missing worktree without retiring sessions or deleting disk', async () => {
  m.store.get.mockResolvedValue(null);
  expect((await remove()).success).toBe(false);
  expect(m.metadata).not.toHaveBeenCalled();
  expect(m.disk).not.toHaveBeenCalled();
});
it('rejects the wrong workspace before any destructive work', async () => {
  expect((await remove('tree', '/wrong')).success).toBe(false);
  expect(m.terminals).not.toHaveBeenCalled();
  expect(m.metadata).not.toHaveBeenCalled();
  expect(m.disk).not.toHaveBeenCalled();
});
it('retires sessions/providers before queued cleanup and retains the store row', async () => {
  expect(await remove()).toEqual({ success: true });
  expect(m.terminals).toHaveBeenCalledWith(['session']);
  expect(m.stop).toHaveBeenCalledWith('/trees/tree');
  expect(m.metadata).toHaveBeenCalledWith('session', { isArchived: true });
  expect(m.provider).toHaveBeenCalledWith('session');
  expect(m.metadata.mock.invocationCallOrder[0]).toBeLessThan(m.provider.mock.invocationCallOrder[0]);
  expect(m.disk).not.toHaveBeenCalled();
  expect(m.store.updateArchived).not.toHaveBeenCalled();
  expect(m.store.delete).not.toHaveBeenCalled();
  await cleanup();
  expect(m.disk).toHaveBeenCalledWith('/trees/tree', '/source');
  expect(m.store.updateArchived).toHaveBeenCalledWith('tree', true);
  expect(m.store.delete).not.toHaveBeenCalled();
});
it('does not mark archived while disk deletion is pending', async () => {
  let finish!: () => void;
  m.disk.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  await remove();
  const pending = cleanup();
  expect(m.tree.isArchived).toBe(false);
  expect(m.store.updateArchived).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(m.tree.isArchived).toBe(true);
});
it('unarchives sessions and retains recoverable state when disk cleanup fails', async () => {
  m.disk.mockRejectedValue(new Error('disk cleanup failed'));
  await remove();
  await expect(cleanup()).rejects.toThrow('disk cleanup failed');
  expect(m.metadata).toHaveBeenLastCalledWith('session', { isArchived: false });
  expect(m.tree.isArchived).toBe(false);
  expect(m.store.delete).not.toHaveBeenCalled();
});
it('does not queue disk cleanup when terminal retirement rejects', async () => {
  m.terminals.mockRejectedValue(new Error('terminal retirement failed'));
  expect((await remove()).success).toBe(false);
  expect(m.metadata).not.toHaveBeenCalled();
  expect(m.queue).not.toHaveBeenCalled();
});
it('preserves archive policy: failed session write keeps its provider alive', async () => {
  m.metadata.mockRejectedValue(new Error('archive write failed'));
  expect((await remove()).success).toBe(true);
  expect(m.provider).not.toHaveBeenCalled();
  expect(m.queue).toHaveBeenCalledTimes(1);
  expect(m.tree.isArchived).toBe(false);
});
it('preserves archive policy when provider retirement fails', async () => {
  m.provider.mockImplementation(() => { throw new Error('provider retirement failed'); });
  expect((await remove()).success).toBe(true);
  expect(m.metadata).toHaveBeenCalledWith('session', { isArchived: true });
  expect(m.queue).toHaveBeenCalledTimes(1);
  expect(m.tree.isArchived).toBe(false);
});
