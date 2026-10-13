// @vitest-environment node
/**
 * The GitHub panel can point at any of the workspace's repositories (#908).
 * Remote detection and "open PR in a worktree" then act on that repository --
 * and only on one of the workspace's own, never on an arbitrary path a caller
 * passes in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  parseGitHubRemote: vi.fn(),
  createWorktree: vi.fn(),
  store: {
    findByPullRequest: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    linkPullRequest: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
  },
  git: {
    branchLocal: vi.fn().mockResolvedValue({ all: [] }),
    fetch: vi.fn().mockResolvedValue(undefined),
  },
  simpleGit: vi.fn(),
}));

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('electron-log/main', () => ({ default: { scope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (name: string, fn: (...args: any[]) => Promise<any>) => mocks.handlers.set(name, fn),
  safeOn: vi.fn(),
}));
vi.mock('simple-git', () => ({ default: (dir: string) => { mocks.simpleGit(dir); return mocks.git; } }));
vi.mock('../../services/GhCliDetector', () => ({ ghCliDetector: {} }));
vi.mock('../../services/prPermissions', () => ({ computePrPermissions: vi.fn() }));
vi.mock('../../services/GitStatusService', () => ({
  GitStatusService: class { parseGitHubRemote = mocks.parseGitHubRemote; },
}));
vi.mock('../../services/GitWorktreeService', () => ({
  GitWorktreeService: class { createWorktree = mocks.createWorktree; },
}));
vi.mock('../../services/WorktreeStore', () => ({ createWorktreeStore: () => mocks.store }));
vi.mock('../../services/GitOperationLock', () => ({
  gitOperationLock: { withLock: (_key: string, _op: string, fn: () => Promise<unknown>) => fn() },
}));
vi.mock('../../file/GitRefWatcher', () => ({ gitRefWatcher: { start: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/workspaceRepos', () => ({
  listWorkspaceRepos: async () => ['/work', '/work/api'],
}));
vi.mock('../../utils/store', () => ({}));
vi.mock('../../services/GithubServices', () => ({
  getGithubApiService: vi.fn(),
  getGithubPollScheduler: vi.fn(),
  getGithubPullRequestsStore: () => ({ getByNumber: vi.fn().mockResolvedValue(null) }),
  stopGithubPollScheduler: vi.fn(),
}));
vi.mock('../../services/PrTrackerLifecycle', () => ({ applyPrMergeToTrackers: vi.fn() }));

import { registerPullRequestHandlers } from '../PullRequestHandlers';

registerPullRequestHandlers();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.parseGitHubRemote.mockResolvedValue({ remote: 'acme/api', host: 'github.com' });
  mocks.createWorktree.mockResolvedValue({
    id: 'wt', name: 'pr-7', path: '/work_worktrees/pr-7', branch: 'worktree/pr-7', baseBranch: 'pr-7', projectPath: '/work/api',
  });
  mocks.store.findByPullRequest.mockResolvedValue(null);
  mocks.git.branchLocal.mockResolvedValue({ all: [] });
});

describe('the GitHub panel on one of the workspace\'s repositories', () => {
  it('detects the chosen repository\'s remote, and the root\'s when none is chosen', async () => {
    await mocks.handlers.get('pr:detect-remote')!({}, '/work', '/work/api');
    await mocks.handlers.get('pr:detect-remote')!({}, '/work');

    expect(mocks.parseGitHubRemote.mock.calls.map(([repo]) => repo)).toEqual(['/work/api', '/work']);
  });

  it('refuses a path that is not one of the workspace\'s repositories', async () => {
    const result = await mocks.handlers.get('pr:detect-remote')!({}, '/work', '/etc');

    expect(result.success).toBe(false);
    expect(mocks.parseGitHubRemote).not.toHaveBeenCalled();
  });

  it('opens a PR worktree from the chosen repository, recorded as the project\'s', async () => {
    const result = await mocks.handlers.get('pr:open-worktree')!({}, '/work', 'acme/api', 7, '/work/api');

    expect(result.success).toBe(true);
    expect(mocks.simpleGit).toHaveBeenCalledWith('/work/api');
    expect(mocks.git.fetch).toHaveBeenCalledWith('origin', 'pull/7/head:pr-7');
    expect(mocks.createWorktree).toHaveBeenCalledWith('/work/api', expect.objectContaining({ baseBranch: 'pr-7' }));
    expect(mocks.store.create).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: '/work',
      sourceFolderPath: '/work/api',
    }));
  });
});
