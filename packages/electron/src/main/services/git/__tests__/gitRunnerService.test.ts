// @vitest-environment node
/**
 * The Electron wiring of the git runner: `configureGitRunner` at app ready and
 * `shutdownGitRunner` at quit, with `utilityProcess.fork` returning a harness
 * child that runs the real runner module.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, utilityProcess } from 'electron';
import { logger } from '../../../utils/logger';
import { runGit } from '../runGit';
import { configureGitRunner, shutdownGitRunner } from '../gitRunnerService';
import { HarnessChild, until, type RecordedSpawn, type SpawnSide } from './gitRunnerHarness';

const { side, spawns } = vi.hoisted(() => ({
  side: { inRunner: false } as SpawnSide,
  spawns: [] as RecordedSpawn[],
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: Object.assign(new EventEmitter(), { isReady: vi.fn(() => true) }),
    utilityProcess: { fork: vi.fn() },
  };
});
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../../utilityProcess/UtilityProcessSupervisor', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../utilityProcess/UtilityProcessSupervisor')>(),
  resolveUtilityEntryPath: vi.fn((fileName: string) => `/app/out/main/${fileName}`),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((file: string, args: string[], options: Record<string, unknown>, callback: unknown) => {
    spawns.push({ file, args: [...args], options: { ...options }, inRunner: side.inRunner });
    return (actual.execFile as (...a: unknown[]) => unknown)(file, args, options, callback);
  });
  return { ...actual, execFile };
});

const children: HarnessChild[] = [];

beforeEach(() => {
  vi.mocked(utilityProcess.fork).mockImplementation((() => {
    const child = new HarnessChild(side);
    children.push(child);
    return child;
  }) as unknown as typeof utilityProcess.fork);
});

afterEach(() => {
  shutdownGitRunner();
  vi.clearAllMocks();
  children.length = 0;
  spawns.length = 0;
});

const version = () => runGit(['--version']);

describe('git runner wiring', () => {
  it('PM-16: NIMBALYST_GIT_RUNNER=off keeps every call in process and never forks', async () => {
    configureGitRunner({ NIMBALYST_GIT_RUNNER: 'off' });
    for (let i = 0; i < 3; i++) await expect(version()).resolves.toMatchObject({ stdout: expect.stringContaining('git version') });
    expect(utilityProcess.fork).not.toHaveBeenCalled();
    expect(spawns.map((s) => s.inRunner)).toEqual([false, false, false]);
    expect(vi.mocked(logger.main.info).mock.calls.filter(([line]) => String(line).includes('[GitRunner]'))).toHaveLength(1);
  });

  it.each([['unset', {}], ['another value', { NIMBALYST_GIT_RUNNER: 'on' }]])('PM-16: %s uses the runner, forked lazily on the first call', async (_label, env) => {
    configureGitRunner(env as NodeJS.ProcessEnv);
    expect(utilityProcess.fork).not.toHaveBeenCalled();
    await version();
    expect(utilityProcess.fork).toHaveBeenCalledWith('/app/out/main/gitRunner.js', [], { serviceName: 'nimbalyst-git-runner', stdio: 'pipe' });
    await until(() => vi.mocked(logger.main.info).mock.calls.some(([line]) => String(line).includes('[GitRunner] ready')), 'the runner');
    spawns.length = 0;
    await version();
    expect(spawns.map((s) => s.inRunner)).toEqual([true]);
  });

  it('README 5: the runner\'s stdio goes to the main log with a [GitRunner] prefix', async () => {
    configureGitRunner({});
    await version();
    children[0].stderr.write('warning from the runner\n');
    children[0].stdout.write('note from the runner\n');
    await until(() => vi.mocked(logger.main.warn).mock.calls.length > 0, 'the stderr line');
    expect(logger.main.warn).toHaveBeenCalledWith('[GitRunner] stderr: warning from the runner');
    expect(logger.main.info).toHaveBeenCalledWith('[GitRunner] stdout: note from the runner');
  });

  it('PM-24 (optional row): before app ready nothing is forked', async () => {
    vi.mocked(app.isReady).mockReturnValue(false);
    configureGitRunner({});
    await version();
    expect(utilityProcess.fork).not.toHaveBeenCalled();
    vi.mocked(app.isReady).mockReturnValue(true);
    await version();
    expect(utilityProcess.fork).toHaveBeenCalledTimes(1);
  });

  it('PM-25: shutdownGitRunner kills the runner, settles pending calls without logging, and later calls run in process', async () => {
    configureGitRunner({});
    await version();
    await until(() => vi.mocked(logger.main.info).mock.calls.some(([line]) => String(line).includes('[GitRunner] ready')), 'the runner');
    spawns.length = 0;
    const pending = runGit(['--version'], { timeout: 5000 });
    shutdownGitRunner();
    expect(children[0].kills).toBe(1);
    await expect(pending).resolves.toMatchObject({ stdout: expect.stringContaining('git version') });
    await version();
    expect(utilityProcess.fork).toHaveBeenCalledTimes(1);
    expect(spawns.filter((s) => !s.inRunner)).toHaveLength(2);
    expect(logger.main.warn).not.toHaveBeenCalled();
    expect(logger.main.error).not.toHaveBeenCalled();
  });

  it('ADV-T-3: a quit that skips before-quit (quit-and-install, app.exit) still stops the runner, so its exit is not logged as a crash', async () => {
    configureGitRunner({});
    await version();
    await until(() => vi.mocked(logger.main.info).mock.calls.some(([line]) => String(line).includes('[GitRunner] ready')), 'the runner');
    // Electron emits quit on every path, then the runner's exit reaches JS.
    app.emit('quit');
    children[0].exit(0);
    expect(logger.main.warn).not.toHaveBeenCalled();
    spawns.length = 0;
    await version();
    expect(spawns.map((s) => s.inRunner)).toEqual([false]);
    expect(utilityProcess.fork).toHaveBeenCalledTimes(1);
  });
});
