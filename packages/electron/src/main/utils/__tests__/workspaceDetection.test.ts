import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveProjectPath,
  isWorktreePath,
  findNearestAncestor,
  getAdditionalDirectoriesForWorkspace,
} from '../workspaceDetection';

describe('resolveProjectPath', () => {
  it('returns the same path for regular workspaces', () => {
    expect(resolveProjectPath('/path/to/project')).toBe('/path/to/project');
    expect(resolveProjectPath('/Users/dev/my-app')).toBe('/Users/dev/my-app');
    expect(resolveProjectPath('/home/user/code/myrepo')).toBe('/home/user/code/myrepo');
  });

  it('resolves worktree paths to parent project', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/swift-falcon'))
      .toBe('/path/to/project');
    expect(resolveProjectPath('/Users/dev/my-app_worktrees/brave-eagle'))
      .toBe('/Users/dev/my-app');
    expect(resolveProjectPath('/home/user/code/myrepo_worktrees/test-123'))
      .toBe('/home/user/code/myrepo');
  });

  it('resolves NESTED worktree paths (branch-style names) to parent project', () => {
    // Regression for re-prompting in worktrees whose branch name contains a
    // slash (e.g. `feature/foo`), which create nested directories.
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch'))
      .toBe('/path/to/project');
    expect(resolveProjectPath('/Users/dev/Belegify_worktrees/feature/assign-people-on-receipts'))
      .toBe('/Users/dev/Belegify');
    expect(resolveProjectPath('/Users/dev/nimbalyst_worktrees/improvement/fix-askme-for-worktrees'))
      .toBe('/Users/dev/nimbalyst');
  });

  it('resolves a subfolder inside a nested worktree to the parent project', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch/packages/electron'))
      .toBe('/path/to/project');
  });

  it('resolves nested worktrees with underscore project names', () => {
    expect(resolveProjectPath('/path/to/my_cool_project_worktrees/feature/x'))
      .toBe('/path/to/my_cool_project');
  });

  it('handles trailing slashes on nested worktree paths', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/feature/my-branch/'))
      .toBe('/path/to/project');
  });

  it('does not resolve a plain subfolder of a non-worktree project (the permission cascade handles that)', () => {
    expect(resolveProjectPath('/path/to/project/packages/electron'))
      .toBe('/path/to/project/packages/electron');
  });

  it('handles trailing slashes on worktree paths', () => {
    expect(resolveProjectPath('/path/to/project_worktrees/swift-falcon/'))
      .toBe('/path/to/project');
    expect(resolveProjectPath('/path/to/project_worktrees/swift-falcon//'))
      .toBe('/path/to/project');
  });

  it('does not match paths that just contain _worktrees in the middle', () => {
    // This path has _worktrees in it but is not a worktree path pattern
    expect(resolveProjectPath('/path/to/project_worktrees_backup/folder'))
      .toBe('/path/to/project_worktrees_backup/folder');
  });

  it('handles empty and null-ish inputs gracefully', () => {
    expect(resolveProjectPath('')).toBe('');
    expect(resolveProjectPath(null as unknown as string)).toBe(null);
    expect(resolveProjectPath(undefined as unknown as string)).toBe(undefined);
  });

  it('handles complex project names with underscores', () => {
    expect(resolveProjectPath('/path/to/my_cool_project_worktrees/branch-1'))
      .toBe('/path/to/my_cool_project');
  });

  it('handles Windows-style paths', () => {
    // Note: Our regex uses / which works on Windows when paths are normalized
    // but if someone passes backslashes, it won't match (that's okay)
    expect(resolveProjectPath('C:/Users/dev/project_worktrees/feature'))
      .toBe('C:/Users/dev/project');
  });
});

