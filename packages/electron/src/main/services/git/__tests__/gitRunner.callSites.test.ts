// @vitest-environment node
/**
 * The three call sites moved onto `runGit` (shell checkout baseline, git status,
 * untracked ls-files), run against real repositories with the runner up. Their
 * own test files cover their logic in process; these cover what changes when
 * the runner carries the call. Row ids are from the runner's pre-mortem.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setGitRunTransport } from '../runGit';
import { prepareShellCheckoutBaseline } from '../../ai/ShellCheckoutBaseline';
import { GitStatusService } from '../../GitStatusService';
import { getUntrackedFilesInDirectories } from '../../../utils/gitUtils';
import { assertGitSandbox, FIXTURE_IDENTITY_ARGS, gitSandboxEnv } from '../../testSupport/gitTestSandbox';
import { makeFakeGitDir, startHarnessRunner, type RecordedSpawn, type SpawnSide } from './gitRunnerHarness';

const { side, spawns } = vi.hoisted(() => ({
  side: { inRunner: false } as SpawnSide,
  spawns: [] as RecordedSpawn[],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((...args: unknown[]) => {
    if (typeof args[0] === 'string' && Array.isArray(args[1])) {
      const options = typeof args[2] === 'object' && args[2] ? { ...(args[2] as Record<string, unknown>) } : {};
      spawns.push({ file: args[0], args: [...(args[1] as string[])], options, inRunner: side.inRunner });
    }
    return (actual.execFile as (...a: unknown[]) => unknown)(...args);
  });
  return { ...actual, execFile };
});

const posix = process.platform !== 'win32';
const runnerSpawns = () => spawns.filter((s) => s.inRunner && s.file === 'git');
const mainSpawns = () => spawns.filter((s) => !s.inRunner && s.file === 'git');

let scratch = '';
let fakeDir = '';

function fixtureGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: gitSandboxEnv() });
}

function makeRepo(name: string, { commit }: { commit: boolean }): string {
  const repo = path.join(scratch, name);
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(['init', '-q'], repo);
  assertGitSandbox(repo);
  if (commit) {
    fs.writeFileSync(path.join(repo, 'tracked.md'), 'tracked\n');
    fixtureGit(['add', 'tracked.md'], repo);
    fixtureGit([...FIXTURE_IDENTITY_ARGS, 'commit', '-q', '-m', 'init'], repo);
  }
  return repo;
}

/** The call sites pass no env, so git sees main's process.env: sandbox it. */
function sandboxProcessEnv(): void {
  const sandbox = gitSandboxEnv();
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_') && !(key in sandbox)) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(sandbox)) if (key.startsWith('GIT_')) vi.stubEnv(key, value);
}

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-git-runner-sites-')));
  if (posix) {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fakeDir = makeFakeGitDir(realGit);
  }
});

afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }); });

beforeEach(() => { sandboxProcessEnv(); });

