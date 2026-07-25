import { describe, expect, it, vi } from 'vitest';
import { createTrackerProjectScopeResolver } from '../TrackerProjectScope';

describe('TrackerProjectScope', () => {
  it('maps different workspace paths for the same tracker project to one stable scope', async () => {
    const findTeamForWorkspace = vi.fn(async (workspacePath: string) => workspacePath.includes('other-repo')
      ? { orgId: 'org-2', teamProjectId: 'project-2' }
      : { orgId: 'org-1', teamProjectId: 'project-1' });
    const resolveScope = createTrackerProjectScopeResolver({
      findTeamForWorkspace,
      getNormalizedGitRemote: vi.fn(async () => 'github.com/acme/repo'),
      resolveProjectPath: (workspacePath) => workspacePath,
    });

    const checkout = await resolveScope('/Users/me/repo');
    const worktree = await resolveScope('/tmp/repo_worktrees/feature');
    const other = await resolveScope('/Users/me/other-repo');

    expect(checkout).toEqual({ scope: 'org:org-1:tracker:project-1', syncable: true });
    expect(worktree).toEqual(checkout);
    expect(other.scope).toBe('org:org-2:tracker:project-2');
    expect(other.scope).not.toBe(checkout.scope);
  });
});
