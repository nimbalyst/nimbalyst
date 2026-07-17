import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { terminateOwnedProcessTree } from '../processTreeTermination';

function makeChild(overrides: Partial<{
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}> = {}) {
  return {
    pid: 4242,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    ...overrides,
  };
}

class FakeTaskkillProcess extends EventEmitter {
  readonly unref = vi.fn();
  readonly kill = vi.fn(() => true);
}

describe('terminateOwnedProcessTree', () => {
  it('spawns an exact detached Windows taskkill tree for the owned root PID', () => {
    const child = makeChild();
    const taskkill = new FakeTaskkillProcess();
    const spawn = vi.fn(() => taskkill);

    terminateOwnedProcessTree(child as never, {
      platform: 'win32',
      spawn: spawn as never,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      },
    );
    expect(taskkill.unref).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit('exit', 0, null);
  });

  it('falls back to direct-child termination when Windows tree-kill spawn fails', () => {
    const child = makeChild();
    const spawn = vi.fn(() => {
      throw new Error('taskkill unavailable');
    });

    terminateOwnedProcessTree(child as never, {
      platform: 'win32',
      spawn: spawn as never,
    });

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('falls back when taskkill exits unsuccessfully', () => {
    const child = makeChild();
    const taskkill = new FakeTaskkillProcess();

    terminateOwnedProcessTree(child as never, {
      platform: 'win32',
      spawn: vi.fn(() => taskkill) as never,
    });
    taskkill.emit('exit', 1, null);

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('bounds a hung taskkill helper and falls back without blocking', () => {
    vi.useFakeTimers();
    const child = makeChild();
    const taskkill = new FakeTaskkillProcess();

    try {
      terminateOwnedProcessTree(child as never, {
        platform: 'win32',
        spawn: vi.fn(() => taskkill) as never,
      });
      vi.advanceTimersByTime(5_000);

      expect(taskkill.kill).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still converges the Windows tree after a prior direct kill signal', () => {
    const child = makeChild({ killed: true });
    const taskkill = new FakeTaskkillProcess();
    const spawn = vi.fn(() => taskkill);

    terminateOwnedProcessTree(child as never, {
      platform: 'win32',
      spawn: spawn as never,
    });

    expect(spawn).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4242', '/T', '/F'],
      expect.any(Object),
    );
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit('exit', 0, null);
  });

  it('is idempotent for the same owned child identity', () => {
    const child = makeChild();
    const taskkill = new FakeTaskkillProcess();
    const spawn = vi.fn(() => taskkill);
    const deps = {
      platform: 'win32' as const,
      spawn: spawn as never,
    };

    terminateOwnedProcessTree(child as never, deps);
    terminateOwnedProcessTree(child as never, deps);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    taskkill.emit('exit', 0, null);
  });

  it('does not target a PID after the owned child has already exited', () => {
    const child = makeChild({ exitCode: 0 });
    const spawn = vi.fn();

    terminateOwnedProcessTree(child as never, {
      platform: 'win32',
      spawn: spawn as never,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses direct-child termination on non-Windows platforms', () => {
    const child = makeChild();
    const spawn = vi.fn();

    terminateOwnedProcessTree(child as never, {
      platform: 'linux',
      spawn: spawn as never,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
