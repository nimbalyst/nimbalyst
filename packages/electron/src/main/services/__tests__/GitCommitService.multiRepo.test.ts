/**
 * Cross-repo commit splitting, against real git repositories.
 *
 * Git has no cross-repository commit, so a proposal spanning two roots either
 * splits or silently commits only part of what the user approved. These cases
 * pin the split, and pin that the single-repo path -- every ordinary commit --
 * is untouched.
 */
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScratchRepo, gitSandboxEnv } from '../testSupport/gitTestSandbox';

const execFileAsync = promisify(execFile);
const testTempRoot = process.env.NIMBALYST_TEST_TEMP_DIR ?? os.tmpdir();

const rootsByWorkspace = new Map<string, string[]>();
vi.mock('../../utils/store', () => ({
  getWorkspaceRoots: (workspacePath: string) => rootsByWorkspace.get(workspacePath) ?? [workspacePath],
}));

const { executeGitCommitAcrossRepos, createGitCommitProposalResponse } = await import('../GitCommitService');
const { clearWorkspaceRepoCache } = await import('../workspaceRepos');
const { __resetGitRootCache } = await import('../GitStatusService');

let tmpRoot: string;
let appRepo: string;
let infraRepo: string;
let plainFolder: string;

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd, env: gitSandboxEnv(testTempRoot) });
}

async function gitOutput(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: gitSandboxEnv(testTempRoot) });
  return stdout;
}

