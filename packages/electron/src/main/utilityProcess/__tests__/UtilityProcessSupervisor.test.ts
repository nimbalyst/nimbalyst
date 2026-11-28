// @vitest-environment node
/**
 * The generic utility-process supervisor: lazy start, handshake, respawn
 * backoff, crash budget with cool-off, the ping watchdog and quit. The child is
 * a fake with the event surface of Electron's `UtilityProcess` (`spawn`,
 * `message`, `exit`, `error`; `pid` is undefined until spawn and after exit).
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UtilityProcessSupervisor,
  resolveUtilityEntryPath,
  type SupervisedChild,
  type SupervisorTiming,
} from '../UtilityProcessSupervisor';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

class FakeChild extends EventEmitter implements SupervisedChild {
  pid: number | undefined = undefined;
  stdout = new PassThrough();
  stderr = new PassThrough();
  sent: unknown[] = [];
  kills = 0;
  constructor(readonly fakePid: number) { super(); }
  postMessage(message: unknown): void { this.sent.push(message); }
  kill(): boolean { this.kills++; return true; }
  spawned(): void { this.pid = this.fakePid; this.emit('spawn'); }
  send(message: unknown): void { this.emit('message', message); }
  ready(protocol = 1): void { this.send({ type: 'ready', protocol }); }
  exit(code = 1): void { this.pid = undefined; this.emit('exit', code); }
  pings(): number { return this.sent.filter((m) => (m as { type?: string }).type === 'ping').length; }
}

const TIMING: SupervisorTiming = {
  respawnBackoffMs: [250, 1000, 4000, 15000, 30000],
  maxCrashesInWindow: 5,
  crashWindowMs: 10 * 60_000,
  coolOffMs: 60_000,
  readyTimeoutMs: 20_000,
  pingIntervalMs: 2_000,
  pingTimeoutMs: 10_000,
  killGraceMs: 2_000,
  lateTimerMs: 1_000,
};

interface Setup {
  sup: UtilityProcessSupervisor;
  children: FakeChild[];
  launch: ReturnType<typeof vi.fn>;
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  lost: Array<{ instance: number; reason: string }>;
  messages: Array<{ message: unknown; instance: number }>;
  killProcess: ReturnType<typeof vi.fn>;
  state: { appReady: boolean; busy: boolean; resolveThrows: boolean; launchThrows: boolean };
}

function setup(overrides: { platform?: NodeJS.Platform } = {}): Setup {
  const children: FakeChild[] = [];
  const state = { appReady: true, busy: false, resolveThrows: false, launchThrows: false };
  const lost: Setup['lost'] = [];
  const messages: Setup['messages'] = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const killProcess = vi.fn();
  const launch = vi.fn((_entry: string, _options: { serviceName: string; stdio: 'pipe' }) => {
    if (state.launchThrows) throw new Error('fork failed');
    const child = new FakeChild(4000 + children.length);
    children.push(child);
    return child;
  });
  const sup = new UtilityProcessSupervisor({
    name: 'TestHost',
    serviceName: 'nimbalyst-test-host',
    protocolVersion: 1,
    resolveEntry: () => {
      if (state.resolveThrows) throw new Error('entry not found');
      return '/out/main/testHost.js';
    },
    launch,
    isAppReady: () => state.appReady,
    log,
    onMessage: (message, token) => messages.push({ message, instance: token.instance }),
    onLost: (token, reason) => lost.push({ instance: token.instance, reason }),
    hasPendingWork: () => state.busy,
    timing: TIMING,
    platform: overrides.platform ?? 'linux',
    killProcess,
  });
  return { sup, children, launch, log, lost, messages, killProcess, state };
}

/** Start the first child and complete its handshake. */
function startReady(s: Setup): FakeChild {
  expect(s.sup.acquire()).toBeNull();
  const child = s.children.at(-1)!;
  child.spawned();
  child.ready();
  expect(s.sup.state).toBe('ready');
  return child;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('UtilityProcessSupervisor start', () => {
  it('PM-24: before app ready it never forks, and the first acquire after ready starts the child', () => {
    const s = setup();
    s.state.appReady = false;
    expect(s.sup.acquire()).toBeNull();
    expect(s.launch).not.toHaveBeenCalled();
    expect(s.sup.state).toBe('idle');

    s.state.appReady = true;
    expect(s.sup.acquire()).toBeNull();
    expect(s.launch).toHaveBeenCalledTimes(1);
    expect(s.launch).toHaveBeenCalledWith('/out/main/testHost.js', { serviceName: 'nimbalyst-test-host', stdio: 'pipe' });
  });

  it('PM-14: acquire returns null while the child is starting and never waits for ready', () => {
    const s = setup();
    expect(s.sup.acquire()).toBeNull();
    expect(s.sup.state).toBe('starting');
    // Still starting 1.5 s later: every acquire answers at once with null.
    vi.advanceTimersByTime(1_500);
    for (let i = 0; i < 5; i++) expect(s.sup.acquire()).toBeNull();
    expect(s.launch).toHaveBeenCalledTimes(1);
    s.children[0].spawned();
    s.children[0].ready();
    expect(s.sup.acquire()).toEqual({ instance: 1 });
    expect(s.log.info).toHaveBeenCalledWith(expect.stringContaining('[TestHost] ready'), expect.anything());
  });

  it.each([
    ['the entry file cannot be resolved', (s: Setup) => { s.state.resolveThrows = true; }],
    ['fork throws', (s: Setup) => { s.state.launchThrows = true; }],
  ])('PM-13: when %s, acquire returns null, logs one warn and retries on the backoff', (_label, arrange) => {
    const s = setup();
    arrange(s);
    expect(s.sup.acquire()).toBeNull();
    expect(s.sup.state).toBe('restarting');
    expect(s.log.warn).toHaveBeenCalledTimes(1);
    expect(s.log.warn.mock.calls[0][0]).toContain('[TestHost]');
    // No second attempt before the first backoff step, and none from acquire.
    expect(s.sup.acquire()).toBeNull();
    vi.advanceTimersByTime(249);
    const attemptsBefore = s.state.launchThrows ? s.launch.mock.calls.length : 0;
    s.state.resolveThrows = false;
    s.state.launchThrows = false;
    vi.advanceTimersByTime(1);
    expect(s.launch.mock.calls.length).toBe(attemptsBefore + 1);
    expect(s.sup.state).toBe('starting');
  });

  it('PM-13: a child that exits before ready is a failed start, retried on the backoff', () => {
    const s = setup();
    s.sup.acquire();
    s.children[0].spawned();
    s.children[0].exit(1);
    expect(s.sup.state).toBe('restarting');
    expect(s.lost).toEqual([{ instance: 1, reason: expect.stringContaining('exited') }]);
    vi.advanceTimersByTime(250);
    expect(s.launch).toHaveBeenCalledTimes(2);
  });

  it('PM-13: a child that never sends ready is killed at the ready deadline and retried', () => {
    const s = setup();
    s.sup.acquire();
    s.children[0].spawned();
    vi.advanceTimersByTime(TIMING.readyTimeoutMs - 1);
    expect(s.sup.state).toBe('starting');
    vi.advanceTimersByTime(1);
    expect(s.children[0].kills).toBe(1);
    expect(s.sup.state).toBe('restarting');
    vi.advanceTimersByTime(250);
    expect(s.launch).toHaveBeenCalledTimes(2);
  });

  it('ADV-T-2: a ready timer that fires late because main stalled re-arms instead of failing a healthy start', () => {
    const s = setup();
    s.sup.acquire();
    s.children[0].spawned();
    // Main blocks for 21 s right after the fork: the child's ready is queued behind the stall.
    vi.setSystemTime(Date.now() + 21_000);
    vi.advanceTimersByTime(TIMING.readyTimeoutMs);
    expect(s.sup.state).toBe('starting');
    s.children[0].ready();
    expect(s.sup.state).toBe('ready');
    expect(s.children[0].kills).toBe(0);
    expect(s.log.warn).not.toHaveBeenCalled();
  });

  it('ADV-T-2: the ready timer re-arms once: a child still not ready when it fires again is a failed start', () => {
    const s = setup();
    s.sup.acquire();
    s.children[0].spawned();
    vi.setSystemTime(Date.now() + 21_000);
    vi.advanceTimersByTime(TIMING.readyTimeoutMs);
    expect(s.sup.state).toBe('starting');
    vi.setSystemTime(Date.now() + 21_000);
    vi.advanceTimersByTime(TIMING.readyTimeoutMs - 1);
    expect(s.sup.state).toBe('starting');
    vi.advanceTimersByTime(1);
    expect(s.children[0].kills).toBe(1);
    expect(s.lost).toEqual([{ instance: 1, reason: expect.stringContaining('no ready message') }]);
    expect(s.sup.state).toBe('restarting');
  });

  it('PM-13: a ready message with another protocol version counts as a failed start', () => {
    const s = setup();
    s.sup.acquire();
    s.children[0].spawned();
    s.children[0].ready(2);
    expect(s.sup.state).toBe('restarting');
    expect(s.sup.acquire()).toBeNull();
    expect(s.children[0].kills).toBe(1);
  });
});

describe('UtilityProcessSupervisor crash budget', () => {
  it('PM-15: respawns on [250, 1000, 4000, 15000, 30000] ms and stays down after the 6th death in 10 minutes', () => {
    const s = setup();
    startReady(s);
    const delays = [250, 1000, 4000, 15000, 30000];
    for (let crash = 0; crash < 5; crash++) {
      s.children.at(-1)!.exit(1);
      expect(s.sup.state).toBe('restarting');
      // Between a crash and its respawn, the owner gets no child.
      expect(s.sup.acquire()).toBeNull();
      vi.advanceTimersByTime(delays[crash] - 1);
      expect(s.launch).toHaveBeenCalledTimes(crash + 1);
      vi.advanceTimersByTime(1);
      expect(s.launch).toHaveBeenCalledTimes(crash + 2);
      s.children.at(-1)!.spawned();
      s.children.at(-1)!.ready();
      expect(s.sup.acquire()).toEqual({ instance: crash + 2 });
    }
    s.log.warn.mockClear();
    s.log.info.mockClear();
    s.children.at(-1)!.exit(1);
    expect(s.sup.state).toBe('exhausted');
    expect(s.log.warn).toHaveBeenCalledTimes(1);
    expect(s.log.warn.mock.calls[0][0]).toContain('[TestHost]');

    for (let i = 0; i < 100; i++) expect(s.sup.acquire()).toBeNull();
    vi.advanceTimersByTime(TIMING.coolOffMs - 1);
    expect(s.sup.acquire()).toBeNull();
    expect(s.launch).toHaveBeenCalledTimes(6);
    expect(s.log.warn).toHaveBeenCalledTimes(1);
    expect(s.log.info).not.toHaveBeenCalled();
  });

  it('PM-15 (Q2): after the cool-off one call retries; a failed retry stays down quietly, a good one logs once and resets the budget', () => {
    const s = setup();
    startReady(s);
    for (let crash = 0; crash < 6; crash++) {
      s.children.at(-1)!.exit(1);
      vi.runOnlyPendingTimers();
      if (crash < 5) { s.children.at(-1)!.spawned(); s.children.at(-1)!.ready(); }
    }
    expect(s.sup.state).toBe('exhausted');
    s.log.warn.mockClear();
    s.log.info.mockClear();

    vi.advanceTimersByTime(TIMING.coolOffMs);
    expect(s.sup.acquire()).toBeNull();
    expect(s.launch).toHaveBeenCalledTimes(7);
    s.children.at(-1)!.exit(1);
    expect(s.sup.state).toBe('exhausted');
    expect(s.log.warn).not.toHaveBeenCalled();
    expect(s.sup.acquire()).toBeNull();
    expect(s.launch).toHaveBeenCalledTimes(7);

    vi.advanceTimersByTime(TIMING.coolOffMs);
    expect(s.sup.acquire()).toBeNull();
    expect(s.launch).toHaveBeenCalledTimes(8);
    s.children.at(-1)!.spawned();
    s.children.at(-1)!.ready();
    expect(s.log.info).toHaveBeenCalledTimes(1);
    expect(s.log.info.mock.calls[0][0]).toContain('again');
    // The budget starts over: the next crash respawns after 250 ms.
    s.children.at(-1)!.exit(1);
    expect(s.sup.state).toBe('restarting');
    vi.advanceTimersByTime(250);
    expect(s.launch).toHaveBeenCalledTimes(9);
  });

  it('PM-15: crashes older than the window no longer count', () => {
    const s = setup();
    startReady(s);
    for (let crash = 0; crash < 5; crash++) {
      s.children.at(-1)!.exit(1);
      vi.runOnlyPendingTimers();
      s.children.at(-1)!.spawned();
      s.children.at(-1)!.ready();
    }
    vi.advanceTimersByTime(TIMING.crashWindowMs);
    s.children.at(-1)!.exit(1);
    expect(s.sup.state).toBe('restarting');
  });

  it('a fatal error event is a loss; the exit that follows is not charged twice', () => {
    const s = setup();
    const child = startReady(s);
    child.emit('error', 'FatalError', 'v8::foo');
    expect(s.lost).toEqual([{ instance: 1, reason: expect.stringContaining('FatalError') }]);
    expect(child.kills).toBe(1);
    child.exit(9);
    expect(s.lost).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(s.launch).toHaveBeenCalledTimes(2);
  });
});

describe('UtilityProcessSupervisor watchdog', () => {
  it('arms no ping timer while nothing is pending', () => {
    const s = setup();
    startReady(s);
    s.sup.workStarted();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(s.children[0].pings()).toBe(0);
  });

  it('kills a child that answers no ping for 10 s while calls are pending, then SIGKILLs it after the grace period', () => {
    const s = setup();
    const child = startReady(s);
    s.state.busy = true;
    s.sup.workStarted();
    vi.advanceTimersByTime(TIMING.pingIntervalMs);
    expect(child.pings()).toBe(1);
    vi.advanceTimersByTime(TIMING.pingTimeoutMs - TIMING.pingIntervalMs - 1);
    expect(s.lost).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.lost).toEqual([{ instance: 1, reason: expect.stringContaining('unresponsive') }]);
    expect(child.kills).toBe(1);
    // Electron clears pid on exit; the SIGKILL must use the pid from spawn.
    vi.advanceTimersByTime(TIMING.killGraceMs - 1);
    expect(s.killProcess).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(s.killProcess).toHaveBeenCalledWith(4000, 'SIGKILL');
    vi.advanceTimersByTime(250);
    expect(s.launch).toHaveBeenCalledTimes(2);
  });

  it('PM-29 (partial): no SIGKILL when the child exits inside the grace period, and none on Windows', () => {
    const s = setup();
    const child = startReady(s);
    s.state.busy = true;
    s.sup.workStarted();
    vi.advanceTimersByTime(TIMING.pingTimeoutMs);
    expect(child.kills).toBe(1);
    child.exit(0);
    vi.advanceTimersByTime(TIMING.killGraceMs);
    expect(s.killProcess).not.toHaveBeenCalled();

    const w = setup({ platform: 'win32' });
    const wChild = startReady(w);
    w.state.busy = true;
    w.sup.workStarted();
    vi.advanceTimersByTime(TIMING.pingTimeoutMs);
    expect(wChild.kills).toBe(1);
    vi.advanceTimersByTime(TIMING.killGraceMs);
    expect(w.killProcess).not.toHaveBeenCalled();
  });

  it('a pong, or any other message, counts as a sign of life', () => {
    const s = setup();
    const child = startReady(s);
    s.state.busy = true;
    s.sup.workStarted();
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(TIMING.pingIntervalMs);
      if (i % 2 === 0) child.send({ type: 'pong', seq: i });
      else child.send({ type: 'result', id: i });
    }
    expect(s.lost).toEqual([]);
    expect(s.messages.filter((m) => (m.message as { type: string }).type === 'pong')).toEqual([]);
  });

  it('PM-9: a ping timer that fires late because main stalled resets the deadline instead of killing a healthy child', () => {
    const s = setup();
    const child = startReady(s);
    s.state.busy = true;
    s.sup.workStarted();
    // Main blocks for 15 s: the clock moves but no timer can run.
    vi.setSystemTime(Date.now() + 15_000);
    vi.advanceTimersByTime(TIMING.pingIntervalMs);
    expect(s.lost).toEqual([]);
    expect(child.kills).toBe(0);
    // The pong that was queued behind the stall arrives now.
    child.send({ type: 'pong', seq: 1 });
    vi.advanceTimersByTime(TIMING.pingTimeoutMs - 1);
    expect(s.lost).toEqual([]);
    // No crash was charged: the state is still ready.
    expect(s.sup.state).toBe('ready');
  });

  it('ADV-T-1: silence is counted across idle gaps, so a child that never answers is killed when work comes in short bursts', () => {
    const s = setup();
    const child = startReady(s);
    const token = s.sup.acquire()!;
    const send = () => {
      expect(s.sup.post(token, { type: 'run' })).toBe(true);
      s.state.busy = true;
      s.sup.workStarted();
    };
    // One call every 6.6 s; the owner's own deadline settles each after 2.625 s, unanswered.
    for (let burst = 0; burst < 2; burst++) {
      send();
      vi.advanceTimersByTime(2_625);
      s.state.busy = false;
      s.sup.workFinished();
      vi.advanceTimersByTime(6_600 - 2_625);
    }
    expect(s.lost).toEqual([]);
    send();
    vi.advanceTimersByTime(TIMING.pingIntervalMs - 1);
    expect(s.lost).toEqual([]);
    // 13.2 s after the first unanswered ping, at 2 s.
    vi.advanceTimersByTime(1);
    expect(s.lost).toEqual([{ instance: 1, reason: 'unresponsive: no answer for 13200 ms' }]);
    expect(child.kills).toBe(1);
    // The next child starts with a clean count.
    vi.advanceTimersByTime(250);
    const next = s.children[1];
    next.spawned();
    next.ready();
    expect(s.sup.post(s.sup.acquire()!, { type: 'run' })).toBe(true);
    s.sup.workStarted();
    vi.advanceTimersByTime(TIMING.pingTimeoutMs - 1);
    expect(s.lost).toHaveLength(1);
  });

  it('ADV-T-1: any message from the child clears the carried silence', () => {
    const s = setup();
    const child = startReady(s);
    const token = s.sup.acquire()!;
    s.sup.post(token, { type: 'run', id: 1 });
    s.state.busy = true;
    s.sup.workStarted();
    vi.advanceTimersByTime(2_625);
    s.state.busy = false;
    s.sup.workFinished();
    // The late answer arrives while nothing is pending.
    child.send({ type: 'result', id: 1 });
    vi.advanceTimersByTime(60_000);
    s.sup.post(token, { type: 'run', id: 2 });
    s.state.busy = true;
    s.sup.workStarted();
    vi.advanceTimersByTime(TIMING.pingTimeoutMs - 1);
    expect(s.lost).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.lost).toEqual([{ instance: 1, reason: 'unresponsive: no answer for 10000 ms' }]);
  });

  it('ADV-T-1: only an unanswered ping carries silence, not a message the child need not answer', () => {
    const s = setup();
    startReady(s);
    const token = s.sup.acquire()!;
    // A one-way message while nothing is pending, such as a watcher host's configuration.
    expect(s.sup.post(token, { type: 'configure' })).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(s.sup.post(token, { type: 'run' })).toBe(true);
    s.state.busy = true;
    s.sup.workStarted();
    vi.advanceTimersByTime(TIMING.pingTimeoutMs - 1);
    expect(s.lost).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.lost).toEqual([{ instance: 1, reason: 'unresponsive: no answer for 10000 ms' }]);
  });

  it('stops pinging once the owner reports no pending work', () => {
    const s = setup();
    const child = startReady(s);
    s.state.busy = true;
    s.sup.workStarted();
    vi.advanceTimersByTime(TIMING.pingIntervalMs);
    s.state.busy = false;
    s.sup.workFinished();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(child.pings()).toBe(1);
    expect(s.lost).toEqual([]);
  });
});

