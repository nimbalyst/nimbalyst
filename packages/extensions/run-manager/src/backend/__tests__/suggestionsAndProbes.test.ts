// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { packageManagerFor, suggestTargets } from '../suggestions';
import { parseLsofPids, parseNetstatPids, stopExternalProcess } from '../probes';

describe('suggestTargets', () => {
  const pkg = JSON.stringify({
    scripts: { build: 'tsc', dev: 'vite', test: 'vitest', start: 'node server.js', watch: 'tsc -w', serve: '' },
  });

  it('offers only the long-running scripts, run with the project\'s package manager', () => {
    expect(suggestTargets(pkg, 'pnpm')).toEqual([
      { id: 'dev', name: 'dev', command: 'pnpm run dev' },
      { id: 'start', name: 'start', command: 'pnpm run start' },
      { id: 'watch', name: 'watch', command: 'pnpm run watch' },
    ]);
  });

  it('leaves out ids that are already configured', () => {
    expect(suggestTargets(pkg, 'npm', new Set(['dev', 'start'])).map((t) => t.id)).toEqual(['watch']);
  });

  it('offers nothing without a readable package.json', () => {
    expect(suggestTargets(null, 'npm')).toEqual([]);
    expect(suggestTargets('{ not json', 'npm')).toEqual([]);
    expect(suggestTargets('{"name":"x"}', 'npm')).toEqual([]);
  });
});

describe('packageManagerFor', () => {
  it('reads the lockfile and falls back to npm', () => {
    expect(packageManagerFor(new Set(['pnpm-lock.yaml', 'package-lock.json']))).toBe('pnpm');
    expect(packageManagerFor(new Set(['yarn.lock']))).toBe('yarn');
    expect(packageManagerFor(new Set(['bun.lock']))).toBe('bun');
    expect(packageManagerFor(new Set())).toBe('npm');
  });
});

describe('listener pid parsing', () => {
  it('lists each pid once from lsof -t, so two listeners on one port are seen as two', () => {
    expect(parseLsofPids('48213\n48213\n')).toEqual([48213]);
    expect(parseLsofPids('48213\n50001\n')).toEqual([48213, 50001]);
    expect(parseLsofPids('')).toEqual([]);
  });

  it('finds the LISTENING rows for the port in netstat output', () => {
    const output = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040',
      '  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       9120',
      '  TCP    127.0.0.1:58787        127.0.0.1:8787         ESTABLISHED     7000',
    ].join('\r\n');
    expect(parseNetstatPids(output, 8787)).toEqual([9120]);
    expect(parseNetstatPids(output, 3000)).toEqual([]);
  });
});

describe('stopExternalProcess', () => {
  const noSleep = async () => {};

  it('sends SIGTERM and stops there when the process exits', async () => {
    let alive = true;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGTERM') alive = false;
    });
    expect(await stopExternalProcess(4000, { graceMs: 5000, kill, sleep: noSleep })).toBe(true);
    expect(kill.mock.calls.map(([, signal]) => signal).filter((s) => s !== 0)).toEqual(['SIGTERM']);
  });

  it('escalates to SIGKILL after the grace period', async () => {
    let alive = true;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (!alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGKILL') alive = false;
    });
    expect(await stopExternalProcess(4000, { graceMs: 300, kill, sleep: noSleep })).toBe(true);
    expect(kill.mock.calls.map(([, signal]) => signal).filter((s) => s !== 0)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  // The user agreed to stop the process that held the port. If the pid has
  // let go of the port by the time SIGTERM's grace runs out, it is not that
  // process any more (or it is already leaving): no force-kill.
  it('does not force-kill a pid that no longer holds the port', async () => {
    const kill = vi.fn();
    const stillTarget = vi.fn(async () => false);
    expect(await stopExternalProcess(4000, { graceMs: 300, stillTarget, kill, sleep: noSleep })).toBe(false);
    expect(stillTarget).toHaveBeenCalledTimes(1);
    expect(kill.mock.calls.map(([, signal]) => signal).filter((s) => s !== 0)).toEqual(['SIGTERM']);
  });

  it('refuses pid 0 and 1', async () => {
    const kill = vi.fn();
    await expect(stopExternalProcess(1, { graceMs: 10, kill, sleep: noSleep })).rejects.toThrow(/Refusing/);
    expect(kill).not.toHaveBeenCalled();
  });
});
