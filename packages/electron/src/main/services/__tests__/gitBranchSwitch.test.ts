// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ConfirmTokenStore,
  createReadGit,
  listBranchesDetailed,
  switchBranch,
  switchPreflight,
  type BranchSwitchDeps,
} from '../gitBranchSwitch';
import { assertGitSandbox, FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../testSupport/gitTestSandbox';

/**
 * #1959. Real repos under os.tmpdir(): a bare remote with `main`, `feature/x`
 * and `fix/y`, a clone of it (`repo`), and a second worktree of the clone that
 * has `occupied` checked out.
 */
describe('gitBranchSwitch against real repositories', () => {
  let tmpDir: string;
  let remote: string;
  let repo: string;
  let worktree: string;
  let deps: BranchSwitchDeps;
  let lookupCalls: string[][];
  let clock: number;

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitSandboxEnv(tmpDir) });
  }

  function commitFile(cwd: string, file: string, content: string, message: string): void {
    assertGitSandbox(cwd, tmpDir);
    fs.writeFileSync(path.join(cwd, file), content);
    git(cwd, ['add', file]);
    git(cwd, [...FIXTURE_IDENTITY_ARGS, 'commit', '-q', '-m', message]);
  }

  function currentBranch(cwd: string): string {
    return git(cwd, ['branch', '--show-current']).trim();
  }

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-branch-switch-')));
    remote = path.join(tmpDir, 'remote.git');
    fs.mkdirSync(remote);
    git(remote, ['init', '-q', '--bare', '-b', 'main']);

    const seed = path.join(tmpDir, 'seed');
    fs.mkdirSync(seed);
    git(seed, ['init', '-q', '-b', 'main']);
    assertGitSandbox(seed, tmpDir);
    commitFile(seed, 'shared.txt', 'main\n', 'initial');
    git(seed, ['push', '-q', remote, 'main']);
    git(seed, ['checkout', '-q', '-b', 'feature/x']);
    commitFile(seed, 'feature.txt', 'x\n', 'feature');
    git(seed, ['push', '-q', remote, 'feature/x']);
    git(seed, ['checkout', '-q', 'main']);
    git(seed, ['checkout', '-q', '-b', 'fix/y']);
    commitFile(seed, 'shared.txt', 'fix\n', 'fix');
    git(seed, ['push', '-q', remote, 'fix/y']);

    repo = path.join(tmpDir, 'repo');
    git(tmpDir, ['clone', '-q', remote, repo]);
    assertGitSandbox(repo, tmpDir);
    git(repo, ['branch', '-q', '--track', 'feature/x', 'origin/feature/x']);
    worktree = path.join(tmpDir, 'wt');
    git(repo, ['worktree', 'add', '-q', '-b', 'occupied', worktree, 'main']);
    assertGitSandbox(worktree, tmpDir);

    const env = gitSandboxEnv(tmpDir);
    lookupCalls = [];
    clock = 1_000_000;
    deps = {
      confirmTokens: new ConfirmTokenStore({ now: () => clock }),
      readGit: createReadGit(() => env),
      runSwitch: (cwd, args) => new Promise((resolve) => {
        assertGitSandbox(cwd, tmpDir);
        execFile('git', args, { cwd, env }, (error, _stdout, stderr) => {
          resolve(error ? { success: false, error: String(stderr).trim() || error.message } : { success: true });
        });
      }),
      lookupWorktrees: async (paths) => {
        lookupCalls.push([...paths]);
        return paths.includes(worktree)
          ? [{ id: 'wt-1', name: 'wt', displayName: 'Fix the parser', path: worktree }]
          : [];
      },
      listRunningSessions: async () => [],
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore Windows file-lock noise during teardown
    }
  });

  it('reports a branch checked out in another worktree as occupied before any switch', async () => {
    const list = await listBranchesDetailed(repo, deps);
    const occupied = list.local.find(b => b.name === 'occupied');
    expect(occupied?.occupiedBy).toEqual({ path: worktree, worktreeId: 'wt-1', sessionTitle: 'Fix the parser' });
    expect(list.local.find(b => b.name === 'main')?.occupiedBy).toBeNull();

    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'occupied' }, deps);
    expect(preflight.blocked).toEqual({
      reason: 'occupied',
      occupiedBy: { path: worktree, worktreeId: 'wt-1', sessionTitle: 'Fix the parser' },
    });
    expect(currentBranch(repo)).toBe('main');
  });

  it('switching to remote-only origin/fix/y creates local fix/y tracking origin/fix/y', async () => {
    const list = await listBranchesDetailed(repo, deps);
    expect(list.remoteOnly.map(b => b.remoteRef)).toContain('origin/fix/y');
    // feature/x has a local branch, and origin/HEAD is a symref, so neither is remote-only.
    expect(list.remoteOnly.map(b => b.remoteRef)).not.toContain('origin/feature/x');
    expect(list.remoteOnly.map(b => b.remoteRef)).not.toContain('origin/HEAD');

    const result = await switchBranch(repo, { kind: 'remote', remoteRef: 'origin/fix/y' }, deps);
    expect(result).toEqual({ success: true, branch: 'fix/y' });
    expect(currentBranch(repo)).toBe('fix/y');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'fix/y@{upstream}']).trim()).toBe('origin/fix/y');
  });

  it('switches to a clean local branch and reports upstream and the current state', async () => {
    const before = await listBranchesDetailed(repo, deps);
    expect(before.current).toMatchObject({ branch: 'main', detached: false, headReachable: true });
    expect(before.local.find(b => b.name === 'feature/x')).toMatchObject({ upstream: 'origin/feature/x', ahead: 0, behind: 0 });

    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, deps))
      .resolves.toEqual({ success: true, branch: 'feature/x' });
    expect(currentBranch(repo)).toBe('feature/x');
  });

  it('carries non-conflicting uncommitted changes to the new branch', async () => {
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'draft\n');
    fs.appendFileSync(path.join(repo, 'shared.txt'), 'more\n');
    git(repo, ['add', 'notes.txt']);

    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, deps);
    expect(preflight.blocked).toBeNull();
    expect(preflight.dirtyFiles.sort()).toEqual(['notes.txt', 'shared.txt']);
    expect(preflight.needsConfirm).toBe(true);

    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, deps, preflight.confirmToken))
      .resolves.toMatchObject({ success: true });
    expect(currentBranch(repo)).toBe('feature/x');
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8')).toBe('draft\n');
    expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('main\nmore\n');
  });

  it('refuses a conflicting dirty switch without stashing or touching the working tree', async () => {
    git(repo, ['branch', '-q', '--track', 'fix/y', 'origin/fix/y']);
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'local edit\n');
    const stashBefore = git(repo, ['stash', 'list']);
    const statusBefore = git(repo, ['status', '--porcelain']);

    const { confirmToken } = await switchPreflight(repo, { kind: 'local', branch: 'fix/y' }, deps);
    const result = await switchBranch(repo, { kind: 'local', branch: 'fix/y' }, deps, confirmToken);
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/would be overwritten/);
    expect(currentBranch(repo)).toBe('main');
    expect(git(repo, ['stash', 'list'])).toBe(stashBefore);
    expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore);
    expect(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8')).toBe('local edit\n');
  });

  it('returns local-exists instead of tracking a remote whose short name is already a local branch', async () => {
    const result = await switchBranch(repo, { kind: 'remote', remoteRef: 'origin/feature/x' }, deps);
    expect(result).toMatchObject({ success: false, conflict: 'local-exists', branch: 'feature/x' });
    expect(currentBranch(repo)).toBe('main');
  });

  it('creates a branch with no upstream from a remote start point', async () => {
    await expect(switchBranch(repo, { kind: 'create', name: 'topic/new', startPoint: 'origin/fix/y' }, deps))
      .resolves.toEqual({ success: true, branch: 'topic/new' });
    expect(currentBranch(repo)).toBe('topic/new');
    expect(() => git(repo, ['rev-parse', '--abbrev-ref', 'topic/new@{upstream}'])).toThrow();
    expect(git(repo, ['rev-parse', 'topic/new']).trim()).toBe(git(repo, ['rev-parse', 'origin/fix/y']).trim());
  });

  it('rejects an invalid branch name before switching', async () => {
    const result = await switchBranch(repo, { kind: 'create', name: 'bad..name', startPoint: 'HEAD' }, deps);
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/not a valid branch name/) });
    expect(currentBranch(repo)).toBe('main');
    expect(git(repo, ['branch', '--list', 'bad*']).trim()).toBe('');
  });

  it('rejects leading-dash operands in every request kind', async () => {
    for (const request of [
      { kind: 'local', branch: '--orphan' },
      { kind: 'remote', remoteRef: '-origin/x' },
      { kind: 'create', name: '-b', startPoint: 'HEAD' },
      { kind: 'create', name: 'ok', startPoint: '--detach' },
    ] as const) {
      await expect(switchBranch(repo, request, deps)).rejects.toThrow(/must not start with a dash/);
    }
    expect(currentBranch(repo)).toBe('main');
  });

  it('reports a detached HEAD whose commit no ref contains', async () => {
    git(repo, ['checkout', '-q', '--detach']);
    commitFile(repo, 'orphan.txt', 'lost\n', 'unreferenced');
    const head = git(repo, ['rev-parse', 'HEAD']).trim();

    const list = await listBranchesDetailed(repo, deps);
    expect(list.current).toMatchObject({ branch: null, detached: true, headSha: head, headReachable: false });

    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, deps);
    expect(preflight.unreachableHead).toEqual({ sha: head });
    expect(preflight.needsConfirm).toBe(true);
  });

  it('refuses when the checkout itself is a Nimbalyst-managed worktree', async () => {
    const preflight = await switchPreflight(worktree, { kind: 'local', branch: 'feature/x' }, deps);
    expect(preflight.blocked).toEqual({ reason: 'managed-worktree', worktreeId: 'wt-1', name: 'Fix the parser' });
  });

  it('names running sessions in this checkout even on a clean tree', async () => {
    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, {
      ...deps,
      listRunningSessions: async () => [
        { id: 's1', title: 'Main checkout work', workspacePath: repo },
        { id: 's2', title: 'Elsewhere', workspacePath: path.join(tmpDir, 'other') },
        { id: 's3', title: 'In a worktree', workspacePath: repo, worktreeId: 'wt-1' },
      ],
    });
    expect(preflight.dirtyFiles).toEqual([]);
    expect(preflight.runningSessions).toEqual([{ id: 's1', title: 'Main checkout work' }]);
    expect(preflight.needsConfirm).toBe(true);
  });

  // ---- Review round 1 ----

  it('refuses to overwrite an ignored local file the target branch tracks', async () => {
    commitFile(repo, '.gitignore', 'build.log\n', 'ignore build.log');
    git(repo, ['checkout', '-q', '-b', 'with-log']);
    fs.writeFileSync(path.join(repo, 'build.log'), 'tracked\n');
    git(repo, ['add', '-f', 'build.log']);
    git(repo, [...FIXTURE_IDENTITY_ARGS, 'commit', '-q', '-m', 'track build.log']);
    git(repo, ['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(repo, 'build.log'), 'precious local log\n');

    const result = await switchBranch(repo, { kind: 'local', branch: 'with-log' }, deps);
    expect(result.success).toBe(false);
    expect(currentBranch(repo)).toBe('main');
    expect(fs.readFileSync(path.join(repo, 'build.log'), 'utf8')).toBe('precious local log\n');
  });

  it('asks again when a session starts after preflight', async () => {
    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, deps);
    expect(preflight.needsConfirm).toBe(false);

    const result = await switchBranch(repo, { kind: 'local', branch: 'feature/x' }, {
      ...deps,
      listRunningSessions: async () => [{ id: 's1', title: 'Late starter', workspacePath: repo }],
    }, preflight.confirmToken);
    expect(result).toMatchObject({ success: false, needsConfirm: { runningSessions: [{ id: 's1', title: 'Late starter' }] } });
    expect(currentBranch(repo)).toBe('main');
  });

  it('asks again when the tree became dirty after a clean preflight', async () => {
    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, deps);
    fs.writeFileSync(path.join(repo, 'late.txt'), 'new\n');

    const result = await switchBranch(repo, { kind: 'local', branch: 'feature/x' }, deps, preflight.confirmToken);
    expect(result).toMatchObject({ success: false, needsConfirm: { dirtyFiles: ['late.txt'] } });
    expect(currentBranch(repo)).toBe('main');

    // The fresh confirm's token is what lets the switch through.
    const fresh = result.success === false ? result.needsConfirm : undefined;
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, deps, fresh?.confirmToken))
      .resolves.toMatchObject({ success: true });
  });

  it('refuses a direct switch request on a Nimbalyst-managed worktree and on an occupied branch', async () => {
    await expect(switchBranch(worktree, { kind: 'local', branch: 'feature/x' }, deps))
      .resolves.toMatchObject({ success: false, blocked: { reason: 'managed-worktree' } });
    expect(currentBranch(worktree)).toBe('occupied');

    await expect(switchBranch(repo, { kind: 'local', branch: 'occupied' }, deps))
      .resolves.toMatchObject({ success: false, blocked: { reason: 'occupied' } });
    expect(currentBranch(repo)).toBe('main');
  });

  it('counts a session in a subfolder of the checkout but not one in a nested repository or a worktree', async () => {
    const sub = path.join(repo, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    const nested = path.join(repo, 'vendor', 'lib');
    fs.mkdirSync(nested, { recursive: true });
    git(nested, ['init', '-q', '-b', 'main']);

    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, {
      ...deps,
      listRunningSessions: async () => [
        { id: 'sub', title: 'Subfolder session', workspacePath: sub },
        { id: 'nested', title: 'Nested repo session', workspacePath: nested },
        { id: 'wt', title: 'Worktree session', workspacePath: sub, worktreeId: 'wt-1' },
      ],
    });
    expect(preflight.runningSessions).toEqual([{ id: 'sub', title: 'Subfolder session' }]);
  });

  it('refuses with "could not verify" when a safety lookup fails', async () => {
    const failingWorktrees = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, {
      ...deps,
      lookupWorktrees: async () => { throw new Error('database not ready'); },
    });
    expect(failingWorktrees.blocked).toMatchObject({ reason: 'unverified', message: expect.stringMatching(/could not verify/i) });

    const failingSessions = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, {
      ...deps,
      listRunningSessions: async () => { throw new Error('repository offline'); },
    });
    expect(failingSessions.blocked).toMatchObject({ reason: 'unverified', message: expect.stringMatching(/could not verify/i) });

    git(repo, ['checkout', '-q', '--detach']);
    const failingReachability = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, {
      ...deps,
      readGit: async (cwd, args) => args.includes('--contains')
        ? { ok: false, stdout: '', stderr: 'fatal: boom' }
        : deps.readGit(cwd, args),
    });
    expect(failingReachability.blocked).toMatchObject({ reason: 'unverified', message: expect.stringMatching(/could not verify/i) });
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, {
      ...deps,
      lookupWorktrees: async () => { throw new Error('database not ready'); },
    })).resolves.toMatchObject({ success: false, blocked: { reason: 'unverified' } });
  });

  it('resolves remotes whose names contain a slash', async () => {
    git(repo, ['remote', 'add', 'team/upstream', remote]);
    git(repo, ['fetch', '-q', 'team/upstream']);

    const list = await listBranchesDetailed(repo, deps);
    const fix = list.remoteOnly.find(b => b.remoteRef === 'team/upstream/fix/y');
    expect(fix).toEqual({ remoteRef: 'team/upstream/fix/y', remote: 'team/upstream', name: 'fix/y', lastCommitDate: expect.any(String) });
    expect(list.remoteOnly.map(b => b.remoteRef)).not.toContain('team/upstream/feature/x');

    const exists = await switchBranch(repo, { kind: 'remote', remoteRef: 'team/upstream/feature/x' }, deps);
    expect(exists).toMatchObject({ success: false, conflict: 'local-exists', branch: 'feature/x' });

    const preflight = await switchPreflight(repo, { kind: 'remote', remoteRef: 'team/upstream/fix/y' }, deps);
    expect(preflight.targetBranch).toBe('fix/y');
    await expect(switchBranch(repo, { kind: 'remote', remoteRef: 'team/upstream/fix/y' }, deps))
      .resolves.toEqual({ success: true, branch: 'fix/y' });
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'fix/y@{upstream}']).trim()).toBe('team/upstream/fix/y');
  });

  it('looks worktree records up in one batch per listing and per preflight', async () => {
    const third = path.join(tmpDir, 'wt3');
    git(repo, ['worktree', 'add', '-q', '-b', 'third', third, 'main']);

    await listBranchesDetailed(repo, deps);
    expect(lookupCalls).toHaveLength(1);
    expect([...lookupCalls[0]].sort()).toEqual([repo, third, worktree].sort());

    lookupCalls = [];
    await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, deps);
    expect(lookupCalls).toHaveLength(1);
  });

  // ---- Review round 2: opaque single-use confirm tokens ----

  const withSession = (): BranchSwitchDeps => ({
    ...deps,
    listRunningSessions: async () => [{ id: 's1', title: 'Main checkout work', workspacePath: repo }],
  });

  it('rejects a replayed confirm token after a switch and a switch back', async () => {
    const d = withSession();
    const first = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, d);
    expect(first.needsConfirm).toBe(true);
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, d, first.confirmToken))
      .resolves.toMatchObject({ success: true });

    const back = await switchPreflight(repo, { kind: 'local', branch: 'main' }, d);
    await expect(switchBranch(repo, { kind: 'local', branch: 'main' }, d, back.confirmToken))
      .resolves.toMatchObject({ success: true });
    expect(currentBranch(repo)).toBe('main');

    const replay = await switchBranch(repo, { kind: 'local', branch: 'feature/x' }, d, first.confirmToken);
    expect(replay).toMatchObject({ success: false, needsConfirm: { runningSessions: [{ id: 's1' }] } });
    expect(currentBranch(repo)).toBe('main');
  });

  it('consumes a token even when the state no longer matches', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, deps);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, deps, preflight.confirmToken))
      .resolves.toMatchObject({ success: false, needsConfirm: {} });

    fs.rmSync(path.join(repo, 'b.txt'));
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, deps, preflight.confirmToken))
      .resolves.toMatchObject({ success: false, needsConfirm: {} });
    expect(currentBranch(repo)).toBe('main');
  });

  it('rejects an expired token', async () => {
    const d = withSession();
    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, d);
    clock += 121_000;
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, d, preflight.confirmToken))
      .resolves.toMatchObject({ success: false, needsConfirm: {} });
    expect(currentBranch(repo)).toBe('main');
  });

  it('rejects a token confirmed at a different HEAD', async () => {
    const d = withSession();
    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, d);
    commitFile(repo, 'moved.txt', 'moved\n', 'HEAD moved after confirm');
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, d, preflight.confirmToken))
      .resolves.toMatchObject({ success: false, needsConfirm: {} });
    expect(currentBranch(repo)).toBe('main');
  });

  it('reads the checkout of a repository whose path contains a newline', async () => {
    const odd = path.join(tmpDir, 'line\nbreak');
    git(tmpDir, ['clone', '-q', remote, odd]);
    assertGitSandbox(odd, tmpDir);

    const list = await listBranchesDetailed(odd, deps);
    expect(list.current).toMatchObject({ branch: 'main', detached: false });
    expect(list.local.find(b => b.name === 'main')?.isCurrent).toBe(true);
  });

  it('spends a token even when a check throws, so it cannot be replayed after reads recover', async () => {
    const d = withSession();
    const preflight = await switchPreflight(repo, { kind: 'local', branch: 'feature/x' }, d);

    const failingStatus: BranchSwitchDeps = {
      ...d,
      readGit: async (cwd, args) => args[0] === 'status'
        ? { ok: false, stdout: '', stderr: 'fatal: index unreadable' }
        : d.readGit(cwd, args),
    };
    await expect(switchBranch(repo, { kind: 'local', branch: 'feature/x' }, failingStatus, preflight.confirmToken)).rejects.toThrow();

    const replay = await switchBranch(repo, { kind: 'local', branch: 'feature/x' }, d, preflight.confirmToken);
    expect(replay).toMatchObject({ success: false, needsConfirm: {} });
    expect(currentBranch(repo)).toBe('main');
  });
});

