// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGit } from '../gitClient';
import { resolveWorktreeBase, splitRemoteRef } from '../worktreeBaseBranch';
import { assertGitSandbox, FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../testSupport/gitTestSandbox';

/**
 * Real repos under os.tmpdir(): a bare "remote", a clone of it (which sets
 * origin/HEAD), and plain local repos for the no-remote cases.
 */
describe('resolveWorktreeBase', () => {
  let tmpDir: string;
  let remote: string;

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitSandboxEnv(tmpDir) });
  }

  function commit(cwd: string, message: string): void {
    assertGitSandbox(cwd, tmpDir);
    git(cwd, [...FIXTURE_IDENTITY_ARGS, 'commit', '--allow-empty', '-q', '-m', message]);
  }

  function localRepo(name: string, initialBranch: string): string {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    git(dir, ['init', '-q', '-b', initialBranch]);
    commit(dir, 'initial');
    return dir;
  }

  function clone(name: string): string {
    const dir = path.join(tmpDir, name);
    git(tmpDir, ['clone', '-q', remote, dir]);
    assertGitSandbox(dir, tmpDir);
    return dir;
  }

  const reader = (dir: string) => createGit(dir, {}, gitSandboxEnv(tmpDir, { pinConfigPaths: false }));

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-wt-base-')));
    remote = path.join(tmpDir, 'remote.git');
    fs.mkdirSync(remote);
    git(remote, ['init', '-q', '--bare', '-b', 'main']);
    const seed = localRepo('seed', 'main');
    git(seed, ['push', '-q', remote, 'main']);
    git(seed, ['push', '-q', remote, 'main:develop']);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file-lock noise during teardown
    }
  });

  it('uses origin/HEAD when the clone has it, whatever the checkout is on', async () => {
    const repo = clone('repo');
    git(repo, ['checkout', '-q', '-b', 'feature/x']);

    await expect(resolveWorktreeBase(reader(repo))).resolves.toMatchObject({ displayRef: 'origin/main', source: 'remote-default' });
  });

  it('falls back to origin/main when origin/HEAD is not set', async () => {
    const repo = clone('repo');
    git(repo, ['remote', 'set-head', 'origin', '--delete']);
    git(repo, ['checkout', '-q', '-b', 'feature/x']);

    await expect(resolveWorktreeBase(reader(repo))).resolves.toMatchObject({ displayRef: 'origin/main', source: 'remote-default' });
  });

  it('keeps the remote ref fully qualified when a local branch has the same name', async () => {
    const repo = clone('repo');
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
    commit(repo, 'feature work');
    git(repo, ['branch', 'origin/main', 'feature/x']);

    await expect(resolveWorktreeBase(reader(repo))).resolves.toMatchObject({
      ref: 'refs/remotes/origin/main',
      displayRef: 'origin/main',
      remote: { remote: 'origin', branch: 'main' },
    });
  });

  it('uses local main when origin/HEAD dangles and the remote has no main or master', async () => {
    const repo = clone('repo');
    git(repo, ['checkout', '-q', '-b', 'feature/x']);
    git(repo, ['update-ref', '-d', 'refs/remotes/origin/main']);
    git(repo, ['update-ref', '-d', 'refs/remotes/origin/develop']);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/deleted']);

    const resolved = await resolveWorktreeBase(reader(repo));
    expect(resolved.displayRef ?? resolved.ref).toBe('main');
    expect(resolved.source).toBe('fallback');
  });

  it('uses local main when there is no remote', async () => {
    const repo = localRepo('repo', 'main');
    git(repo, ['checkout', '-q', '-b', 'feature/x']);

    const resolved = await resolveWorktreeBase(reader(repo));
    expect(resolved.displayRef).toBe('main');
    expect(resolved.source).toBe('fallback');
    expect(resolved.fallbackReason).toContain('no remote');
  });

  it('uses the current branch when there is no remote and no main or master', async () => {
    const repo = localRepo('repo', 'trunk');

    const resolved = await resolveWorktreeBase(reader(repo));
    expect(resolved.displayRef).toBe('trunk');
    expect(resolved.source).toBe('fallback');
    expect(resolved.fallbackReason).toContain('current branch');
  });

  it('uses a configured ref that exists', async () => {
    const repo = clone('repo');

    await expect(resolveWorktreeBase(reader(repo), { mode: 'custom', ref: 'origin/develop' }))
      .resolves.toMatchObject({ ref: 'refs/remotes/origin/develop', displayRef: 'origin/develop', source: 'project-setting' });
  });

  it('falls back to the remote default with a reason when the configured ref is missing', async () => {
    const repo = clone('repo');

    const resolved = await resolveWorktreeBase(reader(repo), { mode: 'custom', ref: 'origin/release' });
    expect(resolved).toMatchObject({
      ref: 'refs/remotes/origin/main',
      displayRef: 'origin/main',
      source: 'fallback',
      fallbackReason: 'origin/release not found locally; using origin/main',
    });
  });

  it('uses the commit for a detached HEAD in current-branch mode', async () => {
    const repo = clone('repo');
    git(repo, ['checkout', '-q', '--detach']);
    const sha = git(repo, ['rev-parse', 'HEAD']).trim();

    await expect(resolveWorktreeBase(reader(repo), { mode: 'current-branch' }))
      .resolves.toMatchObject({ ref: sha, displayRef: sha, source: 'current-branch' });
  });

  it('resolves nothing for an unborn HEAD in current-branch mode', async () => {
    const repo = path.join(tmpDir, 'unborn');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);

    await expect(resolveWorktreeBase(reader(repo), { mode: 'current-branch' })).resolves.toMatchObject({ ref: '' });
  });
});

describe('splitRemoteRef', () => {
  let tmpDir: string;

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitSandboxEnv(tmpDir) });
  }

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-wt-split-')));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('splits a remote-tracking ref and leaves a local branch named like one alone', async () => {
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    assertGitSandbox(repo, tmpDir);
    git(repo, [...FIXTURE_IDENTITY_ARGS, 'commit', '--allow-empty', '-q', '-m', 'initial']);
    git(repo, ['remote', 'add', 'origin', path.join(tmpDir, 'nowhere.git')]);
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'main']);
    // A LOCAL branch literally named origin/foo.
    git(repo, ['branch', 'origin/foo']);
    const reader = createGit(repo, {}, gitSandboxEnv(tmpDir, { pinConfigPaths: false }));

    await expect(splitRemoteRef(reader, 'origin/main')).resolves.toEqual({ remote: 'origin', branch: 'main' });
    await expect(splitRemoteRef(reader, 'origin/foo')).resolves.toBeNull();
    await expect(splitRemoteRef(reader, 'main')).resolves.toBeNull();
  });
});
