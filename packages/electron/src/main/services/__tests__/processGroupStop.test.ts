// @vitest-environment node
/**
 * Stopping a command terminal's process group: SIGTERM first, SIGKILL only if
 * the group outlives the grace period, and the result says whether the group
 * is really gone. `process.kill` is injected, so nothing real is signalled.
 */
import { describe, expect, it, vi } from 'vitest';
import { isProcessGroupAlive, signalProcessGroup, stopProcessGroup } from '../processGroupStop';

function esrch(): Error {
  return Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
}

/** A fake group that dies when it receives one of `diesOn`. */
function fakeGroup(pid: number, diesOn: string[]) {
  let alive = true;
  const signals: Array<[number, string | number]> = [];
  const kill = vi.fn((target: number, signal: string | number) => {
    if (target !== -pid && target !== pid) throw esrch();
    if (!alive) throw esrch();
    signals.push([target, signal]);
    if (typeof signal === 'string' && diesOn.includes(signal)) alive = false;
    return true;
  });
  let now = 0;
  const deps = {
    platform: 'darwin' as NodeJS.Platform,
    kill,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  return { deps, signals, kill, isAlive: () => alive };
}

describe('stopProcessGroup', () => {
  it('stops at SIGTERM when the group exits within the grace period', async () => {
    const group = fakeGroup(4242, ['SIGTERM']);
    const result = await stopProcessGroup(4242, { graceMs: 5000 }, group.deps);
    expect(result).toEqual({ escalated: false, groupGone: true });
    expect(group.signals.filter(([, s]) => s !== 0)).toEqual([[-4242, 'SIGTERM']]);
  });

  it('sends SIGKILL to the group after the grace period and reports it gone', async () => {
    const group = fakeGroup(4242, ['SIGKILL']);
    const result = await stopProcessGroup(4242, { graceMs: 5000, pollMs: 100 }, group.deps);
    expect(result).toEqual({ escalated: true, groupGone: true });
    const sent = group.signals.filter(([, s]) => s !== 0);
    expect(sent).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
    // SIGKILL was not sent before the grace period ran out.
    expect(group.deps.now()).toBeGreaterThanOrEqual(5000);
  });

  it('reports the group as not gone when it survives SIGKILL', async () => {
    const group = fakeGroup(4242, []);
    const result = await stopProcessGroup(4242, { graceMs: 200, pollMs: 100, killWaitMs: 300 }, group.deps);
    expect(result).toEqual({ escalated: true, groupGone: false });
  });

  it('treats a group that is already gone as stopped without signalling', async () => {
    const group = fakeGroup(4242, ['SIGTERM']);
    await stopProcessGroup(4242, {}, group.deps);
    group.kill.mockClear();
    const result = await stopProcessGroup(4242, {}, group.deps);
    expect(result).toEqual({ escalated: false, groupGone: true });
    expect(group.kill.mock.calls.map(([, signal]) => signal)).toEqual([0]);
  });
});

describe('stopProcessGroup on Windows', () => {
  // taskkill without /F fails for most console programs. That is a failed
  // request, not proof that the tree is gone.
  it('forces the kill when the polite taskkill fails and the process is still there', async () => {
    let alive = true;
    const taskkill = vi.fn((_pid: number, force: boolean) => {
      if (force) alive = false;
      return force;
    });
    const kill = vi.fn(() => {
      if (!alive) throw esrch();
      return true;
    });
    const result = await stopProcessGroup(900, { graceMs: 5000 }, { platform: 'win32', kill, taskkill, now: () => 0, sleep: async () => {} });
    expect(taskkill.mock.calls).toEqual([
      [900, false],
      [900, true],
    ]);
    expect(result).toEqual({ escalated: true, groupGone: true });
  });

  it('does not report the tree gone when the forced kill fails too', async () => {
    let now = 0;
    const result = await stopProcessGroup(
      900,
      { graceMs: 100, killWaitMs: 300 },
      {
        platform: 'win32',
        kill: () => true,
        taskkill: () => false,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }
    );
    expect(result).toEqual({ escalated: true, groupGone: false });
  });
});

describe('signalProcessGroup', () => {
  it('falls back to the single pid when there is no such group', () => {
    const calls: Array<[number, string | number]> = [];
    const kill = (target: number, signal: string | number) => {
      calls.push([target, signal]);
      if (target < 0) throw esrch();
      return true;
    };
    expect(signalProcessGroup(77, 'SIGTERM', { platform: 'linux', kill })).toBe(true);
    expect(calls).toEqual([
      [-77, 'SIGTERM'],
      [77, 'SIGTERM'],
    ]);
  });

  it('refuses pids that would signal every process or the caller\'s own group', () => {
    const kill = vi.fn();
    for (const pid of [0, 1, -5, Number.NaN]) {
      expect(() => signalProcessGroup(pid, 'SIGTERM', { platform: 'linux', kill })).toThrow(/pid/);
    }
    expect(kill).not.toHaveBeenCalled();
  });

  it('uses taskkill on the process tree on Windows, forcing only for SIGKILL', () => {
    const taskkill = vi.fn(() => true);
    const kill = vi.fn();
    signalProcessGroup(900, 'SIGTERM', { platform: 'win32', kill, taskkill });
    signalProcessGroup(900, 'SIGKILL', { platform: 'win32', kill, taskkill });
    expect(taskkill.mock.calls).toEqual([
      [900, false],
      [900, true],
    ]);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('isProcessGroupAlive', () => {
  it('counts EPERM as alive and ESRCH as gone', () => {
    const eperm = () => {
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    };
    expect(isProcessGroupAlive(5, { platform: 'darwin', kill: eperm })).toBe(true);
    expect(
      isProcessGroupAlive(5, {
        platform: 'darwin',
        kill: () => {
          throw esrch();
        },
      })
    ).toBe(false);
  });
});
