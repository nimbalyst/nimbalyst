// @vitest-environment node
/**
 * The GitHub panel remembers which of a workspace's repositories it points
 * at. Detection must use that repository, and fall back to the workspace root
 * when the remembered one is no longer among the workspace's repositories --
 * otherwise the panel would say "no remote" with no way to recover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectRemote: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../../../services/RendererGhCliService', () => ({
  getGhCliService: () => ({
    getStatus: () => Promise.resolve({ installed: true, authed: true }),
    onStatusChanged: () => () => {},
  }),
}));
vi.mock('../../../services/RendererPullRequestService', () => ({
  getPullRequestService: () => ({ detectRemote: mocks.detectRemote, onListUpdated: () => () => {} }),
}));

import { store } from '@nimbalyst/runtime/store';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { prRemoteAtom, prSelectedRepoAtom } from '../../atoms/pullRequests';
import { initPullRequestListeners } from '../pullRequestListeners';

describe('the GitHub panel\'s remembered repository', () => {
  let dispose: () => void;

  beforeEach(() => {
    (globalThis as any).window = { electronAPI: { invoke: mocks.invoke } };
    mocks.invoke.mockImplementation(async (channel: string) =>
      channel === 'workspace:get-state' ? { prRepoPath: '/work/api' } : undefined);
    store.set(prSelectedRepoAtom, null);
    store.set(prRemoteAtom, null);
    store.set(activeWorkspacePathAtom, '/work');
  });

  afterEach(() => {
    dispose?.();
    vi.clearAllMocks();
  });

  it('detects the remote of the repository remembered for the workspace', async () => {
    mocks.detectRemote.mockResolvedValue({ remote: 'acme/api', host: 'github.com' });

    dispose = initPullRequestListeners();

    await vi.waitFor(() => expect(store.get(prRemoteAtom)).toEqual({
      workspacePath: '/work', repoPath: '/work/api', remote: 'acme/api', host: 'github.com',
    }));
    expect(mocks.detectRemote).toHaveBeenCalledWith('/work', '/work/api');
  });

  it('falls back to the workspace root when the remembered repository is gone', async () => {
    mocks.detectRemote.mockImplementation(async (_workspace: string, repoPath?: string) => {
      if (repoPath) throw new Error(`${repoPath} is not a repository of this project`);
      return { remote: 'acme/work', host: 'github.com' };
    });

    dispose = initPullRequestListeners();

    await vi.waitFor(() => expect(store.get(prRemoteAtom)).toMatchObject({ repoPath: '/work', remote: 'acme/work' }));
    expect(store.get(prSelectedRepoAtom)).toBeNull();
  });
});
