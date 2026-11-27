// @vitest-environment node
/**
 * The git runner end to end in one process: `runGit` -> client -> supervisor ->
 * a harness port that structuredClones every message -> the real runner module
 * -> real `execFile` and real (or fake) git. Row ids are from the pre-mortem of
 * the change that added the runner.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { runGit, runGitInProcess, setGitRunTransport } from '../runGit';
import { GIT_RUNNER_PROTOCOL_VERSION, type GitRunOptions } from '../gitRunnerProtocol';
import type { SupervisedChild } from '../../../utilityProcess/UtilityProcessSupervisor';
import { gitSandboxEnv } from '../../testSupport/gitTestSandbox';
import {
  errorShape, flushPorts, makeFakeGitDir, startHarnessRunner, until,
  type RecordedSpawn, type SpawnSide,
} from './gitRunnerHarness';

const { side, spawns } = vi.hoisted(() => ({
  side: { inRunner: false } as SpawnSide,
  spawns: [] as RecordedSpawn[],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((file: string, args: string[], options: Record<string, unknown>, callback: unknown) => {
    spawns.push({ file, args: [...args], options: { ...options }, inRunner: side.inRunner });
    return (actual.execFile as (...a: unknown[]) => unknown)(file, args, options, callback);
  });
  return { ...actual, execFile };
});

const posix = process.platform !== 'win32';
/** Small supervisor timings so lifecycle tests run in real time. */
const FAST = {
  respawnBackoffMs: [20, 20, 20, 20, 20],
  readyTimeoutMs: 200,
  coolOffMs: 300,
};

let realGit = 'git';
let fakeDir = '';
let fakeEnv: NodeJS.ProcessEnv = {};
let scratch = '';