afterEach(() => {
  setGitRunTransport(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  spawns.length = 0;
});

describe.skipIf(!posix)('migrated call sites through the runner', () => {
  it('PM-2: an unborn repository still gets a shell baseline through the runner (exit code 1 stays a number)', async () => {
    const repo = makeRepo('unborn', { commit: false });
    const h = startHarnessRunner(side);
    await h.up();
    spawns.length = 0;
    const baseline = await prepareShellCheckoutBaseline(repo);
    expect(baseline).toBeDefined();
    expect(await baseline!.defer(path.join(repo, 'new-file.md'))).toBe(true);
    expect(runnerSpawns().map((s) => s.args.slice(2, 4))).toContainEqual(['rev-parse', '--verify']);
    expect(mainSpawns()).toHaveLength(0);
    h.runner.stop();
  });

  it('PM-3 (Q4): a non-git workspace returns no baseline, through the runner, with nothing logged', async () => {
    const workspace = path.join(scratch, 'not-a-repo');
    fs.mkdirSync(workspace, { recursive: true });
    const h = startHarnessRunner(side);
    await h.up();
    spawns.length = 0;
    const lines = h.log.info.mock.calls.length + h.log.warn.mock.calls.length;
    const consoleError = vi.spyOn(console, 'error');
    const consoleWarn = vi.spyOn(console, 'warn');
    await expect(prepareShellCheckoutBaseline(workspace)).resolves.toBeUndefined();
    expect(runnerSpawns()).toHaveLength(1);
    expect(mainSpawns()).toHaveLength(0);
    expect(h.log.info.mock.calls.length + h.log.warn.mock.calls.length).toBe(lines);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    h.runner.stop();
  });

  it('PM-4: a git that outlasts the attempt is killed by the runner, retried once inside the shared deadline, and main\'s backstop does not fire first', async () => {
    const repo = makeRepo('slow', { commit: true });
    vi.stubEnv('PATH', `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('FAKE_GIT_HANG_ON', 'worktree');
    const h = startHarnessRunner(side);
    await h.up();
    spawns.length = 0;
    const started = performance.now();
    await expect(prepareShellCheckoutBaseline(repo)).rejects.toThrow(/^git worktree timed out \(2 attempts\): Command failed: git -C /);
    expect(performance.now() - started).toBeLessThan(1250 + 1000);
    const timeouts = runnerSpawns().map((s) => s.options.timeout as number);
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toBe(625);
    expect(timeouts[1]).toBeGreaterThan(400);
    expect(timeouts[1]).toBeLessThanOrEqual(625);
    expect(mainSpawns()).toHaveLength(0);
    h.runner.stop();
  });

  it('PM-5: an untracked expansion without a timeout gets no main deadline and resolves after a slow git', async () => {
    const repo = makeRepo('untracked', { commit: true });
    fs.mkdirSync(path.join(repo, 'newdir', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'newdir', 'a.md'), 'a\n');
    fs.writeFileSync(path.join(repo, 'newdir', 'deep', 'b.md'), 'b\n');
    vi.stubEnv('PATH', `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('FAKE_GIT_DELAY', '0.5');
    const h = startHarnessRunner(side, { timing: { deadlineMarginMs: 100 } });
    await h.up();
    spawns.length = 0;
    const result = await getUntrackedFilesInDirectories(repo, [path.join(repo, 'newdir')]);
    expect(result.get(path.join(repo, 'newdir'))?.sort()).toEqual(['newdir/a.md', 'newdir/deep/b.md']);
    expect(runnerSpawns()).toHaveLength(1);
    expect('timeout' in runnerSpawns()[0].options).toBe(false);
    expect(runnerSpawns()[0].options.maxBuffer).toBe(64 * 1024 * 1024);
    expect(mainSpawns()).toHaveLength(0);
    h.runner.stop();
  });

  it('PM-14 (Q1): the first shell baseline while the runner is still starting runs in process and is captured in time', async () => {
    const repo = makeRepo('first-command', { commit: true });
    const h = startHarnessRunner(side, { behaviours: [{ readyDelayMs: 1500 }] });
    const started = performance.now();
    const baseline = await prepareShellCheckoutBaseline(repo);
    expect(baseline).toBeDefined();
    expect(performance.now() - started).toBeLessThan(1250);
    expect(h.runner.supervisor.state).toBe('starting');
    expect(mainSpawns().length).toBeGreaterThanOrEqual(5);
    expect(runnerSpawns()).toHaveLength(0);
    h.runner.stop();
  });

  it('PM-22 (unit part): with the runner up, a shell baseline, a status refresh with a collapsed directory and its expansion start no git from main', async () => {
    const repo = makeRepo('no-main-spawns', { commit: true });
    fs.writeFileSync(path.join(repo, 'tracked.md'), 'changed\n');
    fs.mkdirSync(path.join(repo, 'collapsed'));
    fs.writeFileSync(path.join(repo, 'collapsed', 'inside.md'), 'new\n');
    const h = startHarnessRunner(side);
    await h.up();
    spawns.length = 0;
    expect(await prepareShellCheckoutBaseline(repo)).toBeDefined();
    const service = new GitStatusService();
    const uncommitted = await service.getUncommittedFiles(repo);
    expect(uncommitted.map((f) => path.relative(repo, path.resolve(repo, f)).split(path.sep).join('/')).sort())
      .toEqual(['collapsed/inside.md', 'tracked.md']);
    const subcommands = runnerSpawns().map((s) => s.args.find((a) => !a.startsWith('-') && a !== repo));
    expect(subcommands).toEqual(expect.arrayContaining(['worktree', 'rev-parse', 'diff', 'ls-files', 'status']));
    expect(mainSpawns()).toEqual([]);
    h.runner.stop();
  });
});