describe('UtilityProcessSupervisor identity and quit', () => {
  it('PM-11: messages from a replaced child are ignored, including a late ready and a late pong', () => {
    const s = setup();
    const a = startReady(s);
    a.exit(1);
    vi.advanceTimersByTime(250);
    const b = s.children[1];
    b.spawned();
    // A's queued ready and result arrive while B is starting.
    a.ready();
    a.send({ type: 'result', id: 7 });
    expect(s.sup.state).toBe('starting');
    expect(s.messages).toEqual([]);
    b.ready();
    s.state.busy = true;
    s.sup.workStarted();
    // A's pongs must not keep a silent B alive.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(TIMING.pingIntervalMs);
      a.send({ type: 'pong', seq: i });
    }
    expect(s.lost).toEqual([{ instance: 1, reason: expect.any(String) }, { instance: 2, reason: expect.stringContaining('unresponsive') }]);
  });

  it('post refuses a token that is not the current ready child', () => {
    const s = setup();
    const a = startReady(s);
    const token = s.sup.acquire()!;
    expect(s.sup.post(token, { type: 'x' })).toBe(true);
    expect(a.sent).toContainEqual({ type: 'x' });
    a.exit(1);
    expect(s.sup.post(token, { type: 'y' })).toBe(false);
    expect(a.sent).not.toContainEqual({ type: 'y' });
  });

  it('PM-25: stop kills the child, reports its loss once, charges no crash and never forks again', () => {
    const s = setup();
    const child = startReady(s);
    s.sup.stop();
    expect(child.kills).toBe(1);
    expect(s.lost).toEqual([{ instance: 1, reason: 'stopped' }]);
    child.exit(0);
    vi.advanceTimersByTime(TIMING.crashWindowMs);
    expect(s.sup.acquire()).toBeNull();
    expect(s.launch).toHaveBeenCalledTimes(1);
    expect(s.log.warn).not.toHaveBeenCalled();
    expect(s.sup.state).toBe('stopped');
  });

  it('PM-25: stop while restarting clears the respawn timer', () => {
    const s = setup();
    startReady(s).exit(1);
    expect(s.sup.state).toBe('restarting');
    s.sup.stop();
    vi.advanceTimersByTime(60_000);
    expect(s.launch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures stdout and stderr to the log with the name prefix', async () => {
    const s = setup();
    const child = startReady(s);
    child.stdout.write('hello\n');
    child.stderr.write('boom\n');
    await vi.waitFor(() => {
      expect(s.log.info).toHaveBeenCalledWith('[TestHost] stdout: hello');
      expect(s.log.warn).toHaveBeenCalledWith('[TestHost] stderr: boom');
    });
  });
});

describe('resolveUtilityEntryPath', () => {
  it('PM-27: finds the entry next to the calling chunk or one level up, under any out dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-utility-entry-'));
    try {
      const mainDir = path.join(root, 'out2', 'main');
      fs.mkdirSync(path.join(mainDir, 'chunks'), { recursive: true });
      fs.writeFileSync(path.join(mainDir, 'gitRunner.js'), '');
      expect(resolveUtilityEntryPath('gitRunner.js', mainDir)).toBe(path.join(mainDir, 'gitRunner.js'));
      expect(resolveUtilityEntryPath('gitRunner.js', path.join(mainDir, 'chunks'))).toBe(path.join(mainDir, 'gitRunner.js'));
      expect(() => resolveUtilityEntryPath('missing.js', mainDir)).toThrow('missing.js');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