beforeAll(() => {
  if (posix) {
    realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    fakeDir = makeFakeGitDir(realGit);
  }
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nim-git-runner-')));
  fakeEnv = { ...gitSandboxEnv(), PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}` };
});

afterEach(() => {
  setGitRunTransport(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  spawns.length = 0;
});

/** Callback-style `execFile`, plus the stdout/stderr the promisified form adds. */
async function rawExecFile(args: string[], options: GitRunOptions): Promise<unknown> {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return new Promise((resolve) => {
    actual.execFile('git', args, { windowsHide: true, encoding: 'utf8', ...options }, (error, stdout, stderr) => {
      resolve(error ? Object.assign(error, { stdout, stderr }) : { stdout, stderr });
    });
  });
}

function settleOf<T>(promise: Promise<T>) {
  const state = { count: 0, value: undefined as T | undefined, error: undefined as unknown };
  const done = promise.then(
    (value) => { state.count++; state.value = value; },
    (error) => { state.count++; state.error = error; },
  );
  return { state, done };
}

const runnerSpawns = () => spawns.filter((s) => s.inRunner);
const mainSpawns = () => spawns.filter((s) => !s.inRunner);

describe.skipIf(!posix)('git runner protocol (harness)', () => {
  describe('PM-1: error shapes match callback execFile on both paths', () => {
    const cases: Array<[string, () => [string[], GitRunOptions]]> = [
      ['(a) unborn repo, rev-parse exits 1', () => {
        const repo = fs.mkdtempSync(path.join(scratch, 'unborn-'));
        execFileSync('git', ['init', '-q'], { cwd: repo, env: gitSandboxEnv() });
        return [['-C', repo, 'rev-parse', '--verify', '--quiet', 'HEAD'], { env: gitSandboxEnv() }];
      }],
      ['(b) -C a missing directory exits 128', () => [['-C', path.join(scratch, 'missing'), 'status'], { env: gitSandboxEnv() }]],
      ['(c) missing cwd is a spawn ENOENT', () => [['status', '--porcelain'], { cwd: path.join(scratch, 'missing-cwd') }]],
      ['(d) no git on PATH is a spawn ENOENT', () => [['--version'], { env: { PATH: fs.mkdtempSync(path.join(scratch, 'empty-')) } }]],
      ['(e) timeout kill', () => [['sleep', '3'], { env: fakeEnv, timeout: 200 }]],
      ['(f) maxBuffer overflow', () => [['bytes', '300000'], { env: fakeEnv, maxBuffer: 100_000 }]],
    ];

    it.each(cases)('%s', async (_label, make) => {
      const [args, options] = make();
      const expected = await rawExecFile(args, options);
      expect(expected).toBeInstanceOf(Error);
      const inProcess = await runGitInProcess(args, options).catch((e: unknown) => e);
      const h = startHarnessRunner(side);
      await h.up();
      spawns.length = 0;
      const viaRunner = await runGit(args, options).catch((e: unknown) => e);
      expect(runnerSpawns()).toHaveLength(1);
      expect(mainSpawns()).toHaveLength(0);
      expect(errorShape(inProcess)).toEqual(errorShape(expected));
      expect(errorShape(viaRunner)).toEqual(errorShape(expected));
      expect(viaRunner).toBeInstanceOf(Error);
      expect(viaRunner instanceof RangeError).toBe(expected instanceof RangeError);
      expect(typeof (viaRunner as { stdout: unknown }).stdout).toBe('string');
      expect(typeof (viaRunner as { stderr: unknown }).stderr).toBe('string');
      h.runner.stop();
    });

    it('(f) keeps exactly maxBuffer bytes of stdout and is not a kill by SIGTERM', async () => {
      const h = startHarnessRunner(side);
      await h.up();
      const error = await runGit(['bytes', '300000'], { env: fakeEnv, maxBuffer: 100_000 }).catch((e: unknown) => e) as Record<string, unknown>;
      expect(error).toBeInstanceOf(RangeError);
      expect(error.stdout).toBe('a'.repeat(100_000));
      expect(error.code).toBe('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      expect('killed' in error).toBe(false);
      expect('signal' in error).toBe(false);
      h.runner.stop();
    });
  });

  it('PM-6 (optional row): an omitted or undefined maxBuffer keeps Node\'s 1 MiB default on both paths', async () => {
    const args = ['bytes', String(1024 * 1024 + 1)];
    const inProcess = await runGitInProcess(args, { env: fakeEnv }).catch((e: unknown) => e);
    const h = startHarnessRunner(side);
    await h.up();
    const viaRunner = await runGit(args, { env: fakeEnv }).catch((e: unknown) => e);
    expect(inProcess).toBeInstanceOf(RangeError);
    expect(errorShape(viaRunner)).toEqual(errorShape(inProcess));
    // execFile itself treats an explicit `maxBuffer: undefined` as no limit;
    // runGit sends absent keys, so the default holds on both paths.
    for (const viaPath of [runGitInProcess, runGit]) {
      expect(errorShape(await viaPath(args, { env: fakeEnv, maxBuffer: undefined }).catch((e: unknown) => e))).toEqual(errorShape(inProcess));
    }
    h.runner.stop();
  });

  it('PM-7: main rejects at timeout plus margin with the timeout shape, then drops the late reply', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = startHarnessRunner(side);
    const child = await h.up();
    child.pauseUp();
    const { state, done } = settleOf(runGit(['sleep-print', '0', 'late'], { env: fakeEnv, timeout: 5000 }));
    await until(() => child.heldCount === 1, 'the runner reply');
    vi.advanceTimersByTime(5000 + 2000 - 1);
    await flushPorts();
    expect(state.count).toBe(0);
    vi.advanceTimersByTime(1);
    await done;
    expect(errorShape(state.error)).toEqual({
      ctor: 'Error',
      props: {
        message: 'Command failed: git sleep-print 0 late\n', code: null, killed: true, signal: 'SIGTERM',
        cmd: 'git sleep-print 0 late', stdout: '', stderr: '',
      },
    });
    child.resumeUp();
    await flushPorts();
    expect(state.count).toBe(1);
    expect(h.runner.pendingCount()).toBe(0);
    h.runner.stop();
  });

  it('PM-7: a normal settle clears the deadline and the watchdog timers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = startHarnessRunner(side);
    await h.up();
    expect(vi.getTimerCount()).toBe(0);
    await expect(runGit(['sleep-print', '0', 'ok'], { env: fakeEnv, timeout: 5000 })).resolves.toEqual({ stdout: 'ok', stderr: '' });
    expect(vi.getTimerCount()).toBe(0);
    h.runner.stop();
  });

  it('PM-8: a deadline timer that fires late re-arms once, and rejects when it fires late again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = startHarnessRunner(side);
    const child = await h.up();
    child.pauseUp();
    const { state, done } = settleOf(runGit(['sleep-print', '0', 'x'], { env: fakeEnv, timeout: 5000 }));
    await until(() => child.heldCount === 1, 'the runner reply');
    // Main stalls for 3 s past the deadline: the timer fires 3 s late.
    vi.setSystemTime(Date.now() + 3000);
    vi.advanceTimersByTime(7000);
    await flushPorts();
    expect(state.count).toBe(0);
    // The re-armed timer fires late too: no second re-arm.
    vi.setSystemTime(Date.now() + 3000);
    vi.advanceTimersByTime(2000);
    await done;
    expect((state.error as { killed?: boolean }).killed).toBe(true);
    h.runner.stop();
  });

  it('PM-10: concurrent calls resolve with their own stdout, not in arrival order', async () => {
    const h = startHarnessRunner(side);
    await h.up();
    const [a, b] = await Promise.all([
      runGit(['sleep-print', '0.3', 'content of a.md'], { env: fakeEnv }),
      runGit(['sleep-print', '0.01', 'content of b.md'], { env: fakeEnv }),
    ]);
    expect(a.stdout).toBe('content of a.md');
    expect(b.stdout).toBe('content of b.md');
    expect(runnerSpawns()).toHaveLength(2);
    h.runner.stop();
  });

  it('PM-11: a replaced runner\'s late messages are dropped', async () => {
    const h = startHarnessRunner(side, { timing: FAST });
    const a = await h.up();
    const first = runGit(['sleep-print', '0.2', 'in process'], { env: fakeEnv });
    await until(() => a.runIds().length === 1 && runnerSpawns().length === 1, 'runner A to start git');
    const [firstId] = a.runIds();
    a.crash(1);
    const b = await h.up();
    expect(b).not.toBe(a);
    const second = runGit(['sleep-print', '0.2', 'from B'], { env: fakeEnv });
    await until(() => b.runIds().length === 1, 'runner B to get the call');
    const [secondId] = b.runIds();
    a.deliverLate({ type: 'result', id: firstId, stdout: 'STALE', stderr: '' });
    a.deliverLate({ type: 'result', id: secondId, stdout: 'STALE', stderr: '' });
    a.deliverLate({ type: 'ready', protocol: GIT_RUNNER_PROTOCOL_VERSION });
    expect((await first).stdout).toBe('in process');
    expect((await second).stdout).toBe('from B');
    h.runner.stop();
  });

  it('PM-12: calls in flight when the runner dies re-run in process within their remaining deadline', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = startHarnessRunner(side, { timing: FAST });
    const child = await h.up();
    const status = runGit(['sleep-print', '0.3', 'status'], { env: fakeEnv, timeout: 5000 });
    const lsFiles = runGit(['sleep-print', '0.3', 'ls-files'], { env: fakeEnv });
    const spent = settleOf(runGit(['sleep-print', '0.3', 'spent'], { env: fakeEnv, timeout: 1000 }));
    await until(() => runnerSpawns().length === 3, 'the runner to start all three');
    vi.setSystemTime(Date.now() + 1200);
    child.dieSilently();
    const posted = runGit(['sleep-print', '0.3', 'posted into the dead window'], { env: fakeEnv, timeout: 5000 });
    await flushPorts();
    child.crash(1);
    await expect(status).resolves.toEqual({ stdout: 'status', stderr: '' });
    await expect(lsFiles).resolves.toEqual({ stdout: 'ls-files', stderr: '' });
    await expect(posted).resolves.toEqual({ stdout: 'posted into the dead window', stderr: '' });
    await spent.done;
    expect(errorShape(spent.state.error).props).toMatchObject({ code: null, killed: true, signal: 'SIGTERM' });
    const reruns = mainSpawns();
    expect(reruns.map((s) => [s.args[2], s.options.timeout])).toEqual([
      ['status', 3800],
      ['ls-files', undefined],
      ['posted into the dead window', 5000],
    ]);
    expect('timeout' in reruns[1].options).toBe(false);
    expect(h.runner.pendingCount()).toBe(0);
    h.runner.stop();
  });

  describe('PM-13: calls complete in process when the runner cannot start', () => {
    const variants: Array<[string, Parameters<typeof startHarnessRunner>[1]]> = [
      ['the entry file is missing', { resolveEntry: () => { throw new Error('gitRunner.js not found'); } }],
      ['fork throws', { launch: () => { throw new Error('fork failed'); } }],
      ['the child exits before ready', { behaviours: [{ exitBeforeReady: 1 }] }],
      ['the child never sends ready', { behaviours: [{ neverReady: true }] }],
    ];
    it.each(variants)('%s', async (_label, options) => {
      const h = startHarnessRunner(side, { ...options, timing: { ...FAST, respawnBackoffMs: [60_000] } });
      const started = performance.now();
      await expect(runGit(['sleep-print', '0', 'ok'], { env: fakeEnv, timeout: 5000 })).resolves.toEqual({ stdout: 'ok', stderr: '' });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(mainSpawns()).toHaveLength(1);
      await until(() => h.runner.supervisor.state === 'restarting', 'the failed start');
      await expect(runGit(['sleep-print', '0', 'again'], { env: fakeEnv })).resolves.toEqual({ stdout: 'again', stderr: '' });
      expect(runnerSpawns()).toHaveLength(0);
      expect(h.log.warn).toHaveBeenCalledTimes(1);
      expect(h.log.warn.mock.calls[0][0]).toContain('[GitRunner]');
      expect(h.launch.mock.calls.length).toBeLessThanOrEqual(1);
      h.runner.stop();
    });
  });

  it('PM-14 (Q1): calls made while the runner is first starting run in process without waiting', async () => {
    const h = startHarnessRunner(side, { behaviours: [{ readyDelayMs: 1500 }] });
    const started = performance.now();
    for (let i = 0; i < 5; i++) {
      await expect(runGit(['sleep-print', '0', `call ${i}`], { env: fakeEnv })).resolves.toMatchObject({ stdout: `call ${i}` });
    }
    expect(performance.now() - started).toBeLessThan(1000);
    expect(h.runner.supervisor.state).toBe('starting');
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(mainSpawns()).toHaveLength(5);
    h.runner.stop();
  });

  it('PM-15 (Q2): calls between crashes run in process, the 6th crash stops respawning, and the runner returns after the cool-off', async () => {
    // The supervisor's clock is Date. Holding it still keeps the burst below
    // inside the cool-off however long 100 git spawns take on a loaded machine.
    vi.useFakeTimers({ toFake: ['Date'] });
    const coolOffMs = 1500;
    const h = startHarnessRunner(side, { timing: { ...FAST, coolOffMs } });
    for (let crash = 1; crash <= 6; crash++) {
      const child = await h.up();
      spawns.length = 0;
      await runGit(['sleep-print', '0', 'runner'], { env: fakeEnv });
      expect(runnerSpawns()).toHaveLength(1);
      child.crash(1);
      spawns.length = 0;
      await expect(runGit(['sleep-print', '0', 'between'], { env: fakeEnv })).resolves.toMatchObject({ stdout: 'between' });
      expect(mainSpawns()).toHaveLength(1);
    }
    expect(h.runner.supervisor.state).toBe('exhausted');
    const budgetWarnings = h.log.warn.mock.calls.filter(([line]) => String(line).includes('failed 6 times'));
    expect(budgetWarnings).toHaveLength(1);
    const launches = h.launch.mock.calls.length;
    const logLines = h.log.warn.mock.calls.length + h.log.info.mock.calls.length;
    spawns.length = 0;
    await Promise.all(Array.from({ length: 100 }, () => runGit(['sleep-print', '0', 'down'], { env: fakeEnv })));
    expect(h.runner.supervisor.state).toBe('exhausted');
    expect(mainSpawns()).toHaveLength(100);
    expect(h.launch.mock.calls.length).toBe(launches);
    expect(h.log.warn.mock.calls.length + h.log.info.mock.calls.length).toBe(logLines);
    vi.setSystemTime(Date.now() + coolOffMs - 1);
    spawns.length = 0;
    await runGit(['sleep-print', '0', 'still cooling off'], { env: fakeEnv });
    expect(mainSpawns()).toHaveLength(1);
    expect(h.launch.mock.calls.length).toBe(launches);
    vi.setSystemTime(Date.now() + 1);
    spawns.length = 0;
    await runGit(['sleep-print', '0', 'retry trigger'], { env: fakeEnv });
    expect(mainSpawns()).toHaveLength(1);
    expect(h.launch.mock.calls.length).toBe(launches + 1);
    await until(() => h.runner.supervisor.state === 'ready', 'the runner after the cool-off');
    expect(h.log.info.mock.calls.filter(([line]) => String(line).includes('again'))).toHaveLength(1);
    spawns.length = 0;
    await runGit(['sleep-print', '0', 'back'], { env: fakeEnv });
    expect(runnerSpawns()).toHaveLength(1);
    h.runner.stop();
  });

  it('PM-17: git gets main\'s process.env at call time, or the caller\'s env when given', async () => {
    vi.stubEnv('PATH', fakeEnv.PATH!);
    vi.stubEnv('FAKE_GIT_MARK', 'first');
    const h = startHarnessRunner(side);
    await h.up();
    expect((await runGit(['env-mark'])).stdout).toBe('first');
    vi.stubEnv('FAKE_GIT_MARK', 'second');
    expect((await runGit(['env-mark'])).stdout).toBe('second');
    expect((await runGit(['env-mark'], { env: { ...process.env, FAKE_GIT_MARK: 'caller' } })).stdout).toBe('caller');
    expect(runnerSpawns()).toHaveLength(3);
    expect(mainSpawns()).toHaveLength(0);
    h.runner.stop();
  });

  it('PM-18: the runner and the in-process path both pass windowsHide and utf8', async () => {
    await runGitInProcess(['sleep-print', '0', 'x'], { env: fakeEnv });
    const h = startHarnessRunner(side);
    await h.up();
    await runGit(['sleep-print', '0', 'x'], { env: fakeEnv });
    expect(spawns.map((s) => [s.inRunner, s.file, s.options.windowsHide, s.options.encoding])).toEqual([
      [false, 'git', true, 'utf8'],
      [true, 'git', true, 'utf8'],
    ]);
    h.runner.stop();
  });

  it('PM-19: argv with shell metacharacters reaches git byte for byte on both paths', async () => {
    const cwd = fs.mkdtempSync(path.join(scratch, 'argv-'));
    const names = ['a&echo PWNED>x', '$(touch y)', '"q"', 'trail\\', '%PATH%', '日本語 😀', 'show', 'rev:dir with space/f.md', '`touch z`', "it's"];
    const args = ['argv', ...names];
    const expected = args.map((a) => `${a}\0`).join('');
    expect((await runGitInProcess(args, { env: fakeEnv, cwd })).stdout).toBe(expected);
    const h = startHarnessRunner(side);
    await h.up();
    expect((await runGit(args, { env: fakeEnv, cwd })).stdout).toBe(expected);
    expect(fs.readdirSync(cwd)).toEqual([]);
    h.runner.stop();
  });

  it('PM-20: multi-byte output larger than a pipe chunk arrives identical, and maxBuffer counts bytes', async () => {
    const big = path.join(scratch, 'big.txt');
    const unit = 'pfad/日本語-😀-ü/datei.md\0';
    fs.writeFileSync(big, unit.repeat(Math.ceil(3_900_000 / Buffer.byteLength(unit))));
    const show = path.join(scratch, 'show.md');
    fs.writeFileSync(show, 'Überschrift ✓ 中文\n'.repeat(Math.ceil(900_000 / Buffer.byteLength('Überschrift ✓ 中文\n'))));
    const exact = Buffer.byteLength(fs.readFileSync(show, 'utf8'));
    const h = startHarnessRunner(side);
    await h.up();
    for (const file of [big, show]) {
      const viaRunner = await runGit(['cat', file], { env: fakeEnv, maxBuffer: 4 * 1024 * 1024 });
      expect(viaRunner.stdout).toBe(fs.readFileSync(file, 'utf8'));
      expect(viaRunner).toEqual(await runGitInProcess(['cat', file], { env: fakeEnv, maxBuffer: 4 * 1024 * 1024 }));
    }
    await expect(runGit(['cat', show], { env: fakeEnv, maxBuffer: exact })).resolves.toMatchObject({ stdout: fs.readFileSync(show, 'utf8') });
    const over = await runGit(['cat', show], { env: fakeEnv, maxBuffer: exact - 1 }).catch((e: unknown) => e);
    const overInProcess = await runGitInProcess(['cat', show], { env: fakeEnv, maxBuffer: exact - 1 }).catch((e: unknown) => e);
    expect(over).toBeInstanceOf(RangeError);
    expect(errorShape(over)).toEqual(errorShape(overInProcess));
    h.runner.stop();
  });

  it('PM-21: the runner runs calls concurrently', async () => {
    const h = startHarnessRunner(side);
    await h.up();
    const started = performance.now();
    // In series the six calls take at least 6 s. Run together they take about
    // 1 s, which leaves 2 s for spawn overhead on a loaded machine.
    await Promise.all(Array.from({ length: 6 }, (_, i) => runGit(['sleep-print', '1', String(i)], { env: fakeEnv })));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(runnerSpawns()).toHaveLength(6);
    h.runner.stop();
  });

  it('PM-28: a full ls-files chunk, leading -C and --no-optional-locks, a 64 MiB maxBuffer and an env pass through unchanged', async () => {
    const pathspecs = Array.from({ length: 500 }, (_, i) => `untracked-directory-${String(i).padStart(4, '0')}/${'n'.repeat(160)}`);
    const args = ['argv', '-C', scratch, '--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs];
    expect(Buffer.byteLength(args.join('\0'))).toBeGreaterThan(80 * 1024);
    const h = startHarnessRunner(side);
    await h.up();
    const env = { ...fakeEnv, FAKE_GIT_MARK: 'given' };
    const result = await runGit(args, { env, cwd: scratch, maxBuffer: 64 * 1024 * 1024 });
    expect(result.stdout).toBe(args.map((a) => `${a}\0`).join(''));
    expect((await runGit(['env-mark'], { env })).stdout).toBe('given');
    expect(runnerSpawns()[0].options).toMatchObject({ cwd: scratch, maxBuffer: 64 * 1024 * 1024, env });
    h.runner.stop();
  });

  it('PM-24 (optional row): before app ready, calls run in process and nothing is forked', async () => {
    let ready = false;
    const h = startHarnessRunner(side, { isAppReady: () => ready });
    await expect(runGit(['sleep-print', '0', 'early'], { env: fakeEnv })).resolves.toMatchObject({ stdout: 'early' });
    expect(h.launch).not.toHaveBeenCalled();
    ready = true;
    await runGit(['sleep-print', '0', 'first after ready'], { env: fakeEnv });
    expect(h.launch).toHaveBeenCalledTimes(1);
    h.runner.stop();
  });

  it('PM-25: stop() kills the runner, settles pending calls in process, and never forks again', async () => {
    const h = startHarnessRunner(side, { timing: FAST });
    const child = await h.up();
    const pending = runGit(['sleep-print', '0.3', 'pending at quit'], { env: fakeEnv, timeout: 5000 });
    await until(() => runnerSpawns().length === 1, 'the runner to start git');
    const started = performance.now();
    h.runner.stop();
    expect(performance.now() - started).toBeLessThan(50);
    expect(child.kills).toBe(1);
    await expect(pending).resolves.toEqual({ stdout: 'pending at quit', stderr: '' });
    await flushPorts();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await runGit(['sleep-print', '0', 'after quit'], { env: fakeEnv });
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.runner.supervisor.state).toBe('stopped');
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it('README 5 (PM-29 unit part): a runner that stops answering pings is killed and its pending calls re-run in process', async () => {
    const h = startHarnessRunner(side, { timing: { ...FAST, pingIntervalMs: 30, pingTimeoutMs: 150, killGraceMs: 30 } });
    const child = await h.up();
    child.pauseUp();
    const call = runGit(['sleep-print', '0.4', 'slow'], { env: fakeEnv, timeout: 5000 });
    await expect(call).resolves.toEqual({ stdout: 'slow', stderr: '' });
    expect(child.kills).toBe(1);
    expect(h.log.warn.mock.calls.some(([line]) => String(line).includes('unresponsive'))).toBe(true);
    expect(mainSpawns()).toHaveLength(1);
    await h.up();
    spawns.length = 0;
    await runGit(['sleep-print', '0', 'next'], { env: fakeEnv });
    expect(runnerSpawns()).toHaveLength(1);
    h.runner.stop();
  });
});

/**
 * A runner stand-in on a real `worker_threads` port: real timers, and real
 * message queueing behind a blocked main thread.
 */
class WorkerChild extends EventEmitter implements SupervisedChild {
  pid: number | undefined;
  readonly stdout = null;
  readonly stderr = null;
  private readonly worker: Worker;
  /** `replied[0]` turns 1 once the worker has posted a result. */
  constructor(replyAfterMs: number, replied: Int32Array) {
    super();
    this.worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.on('message', (m) => {
        if (m.type === 'ping') { parentPort.postMessage({ type: 'pong', seq: m.seq }); return; }
        if (m.type === 'run') setTimeout(() => {
          parentPort.postMessage({ type: 'result', id: m.id, stdout: 'from runner', stderr: '' });
          Atomics.store(workerData.replied, 0, 1);
        }, ${replyAfterMs});
      });
      parentPort.postMessage({ type: 'ready', protocol: ${GIT_RUNNER_PROTOCOL_VERSION} });
    `, { eval: true, workerData: { replied } });
    this.worker.on('online', () => { this.pid = 424242; this.emit('spawn'); });
    this.worker.on('message', (message) => this.emit('message', message));
    this.worker.on('exit', (code) => { this.pid = undefined; this.emit('exit', code); });
  }
  postMessage(message: unknown): void { this.worker.postMessage(message); }
  kill(): boolean { void this.worker.terminate(); return true; }
}

