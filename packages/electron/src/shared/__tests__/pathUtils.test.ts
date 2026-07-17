import { describe, expect, it } from 'vitest';
import {
  getRelativeWorkspacePath,
  isPathInWorkspace,
  isWorktreePath,
  resolveProjectPath,
} from '../pathUtils';

describe('pathUtils workspace boundaries', () => {
  it('treats files inside the workspace as in-bounds', () => {
    expect(isPathInWorkspace('/Users/test/project/src/App.tsx', '/Users/test/project')).toBe(true);
    expect(getRelativeWorkspacePath('/Users/test/project/src/App.tsx', '/Users/test/project')).toBe('src/App.tsx');
  });

  it('rejects sibling paths that only share a prefix', () => {
    expect(isPathInWorkspace('/Users/test/project-worktrees/feature/src/App.tsx', '/Users/test/project')).toBe(false);
    expect(getRelativeWorkspacePath('/Users/test/project-worktrees/feature/src/App.tsx', '/Users/test/project')).toBeNull();
  });

  it('rejects external Claude memory files', () => {
    const workspacePath = '/Users/test/project';
    const memoryPath = '/Users/test/.claude/projects/project/memory/CLAUDE.md';

    expect(isPathInWorkspace(memoryPath, workspacePath)).toBe(false);
    expect(getRelativeWorkspacePath(memoryPath, workspacePath)).toBeNull();
  });
});

// Mirrors the worktree-resolution cases in
// main/utils/__tests__/workspaceDetection.test.ts so the renderer-side copy of
// these functions (forward-slash variant) can't silently regress.
describe('pathUtils.resolveProjectPath', () => {
  it('returns the same path for regular workspaces', () => {
    expect(resolveProjectPath('/path/to/project')).toBe('/path/to/project');
  });

  it('resolves single-segment worktree paths to parent project', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/swift-falcon'))
      .toBe('/path/to/project');
  });

  it('resolves NESTED worktree paths (branch-style names) to parent project', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch'))
      .toBe('/path/to/project');
    expect(resolveProjectPath('/Users/dev/nimbalyst_worktrees/improvement/fix-askme-for-worktrees'))
      .toBe('/Users/dev/nimbalyst');
  });

  it('resolves a subfolder inside a nested worktree to the parent project', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch/packages/electron'))
      .toBe('/path/to/project');
  });

  it('does not match the _worktrees_backup decoy', () => {
    expect(resolveProjectPath('/path/to/project_worktrees_backup/folder'))
      .toBe('/path/to/project_worktrees_backup/folder');
  });
});

describe('pathUtils.isWorktreePath', () => {
  it('returns false for regular workspaces', () => {
    expect(isWorktreePath('/path/to/project')).toBe(false);
  });

  it('returns true for single-segment and nested worktree paths', () => {
    expect(isWorktreePath('/path/to/project_worktrees/swift-falcon')).toBe(true);
    expect(isWorktreePath('/path/to/project_worktrees/feature/my-branch')).toBe(true);
  });

  it('does not match the _worktrees_backup decoy', () => {
    expect(isWorktreePath('/path/to/project_worktrees_backup/folder')).toBe(false);
  });
});
