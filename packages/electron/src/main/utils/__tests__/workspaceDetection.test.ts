import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveProjectPath,
  isWorktreePath,
  clearWorktreeIdentityCache,
  findNearestAncestor,
  findProjectRoot,
  getAdditionalDirectoriesForWorkspace,
} from '../workspaceDetection';

/**
 * Hand-construct the real on-disk structure git creates for a linked
 * worktree, without shelling out to `git worktree add` (keeps tests fast
 * and independent of a git binary on PATH). Mirrors the exact format
 * findProjectRoot's own tests already rely on (`.git` file with a
 * `gitdir: <path>` line) plus the worktree-registration side git also
 * writes: `<main>/.git/worktrees/<name>/gitdir` pointing back at the
 * worktree's `.git` file.
 */
function createLinkedWorktree(
  mainRepoPath: string,
  worktreePath: string,
  worktreeName: string,
): void {
  fs.mkdirSync(mainRepoPath, { recursive: true });
  fs.mkdirSync(path.join(mainRepoPath, '.git'), { recursive: true });
  const registrationDir = path.join(mainRepoPath, '.git', 'worktrees', worktreeName);
  fs.mkdirSync(registrationDir, { recursive: true });

  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${registrationDir}\n`);
  fs.writeFileSync(path.join(registrationDir, 'gitdir'), `${path.join(worktreePath, '.git')}\n`);
}

describe('resolveProjectPath', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-worktree-identity-'));
    clearWorktreeIdentityCache();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearWorktreeIdentityCache();
  });

  it('returns the normalized path unchanged for a regular (non-worktree) project', () => {
    const projectPath = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
    expect(resolveProjectPath(projectPath)).toBe(projectPath);
  });

  it('resolves a real linked worktree to its main repository root', () => {
    const mainRepo = path.join(tmpRoot, 'project');
    const worktree = path.join(tmpRoot, 'project_worktrees', 'swift-falcon');
    createLinkedWorktree(mainRepo, worktree, 'swift-falcon');

    expect(resolveProjectPath(worktree)).toBe(fs.realpathSync.native(mainRepo));
  });

  it('resolves a nested branch-style worktree name to the main repository root', () => {
    // Regression for branch names containing a slash (e.g. `feature/foo`),
    // which create nested worktree directories on disk.
    const mainRepo = path.join(tmpRoot, 'project');
    const worktree = path.join(tmpRoot, 'project_worktrees', 'feature', 'my-branch');
    createLinkedWorktree(mainRepo, worktree, 'feature-my-branch');

    expect(resolveProjectPath(worktree)).toBe(fs.realpathSync.native(mainRepo));
  });

  it('does NOT resolve a project that is literally named "..._worktrees" (has its own .git directory)', () => {
    // The old lexical matcher misidentified this; a real .git DIRECTORY
    // (not a linked-worktree .git FILE) means this is its own project.
    const literalProject = path.join(tmpRoot, 'my_app_worktrees', 'folder');
    fs.mkdirSync(path.join(literalProject, '.git'), { recursive: true });
    expect(resolveProjectPath(literalProject)).toBe(fs.realpathSync.native(literalProject));
  });

  it('does not treat a git submodule as a worktree', () => {
    // Submodules also use a `.git` FILE, but pointing at `.git/modules/<name>`
    // -- a distinct trust boundary from a linked worktree, must not inherit
    // the superproject's trust.
    const superProject = path.join(tmpRoot, 'super');
    fs.mkdirSync(superProject, { recursive: true });
    const moduleDir = path.join(superProject, '.git', 'modules', 'lib');
    fs.mkdirSync(moduleDir, { recursive: true });
    const submodulePath = path.join(superProject, 'vendor', 'lib');
    fs.mkdirSync(submodulePath, { recursive: true });
    fs.writeFileSync(path.join(submodulePath, '.git'), `gitdir: ${moduleDir}\n`);

    expect(resolveProjectPath(submodulePath)).toBe(fs.realpathSync.native(submodulePath));
  });

  it('fails closed (returns the input unchanged) for a forged .git file pointing at another project\'s worktree registration', () => {
    // SECURITY: an attacker-controlled directory claims to be a worktree of
    // a real, trusted project by pointing its .git file at that project's
    // real worktrees/<name> registration -- but that registration's own
    // back-pointer does not point back at the attacker's directory, so this
    // must NOT resolve to (and inherit trust from) the victim project.
    const victim = path.join(tmpRoot, 'victim');
    const legitWorktree = path.join(tmpRoot, 'victim_worktrees', 'real');
    createLinkedWorktree(victim, legitWorktree, 'real');

    const attackerDir = path.join(tmpRoot, 'attacker-controlled');
    fs.mkdirSync(attackerDir, { recursive: true });
    fs.writeFileSync(
      path.join(attackerDir, '.git'),
      `gitdir: ${path.join(victim, '.git', 'worktrees', 'real')}\n`,
    );

    expect(resolveProjectPath(attackerDir)).toBe(fs.realpathSync.native(attackerDir));
  });

  it('fails closed for a path that does not exist on disk', () => {
    const missing = path.join(tmpRoot, 'does-not-exist_worktrees', 'x');
    expect(resolveProjectPath(missing)).toBe(missing);
  });

  it('resolves a symlinked worktree the same as the real path', () => {
    const mainRepo = path.join(tmpRoot, 'project');
    const worktree = path.join(tmpRoot, 'project_worktrees', 'swift-falcon');
    createLinkedWorktree(mainRepo, worktree, 'swift-falcon');

    const linkPath = path.join(tmpRoot, 'link-to-worktree');
    try {
      fs.symlinkSync(worktree, linkPath, 'junction');
    } catch {
      // Symlink/junction creation can require elevated privileges in some
      // CI sandboxes; skip rather than fail the suite on an environment
      // limitation unrelated to the code under test.
      return;
    }

    expect(resolveProjectPath(linkPath)).toBe(fs.realpathSync.native(mainRepo));
  });

  it('handles empty and null-ish inputs gracefully', () => {
    expect(resolveProjectPath('')).toBe('');
    expect(resolveProjectPath(null as unknown as string)).toBe(null);
    expect(resolveProjectPath(undefined as unknown as string)).toBe(undefined);
  });
});

describe('isWorktreePath', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-worktree-identity-'));
    clearWorktreeIdentityCache();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    clearWorktreeIdentityCache();
  });

  it('returns false for a regular (non-worktree) project', () => {
    const projectPath = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
    expect(isWorktreePath(projectPath)).toBe(false);
  });

  it('returns true for a real linked worktree', () => {
    const mainRepo = path.join(tmpRoot, 'project');
    const worktree = path.join(tmpRoot, 'project_worktrees', 'swift-falcon');
    createLinkedWorktree(mainRepo, worktree, 'swift-falcon');
    expect(isWorktreePath(worktree)).toBe(true);
  });

  it('returns false for a project literally named "..._worktrees"', () => {
    const literalProject = path.join(tmpRoot, 'my_app_worktrees', 'folder');
    fs.mkdirSync(path.join(literalProject, '.git'), { recursive: true });
    expect(isWorktreePath(literalProject)).toBe(false);
  });

  it('returns false for a git submodule', () => {
    const superProject = path.join(tmpRoot, 'super');
    fs.mkdirSync(superProject, { recursive: true });
    const moduleDir = path.join(superProject, '.git', 'modules', 'lib');
    fs.mkdirSync(moduleDir, { recursive: true });
    const submodulePath = path.join(superProject, 'vendor', 'lib');
    fs.mkdirSync(submodulePath, { recursive: true });
    fs.writeFileSync(path.join(submodulePath, '.git'), `gitdir: ${moduleDir}\n`);
    expect(isWorktreePath(submodulePath)).toBe(false);
  });

  it('returns false for an unreadable / nonexistent path (fails closed)', () => {
    expect(isWorktreePath(path.join(tmpRoot, 'does-not-exist_worktrees', 'x'))).toBe(false);
  });

  it('handles empty and null-ish inputs gracefully', () => {
    expect(isWorktreePath('')).toBe(false);
    expect(isWorktreePath(null as unknown as string)).toBe(false);
    expect(isWorktreePath(undefined as unknown as string)).toBe(false);
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
    createLinkedWorktree(projectPath, cwd, 'proud-gorge');
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(cwd);
    expect(dirs.sort()).toEqual([
      fs.realpathSync.native(projectPath),
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

  it('excludes sibling worktrees when includeSiblingWorktrees is false (project root)', () => {
    // The Claude Code loader opts out: the CLI discovers .claude/commands
    // skills in every additional directory, so N sibling worktrees inflate the
    // system prompt with N duplicate copies of every project skill.
    fs.mkdirSync(worktreesDir);
    fs.mkdirSync(path.join(worktreesDir, 'proud-gorge'));
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(projectPath, {
      includeSiblingWorktrees: false,
    });
    expect(dirs).toEqual([]);
  });

  it('keeps the parent project but drops siblings when includeSiblingWorktrees is false (worktree)', () => {
    fs.mkdirSync(worktreesDir);
    const cwd = path.join(worktreesDir, 'proud-gorge');
    createLinkedWorktree(projectPath, cwd, 'proud-gorge');
    fs.mkdirSync(path.join(worktreesDir, 'swift-falcon'));

    const dirs = getAdditionalDirectoriesForWorkspace(cwd, {
      includeSiblingWorktrees: false,
    });
    // Parent project access (shared configs, .git common dir) must survive.
    expect(dirs).toEqual([fs.realpathSync.native(projectPath)]);
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

  describe('stopAt boundary', () => {
    it('still returns a match found at or below the boundary', () => {
      // boundary === the matching ancestor: it is tested, then the walk stops.
      expect(findNearestAncestor('/path/to/project/src', pred, '/path/to/project'))
        .toBe('/path/to/project');
    });

    it('does NOT climb past the boundary to a higher match', () => {
      // A trusted grandparent must not be inherited when a nearer boundary caps
      // the walk - this is the trust-boundary guard for nested projects.
      const t = new Set(['/root']);
      const p = (d: string) => t.has(d);
      expect(findNearestAncestor('/root/child/leaf', p, '/root/child')).toBe(null);
    });

    it('returns the nearer match even when a farther one also matches', () => {
      const t = new Set(['/root', '/root/child']);
      const p = (d: string) => t.has(d);
      expect(findNearestAncestor('/root/child/leaf', p, '/root/child')).toBe('/root/child');
    });
  });
});

describe('findProjectRoot', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-projroot-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // findProjectRoot returns the normalized INPUT path (it does not resolve
  // symlinks), so compare against the input, not realpathSync.
  it('returns the start path when it is itself a git repo root', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
  });

  it('walks up to the nearest git repo root from a subfolder', () => {
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    const sub = path.join(tmpRoot, 'packages', 'electron');
    fs.mkdirSync(sub, { recursive: true });
    expect(findProjectRoot(sub)).toBe(tmpRoot);
  });

  it('stops at a nested repo root rather than the outer repo (fresh-clone case)', () => {
    // Outer repo contains an independent nested repo with its own .git.
    fs.mkdirSync(path.join(tmpRoot, '.git'));
    const nested = path.join(tmpRoot, 'vendored-clone');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    expect(findProjectRoot(nested)).toBe(nested);
  });

  it('recognizes a .git file (linked worktree) as a repo root', () => {
    fs.writeFileSync(path.join(tmpRoot, '.git'), 'gitdir: /somewhere/else');
    expect(findProjectRoot(tmpRoot)).toBe(tmpRoot);
  });

  it('returns null when no ancestor is a git repo', () => {
    const sub = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(sub, { recursive: true });
    // tmpRoot lives under the OS temp dir; none of it should be a git repo.
    expect(findProjectRoot(sub)).toBe(null);
  });
});
