import { describe, expect, it, vi } from 'vitest';

import { resolveClaudeCliWorktreeCwd } from '../resolveClaudeCliWorktreeCwd';

/**
 * #933 / NIM-2001: an interactive `claude-code-cli` launch for a worktree session
 * must spawn in the worktree, not the parent workspace. The renderer only knows
 * the parent path and hands it as `requestedCwd`, so the launcher resolves the
 * worktree from the session's `worktreeId` here — overriding the parent path.
 */
describe('resolveClaudeCliWorktreeCwd', () => {
  it('overrides the parent cwd with the worktree path for a worktree session', async () => {
    const cwd = await resolveClaudeCliWorktreeCwd('session-1', '/project', {
      getSessionWorktreeId: async () => 'wt-1',
      getWorktreePath: async () => '/project_worktrees/feature',
      worktreeDirExists: () => true,
    });

    expect(cwd).toBe('/project_worktrees/feature');
  });

  it('returns the requested cwd unchanged for a non-worktree session', async () => {
    const getWorktreePath = vi.fn(async () => '/should-not-be-called');

    const cwd = await resolveClaudeCliWorktreeCwd('session-1', '/project', {
      getSessionWorktreeId: async () => null,
      getWorktreePath,
      worktreeDirExists: () => true,
    });

    expect(cwd).toBe('/project');
    expect(getWorktreePath).not.toHaveBeenCalled();
  });

  it('falls back to the requested cwd when the worktree dir is missing on disk', async () => {
    const logWarn = vi.fn();

    const cwd = await resolveClaudeCliWorktreeCwd('session-1', '/project', {
      getSessionWorktreeId: async () => 'wt-1',
      getWorktreePath: async () => '/project_worktrees/stale',
      worktreeDirExists: () => false,
      logWarn,
    });

    expect(cwd).toBe('/project');
    expect(logWarn).toHaveBeenCalled();
  });

  it('falls back to the requested cwd when the worktree id cannot be resolved to a path', async () => {
    const cwd = await resolveClaudeCliWorktreeCwd('session-1', '/project', {
      getSessionWorktreeId: async () => 'wt-1',
      getWorktreePath: async () => null,
      worktreeDirExists: () => true,
    });

    expect(cwd).toBe('/project');
  });

  it('falls back to the requested cwd (never throws) when a lookup errors', async () => {
    const logWarn = vi.fn();

    const cwd = await resolveClaudeCliWorktreeCwd('session-1', '/project', {
      getSessionWorktreeId: async () => {
        throw new Error('db unavailable');
      },
      getWorktreePath: async () => '/unused',
      worktreeDirExists: () => true,
      logWarn,
    });

    expect(cwd).toBe('/project');
    expect(logWarn).toHaveBeenCalled();
  });
});
