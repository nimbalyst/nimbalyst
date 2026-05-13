import { describe, expect, it } from 'vitest';
import {
  resolveOwnedWorkspacePath,
  sessionEventMatchesWorkspace,
} from '../sessionWorkspaceRouting';

describe('sessionWorkspaceRouting', () => {
  it('matches a parent workspace subscription for worktree session events', () => {
    expect(sessionEventMatchesWorkspace({
      subscribedWorkspacePath: '/repo',
      eventWorkspacePath: '/repo_worktrees/bright-tide',
      sessionWorkspacePath: '/repo',
    })).toBe(true);
  });

  it('does not match unrelated workspace events', () => {
    expect(sessionEventMatchesWorkspace({
      subscribedWorkspacePath: '/repo-a',
      eventWorkspacePath: '/repo-b_worktrees/fix',
      sessionWorkspacePath: '/repo-b',
    })).toBe(false);
  });

  it('falls back to the event workspace when no canonical session workspace is known', () => {
    expect(sessionEventMatchesWorkspace({
      subscribedWorkspacePath: '/repo_worktrees/bright-tide',
      eventWorkspacePath: '/repo_worktrees/bright-tide',
      sessionWorkspacePath: null,
    })).toBe(true);
  });

  it('prefers the canonical session workspace when resolving ownership', () => {
    expect(resolveOwnedWorkspacePath({
      eventWorkspacePath: '/repo_worktrees/bright-tide',
      sessionWorkspacePath: '/repo',
    })).toBe('/repo');
  });
});
