import { afterEach, describe, expect, it } from 'vitest';
import {
  areTrackerToolsEnabled,
  configureMcpServers,
  resolveTrackersWorkspacePath,
} from '../mcpServerConfig';

describe('areTrackerToolsEnabled', () => {
  afterEach(() => {
    configureMcpServers({ trackersAgentToolsDisabledLoader: null });
  });

  it('defaults to enabled when no loader is wired', () => {
    expect(areTrackerToolsEnabled('/some/workspace')).toBe(true);
  });

  it('reflects the loader per workspace', () => {
    configureMcpServers({
      trackersAgentToolsDisabledLoader: (workspacePath?: string) => workspacePath === '/disabled',
    });

    expect(areTrackerToolsEnabled('/disabled')).toBe(false);
    expect(areTrackerToolsEnabled('/enabled')).toBe(true);
  });

  it('falls back to enabled when the loader throws', () => {
    configureMcpServers({
      trackersAgentToolsDisabledLoader: () => {
        throw new Error('boom');
      },
    });

    expect(areTrackerToolsEnabled('/any')).toBe(true);
  });
});

describe('resolveTrackersWorkspacePath', () => {
  it('prefers the MCP config workspace path (parent project for worktrees)', () => {
    expect(
      resolveTrackersWorkspacePath({
        mcpConfigWorkspacePath: '/project',
        worktreeProjectPath: '/project-alt',
        worktreePath: '/project_worktrees/wt',
      })
    ).toBe('/project');
  });

  it('falls back through worktree project path then worktree path', () => {
    expect(
      resolveTrackersWorkspacePath({ worktreeProjectPath: '/project', worktreePath: '/wt' })
    ).toBe('/project');
    expect(resolveTrackersWorkspacePath({ worktreePath: '/wt' })).toBe('/wt');
    expect(resolveTrackersWorkspacePath(undefined)).toBeUndefined();
  });
});
