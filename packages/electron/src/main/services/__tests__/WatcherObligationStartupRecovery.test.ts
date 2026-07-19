import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: childProcessMocks.spawn };
});

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

import {
  __resetWatcherObligationRecoveryForTests,
  runWatcherObligationStartupRecovery,
  type SpawnFn,
} from '../WatcherObligationStartupRecovery';

const ARGV_ENV_VAR = 'NIMBALYST_WATCHER_OBLIGATION_RECOVERY_ARGV';

function createFakeChild(): {
  child: ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    kill,
  }) as unknown as ChildProcess;

  return { child, stdout, stderr, kill };
}

function configuredEnv(): Record<string, string> {
  return { [ARGV_ENV_VAR]: JSON.stringify(['watcher-controller', '--format', 'json']) };
}

function recoveredSpawn(): { spawnFn: SpawnFn; spawnMock: ReturnType<typeof vi.fn> } {
  const spawnMock = vi.fn(() => {
    const { child, stdout } = createFakeChild();
    queueMicrotask(() => {
      stdout.emit(
        'data',
        Buffer.from('{"status":"recovered","nonce":"boot-id","recovered":[],"skipped":[]}')
      );
      child.emit('close', 0);
    });
    return child;
  });

  return { spawnFn: spawnMock as unknown as SpawnFn, spawnMock };
}