describe('isWorktreePath', () => {
  it('returns false for regular workspaces', () => {
    expect(isWorktreePath('/path/to/project')).toBe(false);
    expect(isWorktreePath('/Users/dev/my-app')).toBe(false);
    expect(isWorktreePath('/home/user/code/myrepo')).toBe(false);
  });

  it('returns true for worktree paths', () => {
    expect(isWorktreePath('/path/to/project_worktrees/swift-falcon')).toBe(true);
    expect(isWorktreePath('/Users/dev/my-app_worktrees/brave-eagle')).toBe(true);
    expect(isWorktreePath('/home/user/code/myrepo_worktrees/test-123')).toBe(true);
  });

  it('returns true for NESTED worktree paths (branch-style names)', () => {
    expect(isWorktreePath('/path/to/project_worktrees/feature/my-branch')).toBe(true);
    expect(isWorktreePath('/Users/dev/Belegify_worktrees/feature/assign-people')).toBe(true);
    expect(isWorktreePath('/path/to/project_worktrees/feature/my-branch/packages/electron')).toBe(true);
  });

  it('does not match the _worktrees_backup decoy with nested children', () => {
    expect(isWorktreePath('/path/to/project_worktrees_backup/feature/x')).toBe(false);
  });

  it('handles trailing slashes', () => {
    expect(isWorktreePath('/path/to/project_worktrees/swift-falcon/')).toBe(true);
  });

  it('handles empty and null-ish inputs gracefully', () => {
    expect(isWorktreePath('')).toBe(false);
    expect(isWorktreePath(null as unknown as string)).toBe(false);
    expect(isWorktreePath(undefined as unknown as string)).toBe(false);
  });

  it('does not match paths that just contain _worktrees in the middle', () => {
    expect(isWorktreePath('/path/to/project_worktrees_backup/folder')).toBe(false);
  });
});

describe('getAdditionalDirectoriesForWorkspace', () => {
  let tmpRoot: string;
  let projectPath: string;
  let worktreesDir: string;

  beforeEach(() => {
    // Real filesystem fixture so the sync fs.readdirSync path is exercised
    // end-to-end. The function is called from a synchronous loader and must
    // tolerate a missing _worktrees dir without blowing up.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-add-dirs-'));
    projectPath = path.join(tmpRoot, 'project');
    fs.mkdirSync(projectPath);
    worktreesDir = path.join(tmpRoot, 'project_worktrees');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty list for a project with no worktrees and no extension marker', () => {
    expect(getAdditionalDirectoriesForWorkspace(projectPath)).toEqual([]);
  });

  it('returns sibling worktree paths when called from the parent project root', () => {
    fs.mkdirSync(worktreesDir);
    fs.mkdirSync(path.join(worktreesDir, 'proud-gorge'));
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(projectPath);
    expect(dirs.sort()).toEqual([
      path.join(worktreesDir, 'proud-gorge'),
      path.join(worktreesDir, 'swift-falcon'),
    ].sort());
  });

  it('returns the parent project plus other sibling worktrees when called from a worktree', () => {
    fs.mkdirSync(worktreesDir);
    const cwd = path.join(worktreesDir, 'proud-gorge');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(cwd);
    expect(dirs.sort()).toEqual([
      projectPath,
      path.join(worktreesDir, 'swift-falcon'),
    ].sort());
    // The current worktree itself must not appear -- it is already the
    // workingDirectory, and re-listing it would just add noise.
    expect(dirs).not.toContain(cwd);
  });

  it('survives a missing _worktrees directory', () => {
    // No worktrees dir created. Should not throw, just return empty.
    expect(getAdditionalDirectoriesForWorkspace(projectPath)).toEqual([]);
  });
});

describe('findNearestAncestor', () => {
  const trusted = new Set(['/path/to/project']);
  const pred = (dir: string) => trusted.has(dir);

  it('returns the start path itself when it matches', () => {
    expect(findNearestAncestor('/path/to/project', pred)).toBe('/path/to/project');
  });

  it('walks up to the nearest matching ancestor (subfolder cascade)', () => {
    expect(findNearestAncestor('/path/to/project/packages/electron', pred))
      .toBe('/path/to/project');
    expect(findNearestAncestor('/path/to/project/src', pred)).toBe('/path/to/project');
  });

  it('returns null when no ancestor matches', () => {
    expect(findNearestAncestor('/some/other/place', pred)).toBe(null);
  });

  it('returns the most specific matching ancestor when several match', () => {
    const t2 = new Set(['/a', '/a/b/c']);
    expect(findNearestAncestor('/a/b/c/d', (d) => t2.has(d))).toBe('/a/b/c');
  });

  it('handles empty input and trailing slashes', () => {
    expect(findNearestAncestor('', pred)).toBe(null);
    expect(findNearestAncestor('/path/to/project/packages/', pred)).toBe('/path/to/project');
  });
});
