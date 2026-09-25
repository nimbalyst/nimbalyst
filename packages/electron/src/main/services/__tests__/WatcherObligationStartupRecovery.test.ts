// @vitest-environment node
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn() } },
}));

import {
  __resetWatcherObligationRecoveryForTests,
  runWatcherObligationStartupRecovery,
  type SpawnFn,
} from '../WatcherObligationStartupRecovery';

const ARGV_ENV_VAR = 'NIMBALYST_WATCHER_OBLIGATION_RECOVERY_ARGV';

function fakeChild(): {
  child: ChildProcess;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), { stdout, stderr, kill }) as unknown as ChildProcess;
  return { child, stdout, stderr, kill };
}

function configuredEnv(): Record<string, string> {
  return { [ARGV_ENV_VAR]: JSON.stringify(['watcher-controller', '--format', 'json']) };
}

describe('runWatcherObligationStartupRecovery', () => {
  beforeEach(() => {
    __resetWatcherObligationRecoveryForTests();
  });

  it('is a silent no-op when no controller is configured', async () => {
    const spawnFn = vi.fn();
    await expect(runWatcherObligationStartupRecovery({
      hostBootId: 'boot-unconfigured',
      env: {},
      spawnFn: spawnFn as unknown as SpawnFn,
    })).resolves.toEqual({
      recovered: false,
      reason: 'not configured',
      nonce: 'boot-unconfigured',
    });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('passes a stable boot nonce and accepts only the recovered receipt', async () => {
    const spawnFn = vi.fn(() => {
      const { child, stdout } = fakeChild();
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from('{"status":"recovered"}'));
        child.emit('close', 0);
      });
      return child;
    });

    await expect(runWatcherObligationStartupRecovery({
      hostBootId: 'boot-success',
      env: configuredEnv(),
      spawnFn: spawnFn as unknown as SpawnFn,
    })).resolves.toMatchObject({ recovered: true, nonce: 'boot-success' });
    expect(spawnFn).toHaveBeenCalledWith(
      'watcher-controller',
      ['--format', 'json', 'recover', '--nonce', 'boot-success'],
      expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('shares one in-flight recovery attempt for the same boot', async () => {
    const fake = fakeChild();
    const spawnFn = vi.fn(() => fake.child);
    const options = {
      hostBootId: 'boot-deduped',
      env: configuredEnv(),
      spawnFn: spawnFn as unknown as SpawnFn,
    };

    const first = runWatcherObligationStartupRecovery(options);
    const second = runWatcherObligationStartupRecovery(options);
    await Promise.resolve();
    expect(spawnFn).toHaveBeenCalledOnce();

    fake.stdout.emit('data', Buffer.from('{"status":"recovered"}'));
    fake.child.emit('close', 0);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ recovered: true }),
      expect.objectContaining({ recovered: true }),
    ]);
  });

  it('kills a controller that exceeds the startup bound', async () => {
    const fake = fakeChild();
    const spawnFn = vi.fn(() => fake.child);

    await expect(runWatcherObligationStartupRecovery({
      hostBootId: 'boot-timeout',
      env: configuredEnv(),
      timeoutMs: 10,
      spawnFn: spawnFn as unknown as SpawnFn,
    })).resolves.toMatchObject({ recovered: false, reason: 'timeout' });
    expect(fake.kill).toHaveBeenCalledOnce();
  });

  it('does not report malformed output as recovered', async () => {
    const spawnFn = vi.fn(() => {
      const { child, stdout } = fakeChild();
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from('{"status":"maybe"}'));
        child.emit('close', 0);
      });
      return child;
    });

    await expect(runWatcherObligationStartupRecovery({
      hostBootId: 'boot-malformed',
      env: configuredEnv(),
      spawnFn: spawnFn as unknown as SpawnFn,
    })).resolves.toMatchObject({ recovered: false, reason: 'malformed recovery output' });
  });
});
