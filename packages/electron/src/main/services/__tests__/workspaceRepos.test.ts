// @vitest-environment node
/**
 * Repo resolution is the load-bearing piece of multi-repo git: a file
 * attributed to the wrong repo means status badges from another checkout, and
 * a commit staged in the wrong place. These cases run against a real on-disk
 * fixture because the resolution is entirely `existsSync` walking.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const rootsByWorkspace = new Map<string, string[]>();
vi.mock('../../utils/store', () => ({
  getWorkspaceRoots: (workspacePath: string) => rootsByWorkspace.get(workspacePath) ?? [workspacePath],
}));

import {
  clearWorkspaceRepoCache,
  groupFilesByRepo,
  groupFilesByRoot,
  listRepoScanPaths,
  listWorkspaceRepos,
  resolveDefaultRepo,
  resolveRepoForFile,
} from '../workspaceRepos';
import { __resetGitRootCache } from '../GitStatusService';
import { FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../testSupport/gitTestSandbox';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitSandboxEnv() });
}

let tmpRoot: string;
let appRepo: string;
let infraContainer: string;
let infraRepoA: string;
let plainFolder: string;

function mkRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
}

describe('workspace repos', () => {
  beforeEach(() => {
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-repos-')));
    appRepo = path.join(tmpRoot, 'app');
    infraContainer = path.join(tmpRoot, 'infra');
    infraRepoA = path.join(infraContainer, 'terraform');
    plainFolder = path.join(tmpRoot, 'docs');

    mkRepo(appRepo);
    fs.mkdirSync(path.join(appRepo, 'src'), { recursive: true });
    fs.mkdirSync(infraContainer, { recursive: true });
    mkRepo(infraRepoA);
    fs.mkdirSync(plainFolder, { recursive: true });

    rootsByWorkspace.clear();
    clearWorkspaceRepoCache();
    __resetGitRootCache();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('lists a root that is itself a repo, and repos one level inside a container root', async () => {
    rootsByWorkspace.set(appRepo, [appRepo, infraContainer]);

    expect(await listWorkspaceRepos(appRepo)).toEqual([appRepo, infraRepoA]);
  });

  it('reports no repos for a workspace of plain folders', async () => {
    // Callers must handle this rather than indexing [0] -- a workspace with no
    // git at all is valid, and the picker says "(not a git repo)".
    rootsByWorkspace.set(plainFolder, [plainFolder]);

    expect(await listWorkspaceRepos(plainFolder)).toEqual([]);
    expect(await resolveDefaultRepo(plainFolder)).toBeNull();
  });

  it('does not list a submodule as a top-level repo', async () => {
    // A repo root answers with itself; its nested repos are reached per file.
    // Listing them here would fill the repo picker with submodules.
    mkRepo(path.join(appRepo, 'vendor', 'lib'));
    rootsByWorkspace.set(appRepo, [appRepo]);

    expect(await listWorkspaceRepos(appRepo)).toEqual([appRepo]);
  });

  it('lists the clones a repo root ignores, not ignored folders or its own linked worktrees', async () => {
    // An umbrella repo whose separate clones sit inside it, each gitignored so
    // the umbrella's history stays its own.
    const umbrella = path.join(tmpRoot, 'umbrella');
    const clone = path.join(umbrella, 'service-a');
    fs.mkdirSync(umbrella);
    git(['init', '-q'], umbrella);
    fs.writeFileSync(path.join(umbrella, '.gitignore'), '/service-a/\n/build/\n/.claude/\n');
    git(['add', '.'], umbrella);
    git([...FIXTURE_IDENTITY_ARGS, 'commit', '-q', '-m', 'init'], umbrella);
    fs.mkdirSync(clone);
    git(['init', '-q'], clone);
    fs.mkdirSync(path.join(umbrella, 'build', 'out'), { recursive: true });
    git(['worktree', 'add', '-q', '-b', 'agent', path.join(umbrella, '.claude', 'worktrees', 'agent')], umbrella);
    rootsByWorkspace.set(umbrella, [umbrella]);

    expect(await listWorkspaceRepos(umbrella)).toEqual([umbrella, clone]);
    expect(await listRepoScanPaths(umbrella)).toEqual([umbrella, clone]);
    expect(await resolveDefaultRepo(umbrella)).toBe(umbrella);
  });

  it('attributes a file in an attached folder to that folder repo', () => {
    rootsByWorkspace.set(appRepo, [appRepo, infraContainer]);

    expect(resolveRepoForFile(appRepo, path.join(infraRepoA, 'main.tf'))).toBe(infraRepoA);
    expect(resolveRepoForFile(appRepo, path.join(appRepo, 'src', 'index.ts'))).toBe(appRepo);
  });

  it('resolves a nested repo from the file rather than from the root', () => {
    const submodule = path.join(appRepo, 'vendor', 'lib');
    mkRepo(submodule);
    rootsByWorkspace.set(appRepo, [appRepo]);

    expect(resolveRepoForFile(appRepo, path.join(submodule, 'a.ts'))).toBe(submodule);
  });

  it('returns null for a file in no repo', () => {
    rootsByWorkspace.set(appRepo, [appRepo, plainFolder]);

    expect(resolveRepoForFile(appRepo, path.join(plainFolder, 'notes.md'))).toBeNull();
  });

  it('groups a cross-repo file list by owning repo, keeping repo-less files visible', () => {
    // The commit-proposal split reads this: files with no repo must surface as
    // a group rather than disappear from the proposal.
    rootsByWorkspace.set(appRepo, [appRepo, infraContainer, plainFolder]);

    const groups = groupFilesByRepo(appRepo, [
      path.join(appRepo, 'src', 'index.ts'),
      path.join(infraRepoA, 'main.tf'),
      path.join(appRepo, 'src', 'other.ts'),
      path.join(plainFolder, 'notes.md'),
    ]);

    expect(groups.get(appRepo)).toEqual([
      path.join(appRepo, 'src', 'index.ts'),
      path.join(appRepo, 'src', 'other.ts'),
    ]);
    expect(groups.get(infraRepoA)).toEqual([path.join(infraRepoA, 'main.tf')]);
    expect(groups.get(null)).toEqual([path.join(plainFolder, 'notes.md')]);
  });

  it('groups files by owning ROOT, keeping unmatched paths with the primary root', () => {
    // `getFileStatus` bounds its repo walk to the path it is given, so asking
    // about the primary root alone leaves attached-folder files with no status.
    rootsByWorkspace.set(appRepo, [appRepo, infraContainer]);

    const groups = groupFilesByRoot(appRepo, [
      path.join(appRepo, 'src', 'index.ts'),
      path.join(infraRepoA, 'main.tf'),
      'relative/path.ts',
      '/somewhere/else.ts',
    ]);

    expect(groups.get(appRepo)).toEqual([
      path.join(appRepo, 'src', 'index.ts'),
      'relative/path.ts',
      '/somewhere/else.ts',
    ]);
    expect(groups.get(infraContainer)).toEqual([path.join(infraRepoA, 'main.tf')]);
  });

  it('keeps a single-root workspace on one group, unchanged from before multi-root', () => {
    rootsByWorkspace.set(appRepo, [appRepo]);

    const groups = groupFilesByRoot(appRepo, [path.join(appRepo, 'a.ts'), '/outside/b.ts']);

    expect([...groups.keys()]).toEqual([appRepo]);
  });

  it('includes repos below a container root in the workspace-wide scan set', async () => {
    // Workspace-wide status iterates this. Iterating ROOTS instead leaves an
    // attached container -- which is not itself a repo -- contributing nothing,
    // so its checkouts get no status badges even though the picker lists them.
    rootsByWorkspace.set(appRepo, [appRepo, infraContainer]);

    expect(await listRepoScanPaths(appRepo)).toEqual([appRepo, infraContainer, infraRepoA]);
  });

  it('attributes a Windows-form path to its attached root', () => {
    // Roots are stored with the platform's own separators, and containment used
    // to be a literal `/` prefix test -- which never matches on Windows, so
    // every attached-folder file resolved to no repo and became uncommittable.
    const winPrimary = 'C:\\work\\app';
    const winAttached = 'C:\\work\\infra';
    rootsByWorkspace.set(winPrimary, [winPrimary, winAttached]);

    const groups = groupFilesByRoot(winPrimary, [
      'C:\\work\\infra\\main.tf',
      'C:\\work\\app\\src\\index.ts',
    ]);

    expect(groups.get(winAttached)).toEqual(['C:\\work\\infra\\main.tf']);
    expect(groups.get(winPrimary)).toEqual(['C:\\work\\app\\src\\index.ts']);
  });
});