describe('PM-8: main stalls past the deadline with the reply queued', () => {
  it('resolves with the queued reply instead of rejecting with a timeout', async () => {
    const replied = new Int32Array(new SharedArrayBuffer(4));
    // A monotonic clock, so a wall-clock step during the stall cannot make the
    // late deadline look on time.
    const h = startHarnessRunner(side, {
      launch: () => new WorkerChild(50, replied), timing: { deadlineMarginMs: 200 }, now: () => performance.now(),
    });
    await h.up();
    const call = settleOf(runGit(['status', '--porcelain'], { timeout: 100 }));
    // Main blocks in the same task that armed the deadline, so the deadline
    // cannot fire before the stall. It stays blocked 1 s past the deadline
    // (timeout + margin), and then until the reply is queued: a loaded machine
    // can starve the worker thread for longer than that.
    const started = performance.now();
    const blocked = () => performance.now() - started;
    while (blocked() < 100 + 200 + 1000 || (Atomics.load(replied, 0) === 0 && blocked() < 8000)) { /* main thread blocked */ }
    expect(Atomics.load(replied, 0)).toBe(1);
    await call.done;
    expect(call.state.error).toBeUndefined();
    expect(call.state.value).toEqual({ stdout: 'from runner', stderr: '' });
    h.runner.stop();
  });
});