beforeEach(async () => {
  await fs.mkdir(testTempRoot, { recursive: true });
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(testTempRoot, 'nim-git-multirepo-')));
  appRepo = path.join(tmpRoot, 'app');
  infraRepo = path.join(tmpRoot, 'infra');
  plainFolder = path.join(tmpRoot, 'docs');

  // The fixture needs each folder to exist before it runs `git init` there.
  await fs.mkdir(appRepo, { recursive: true });
  await fs.mkdir(infraRepo, { recursive: true });
  await fs.mkdir(plainFolder, { recursive: true });
  createScratchRepo({ at: appRepo });
  createScratchRepo({ at: infraRepo });

  rootsByWorkspace.clear();
  clearWorkspaceRepoCache();
  __resetGitRootCache();
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('executeGitCommitAcrossRepos', () => {
  it('commits into the resolved repo when every file is in one repository', async () => {
    rootsByWorkspace.set(appRepo, [appRepo, infraRepo]);
    await fs.writeFile(path.join(appRepo, 'a.txt'), 'one\n', 'utf8');

    const result = await executeGitCommitAcrossRepos(appRepo, 'feat: one repo', ['a.txt']);

    expect(result.success).toBe(true);
    // Single-repo commits keep the flat shape older callers read.
    expect(result.repoResults).toBeUndefined();
    expect(await gitOutput(['log', '--oneline'], appRepo)).toContain('feat: one repo');
    expect(await gitOutput(['log', '--oneline'], infraRepo).catch(() => '')).not.toContain('feat: one repo');
  });

  it('splits a proposal spanning two repos into one commit each', async () => {
    rootsByWorkspace.set(appRepo, [appRepo, infraRepo]);
    await fs.writeFile(path.join(appRepo, 'a.txt'), 'one\n', 'utf8');
    await fs.writeFile(path.join(infraRepo, 'main.tf'), 'two\n', 'utf8');

    const result = await executeGitCommitAcrossRepos(appRepo, 'feat: spans repos', [
      path.join(appRepo, 'a.txt'),
      path.join(infraRepo, 'main.tf'),
    ]);

    expect(result.success).toBe(true);
    expect(result.repoResults?.map((entry) => entry.repoPath)).toEqual([appRepo, infraRepo]);
    expect(await gitOutput(['log', '--oneline'], appRepo)).toContain('feat: spans repos');
    expect(await gitOutput(['log', '--oneline'], infraRepo)).toContain('feat: spans repos');
    // Each repo committed only its own file.
    expect(await gitOutput(['show', '--name-only', '--format=', 'HEAD'], appRepo)).toContain('a.txt');
    expect(await gitOutput(['show', '--name-only', '--format=', 'HEAD'], infraRepo)).toContain('main.tf');
  });

  it('reports files that belong to no repository instead of dropping them', async () => {
    rootsByWorkspace.set(appRepo, [appRepo, plainFolder]);
    await fs.writeFile(path.join(appRepo, 'a.txt'), 'one\n', 'utf8');
    await fs.writeFile(path.join(plainFolder, 'notes.md'), 'loose\n', 'utf8');

    const result = await executeGitCommitAcrossRepos(appRepo, 'feat: partly loose', [
      path.join(appRepo, 'a.txt'),
      path.join(plainFolder, 'notes.md'),
    ]);

    expect(result.success).toBe(true);
    expect(result.uncommittableFiles).toEqual([path.join(plainFolder, 'notes.md')]);
    // The proposal response is built from this: a file that landed nowhere must
    // not be reported back to the user as committed.
    expect(result.committedFiles).toEqual([path.join(appRepo, 'a.txt')]);

    const response = createGitCommitProposalResponse(
      result,
      [path.join(appRepo, 'a.txt'), path.join(plainFolder, 'notes.md')],
      'feat: partly loose',
    );
    expect(response.action).toBe('committed');
    expect(response.filesCommitted).toEqual([path.join(appRepo, 'a.txt')]);
    expect(response.uncommittableFiles).toEqual([path.join(plainFolder, 'notes.md')]);
  });

  it('reports committed files in the caller own path strings', async () => {
    // The panel selects by whatever strings it holds and clears exactly those.
    // Resolution makes paths absolute internally, so the answer has to come
    // back in the caller's terms or nothing matches and the whole selection is
    // cleared after a partial commit.
    rootsByWorkspace.set(appRepo, [appRepo]);
    await fs.writeFile(path.join(appRepo, 'a.txt'), 'one\n', 'utf8');

    const result = await executeGitCommitAcrossRepos(appRepo, 'feat: relative', ['a.txt']);

    expect(result.success).toBe(true);
    expect(result.committedFiles).toEqual(['a.txt']);
  });

  it('fails clearly when no selected file is in a repository', async () => {
    rootsByWorkspace.set(plainFolder, [plainFolder]);
    await fs.writeFile(path.join(plainFolder, 'notes.md'), 'loose\n', 'utf8');

    const result = await executeGitCommitAcrossRepos(plainFolder, 'feat: nothing', [
      path.join(plainFolder, 'notes.md'),
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toContain('git repository');
    expect(result.uncommittableFiles).toEqual([path.join(plainFolder, 'notes.md')]);
  });

  it('honours an explicit repoPath without resolving', async () => {
    rootsByWorkspace.set(appRepo, [appRepo, infraRepo]);
    await fs.writeFile(path.join(infraRepo, 'main.tf'), 'two\n', 'utf8');

    const result = await executeGitCommitAcrossRepos(appRepo, 'feat: explicit repo', ['main.tf'], {
      repoPath: infraRepo,
    });

    expect(result.success).toBe(true);
    expect(await gitOutput(['log', '--oneline'], infraRepo)).toContain('feat: explicit repo');
  });

  it('reports every repo hash on success, not just the first', async () => {
    // Without this the user approves one card, two commits land, and the UI can
    // only ever show one hash -- the second commit is invisible.
    rootsByWorkspace.set(appRepo, [appRepo, infraRepo]);
    await fs.writeFile(path.join(appRepo, 'a.txt'), 'one\n', 'utf8');
    await fs.writeFile(path.join(infraRepo, 'main.tf'), 'two\n', 'utf8');
    const files = [path.join(appRepo, 'a.txt'), path.join(infraRepo, 'main.tf')];

    const result = await executeGitCommitAcrossRepos(appRepo, 'feat: two hashes', files);
    const response = createGitCommitProposalResponse(result, files, 'feat: two hashes');

    expect(response.action).toBe('committed');
    expect(response.repoResults?.map((entry) => entry.repoPath)).toEqual([appRepo, infraRepo]);
    expect(response.repoResults?.every((entry) => entry.success && entry.commitHash)).toBe(true);
    // Two distinct commits, not the same hash echoed twice.
    const hashes = new Set(response.repoResults?.map((entry) => entry.commitHash));
    expect(hashes.size).toBe(2);
  });

  it('commits into an attached folder when the workspace path is a worktree', async () => {
    // A worktree session passes the WORKTREE path, but attached folders are
    // stored under the parent workspace key. Without extraRoots the infra file
    // resolves to no repo, is dropped into uncommittableFiles, and never lands.
    const worktree = path.join(tmpRoot, 'app-worktree');
    await fs.mkdir(worktree, { recursive: true });
    createScratchRepo({ at: worktree });
    rootsByWorkspace.set(worktree, [worktree]);
    await fs.writeFile(path.join(worktree, 'a.txt'), 'one\n', 'utf8');
    await fs.writeFile(path.join(infraRepo, 'main.tf'), 'two\n', 'utf8');
    const files = [path.join(worktree, 'a.txt'), path.join(infraRepo, 'main.tf')];

    const dropped = await executeGitCommitAcrossRepos(worktree, 'feat: no extra roots', files);
    expect(dropped.uncommittableFiles).toEqual([path.join(infraRepo, 'main.tf')]);

    // That call committed the worktree file and dropped the infra one, so
    // re-dirty the worktree side before asserting the fixed behaviour.
    await fs.writeFile(path.join(worktree, 'a.txt'), 'one again\n', 'utf8');

    const result = await executeGitCommitAcrossRepos(worktree, 'feat: with extra roots', files, {
      extraRoots: [infraRepo],
    });

    expect(result.success).toBe(true);
    expect(result.uncommittableFiles).toBeUndefined();
    expect(await gitOutput(['log', '--oneline'], infraRepo)).toContain('feat: with extra roots');
  });
});