describe('runWatcherObligationStartupRecovery', () => {
  beforeEach(() => {
    __resetWatcherObligationRecoveryForTests();
    vi.clearAllMocks();
  });

  it('returns not configured without spawning when argv is absent', async () => {
    const spawnMock = vi.fn();

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-unconfigured',
      env: {},
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result).toEqual({
      recovered: false,
      reason: 'not configured',
      nonce: 'boot-unconfigured',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('treats malformed argv JSON as not configured without spawning', async () => {
    const spawnMock = vi.fn();

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-malformed',
      env: { [ARGV_ENV_VAR]: '[not-json' },
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result).toEqual({
      recovered: false,
      reason: 'not configured',
      nonce: 'boot-malformed',
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('reports recovered when the child returns the recovered schema and exits zero', async () => {
    const { spawnFn, spawnMock } = recoveredSpawn();

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-success',
      env: configuredEnv(),
      spawnFn,
    });

    expect(result).toEqual({
      recovered: true,
      reason: 'recovery command reported recovered',
      nonce: 'boot-success',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'watcher-controller',
      ['--format', 'json', 'recover', '--nonce', 'boot-success'],
      expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('reports a nonzero child exit and includes the exit code', async () => {
    const spawnMock = vi.fn(() => {
      const { child, stderr } = createFakeChild();
      queueMicrotask(() => {
        stderr.emit('data', Buffer.from('{"ok":false,"error":"controller failed"}'));
        child.emit('close', 2);
      });
      return child;
    });

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-exit-2',
      env: configuredEnv(),
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result.recovered).toBe(false);
    expect(result.reason).toContain('recovery command exited 2');
  });

  it('kills and reports timeout when the child never closes', async () => {
    const fake = createFakeChild();
    const spawnMock = vi.fn(() => fake.child);

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-timeout',
      env: configuredEnv(),
      timeoutMs: 20,
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result).toEqual({
      recovered: false,
      reason: 'timeout',
      nonce: 'boot-timeout',
    });
    expect(fake.kill).toHaveBeenCalledOnce();
  });

  it('deduplicates repeated calls for the same boot id', async () => {
    const { spawnFn, spawnMock } = recoveredSpawn();
    const options = {
      hostBootId: 'same-boot',
      env: configuredEnv(),
      spawnFn,
    };

    const first = await runWatcherObligationStartupRecovery(options);
    const second = await runWatcherObligationStartupRecovery(options);

    expect(second).toEqual(first);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it('shares one in-flight attempt between concurrent calls for the same boot id', async () => {
    const fake = createFakeChild();
    const spawnMock = vi.fn(() => fake.child);
    const options = {
      hostBootId: 'same-boot-concurrent',
      env: configuredEnv(),
      spawnFn: spawnMock as unknown as SpawnFn,
    };

    const firstPromise = runWatcherObligationStartupRecovery(options);
    const secondPromise = runWatcherObligationStartupRecovery(options);
    await Promise.resolve();

    expect(spawnMock).toHaveBeenCalledOnce();

    fake.stdout.emit('data', Buffer.from('{"status":"recovered"}'));
    fake.child.emit('close', 0);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(second).toBe(first);
    expect(first).toEqual({
      recovered: true,
      reason: 'recovery command reported recovered',
      nonce: 'same-boot-concurrent',
    });
  });

  it('kills and rejects oversized stdout without waiting for child close', async () => {
    const fake = createFakeChild();
    fake.kill.mockImplementation(() => {
      fake.child.emit('close', 0);
      return true;
    });
    const spawnMock = vi.fn(() => fake.child);
    const resultPromise = runWatcherObligationStartupRecovery({
      hostBootId: 'boot-oversized',
      env: configuredEnv(),
      timeoutMs: 10_000,
      spawnFn: spawnMock as unknown as SpawnFn,
    });
    await Promise.resolve();

    fake.stdout.emit('data', Buffer.from('{"status":"recovered"}'));
    fake.stdout.emit('data', Buffer.alloc(4096, 'x'));

    await expect(resultPromise).resolves.toEqual({
      recovered: false,
      reason: 'output exceeded size limit',
      nonce: 'boot-oversized',
    });
    expect(fake.kill).toHaveBeenCalledOnce();
  });

  it('redacts UUID-bearing Windows paths in synchronous spawn failures', async () => {
    const sensitivePath =
      'C:\\Users\\somebody\\sessions\\3fa85f64-5717-4562-b3fc-2c963f66afa6\\log.txt';
    const spawnMock = vi.fn(() => {
      throw new Error(`cannot open ${sensitivePath}`);
    });

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-spawn-redaction',
      env: configuredEnv(),
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result.reason).toContain('spawn failed: cannot open C:\\Users');
    expect(result.reason).toContain('...[redacted]');
    expect(result.reason).not.toContain('3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('redacts UUID-bearing POSIX paths in emitted spawn errors', async () => {
    const fake = createFakeChild();
    const spawnMock = vi.fn(() => {
      queueMicrotask(() => {
        fake.child.emit(
          'error',
          new Error(
            'failed at /var/lib/nimbalyst/sessions/3fa85f64-5717-4562-b3fc-2c963f66afa6/log.txt'
          )
        );
      });
      return fake.child;
    });

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-error-redaction',
      env: configuredEnv(),
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result.reason).toContain('spawn error: failed at /var/lib');
    expect(result.reason).toContain('...[redacted]');
    expect(result.reason).not.toContain('3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('redacts UUID-bearing paths in nonzero-exit output', async () => {
    const spawnMock = vi.fn(() => {
      const { child, stderr } = createFakeChild();
      queueMicrotask(() => {
        stderr.emit(
          'data',
          Buffer.from(
            'controller failed at /tmp/sessions/3fa85f64-5717-4562-b3fc-2c963f66afa6/log.txt'
          )
        );
        child.emit('close', 3);
      });
      return child;
    });

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-exit-redaction',
      env: configuredEnv(),
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result.reason).toContain('recovery command exited 3: controller failed at /tmp');
    expect(result.reason).toContain('...[redacted]');
    expect(result.reason).not.toContain('3fa85f64-5717-4562-b3fc-2c963f66afa6');
  });

  it('preserves ordinary external error messages without a path UUID', async () => {
    const spawnMock = vi.fn(() => {
      throw new Error('permission denied');
    });

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: 'boot-ordinary-error',
      env: configuredEnv(),
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result.reason).toBe('spawn failed: permission denied');
  });

  it('spawns again for a different boot id', async () => {
    const { spawnFn, spawnMock } = recoveredSpawn();

    await runWatcherObligationStartupRecovery({
      hostBootId: 'first-boot',
      env: configuredEnv(),
      spawnFn,
    });
    await runWatcherObligationStartupRecovery({
      hostBootId: 'second-boot',
      env: configuredEnv(),
      spawnFn,
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty host boot id without spawning', async () => {
    const spawnMock = vi.fn();

    const result = await runWatcherObligationStartupRecovery({
      hostBootId: '',
      env: configuredEnv(),
      spawnFn: spawnMock as unknown as SpawnFn,
    });

    expect(result).toEqual({ recovered: false, reason: 'missing hostBootId', nonce: '' });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not attempt recovery as a module-import side effect', async () => {
    vi.resetModules();

    await import('../WatcherObligationStartupRecovery');

    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
  });
});
