// @vitest-environment node
/**
 * The run supervisor, driven with fake terminals and a fake clock: no process
 * is started and no port is probed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BackendCommandTerminal,
  BackendTerminalExit,
  BackendTerminalOutputChunk,
  CreateCommandTerminalOptions,
} from '@nimbalyst/extension-sdk';
import { RunManager, type RunManagerDeps } from '../runManager';
import { createRunToolHandlers, targetFromConfigureParams } from '../runTools';

interface FakeTerminal extends BackendCommandTerminal {
  options: CreateCommandTerminalOptions;
  emitOutput: (data: string) => void;
  emitExit: (exitCode: number, signal?: number) => void;
  statuses: Array<string | null>;
  stopCalls: Array<{ graceMs?: number } | undefined>;
  revealed: number;
  /** What `stop()` resolves with, and whether it delivers the exit first. */
  stopResult: { escalated: boolean; groupGone: boolean };
  exitOnStop: boolean;
  log: string;
  closed: boolean;
}

let terminals: FakeTerminal[];
let configText: string | null;
let openPorts: Set<number>;
let listenerPids: Map<number, number>;
let externalStops: number[];
let externalStillTarget: (() => Promise<boolean>) | undefined;
let changes: number;
let time: number;
let timers: Array<{ at: number; resolve: () => void }>;
let createError: Error | null;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Move the fake clock forward, running every sleep that comes due on the way. */
async function advance(ms: number): Promise<void> {
  const end = time + ms;
  await flush();
  for (;;) {
    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.splice(timers.indexOf(due), 1);
    time = Math.max(time, due.at);
    due.resolve();
    await flush();
  }
  time = end;
  await flush();
}

function makeTerminal(options: CreateCommandTerminalOptions): FakeTerminal {
  const outputHandlers = new Set<(chunk: BackendTerminalOutputChunk) => void>();
  const exitHandlers = new Set<(exit: BackendTerminalExit) => void>();
  let cursor = 0;
  let exit: BackendTerminalExit | undefined;
  const terminal: FakeTerminal = {
    id: `term-${terminals.length + 1}`,
    pid: 9000 + terminals.length,
    options,
    statuses: [],
    stopCalls: [],
    revealed: 0,
    stopResult: { escalated: false, groupGone: true },
    exitOnStop: true,
    log: '',
    closed: false,
    onOutput: (handler) => {
      outputHandlers.add(handler);
      return () => outputHandlers.delete(handler);
    },
    onExit: (handler) => {
      if (exit) handler(exit);
      else exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    emitOutput: (data) => {
      cursor += data.length;
      for (const handler of outputHandlers) handler({ data, cursor });
    },
    emitExit: (exitCode, signal) => {
      if (exit) return;
      exit = { exitCode, ...(signal ? { signal } : {}) };
      for (const handler of exitHandlers) handler(exit);
    },
    kill: async () => {},
    stop: async (stopOptions) => {
      terminal.stopCalls.push(stopOptions);
      if (terminal.exitOnStop) terminal.emitExit(0, 15);
      return terminal.stopResult;
    },
    read: async () => {
      if (terminal.closed) throw new Error(`Unknown terminal: ${terminal.id}`);
      return { text: terminal.log, cursor, truncated: false, gap: false };
    },
    reveal: async () => {
      if (terminal.closed) throw new Error(`Unknown terminal: ${terminal.id}`);
      terminal.revealed += 1;
    },
    setStatus: async (tone) => {
      terminal.statuses.push(tone);
    },
    dispose: async () => {},
  };
  return terminal;
}

function makeManager(overrides: Partial<RunManagerDeps> = {}): RunManager {
  return new RunManager({
    terminals: {
      createCommandTerminal: async (options) => {
        if (createError) throw createError;
        const terminal = makeTerminal(options);
        terminals.push(terminal);
        return terminal;
      },
    },
    config: {
      read: async () => configText,
      write: async (text) => {
        configText = text;
      },
    },
    readPackageInfo: async () => ({
      packageJson: JSON.stringify({ scripts: { dev: 'vite', build: 'tsc' } }),
      packageManager: 'pnpm',
    }),
    isPortOpen: async (port) => openPorts.has(port),
    findListenerPid: async (port) => listenerPids.get(port),
    stopExternalProcess: async (pid, stillTarget) => {
      externalStops.push(pid);
      externalStillTarget = stillTarget;
      for (const [port, owner] of listenerPids) {
        if (owner === pid) {
          listenerPids.delete(port);
          openPorts.delete(port);
        }
      }
      return true;
    },
    log: () => {},
    now: () => time,
    sleep: (ms) => new Promise<void>((resolve) => timers.push({ at: time + ms, resolve })),
    onChange: () => {
      changes += 1;
    },
    ...overrides,
  });
}

const CONFIG = {
  targets: [
    { id: 'plain', name: 'Plain', command: 'node watch.js' },
    { id: 'web', name: 'Web dev server', command: 'pnpm run dev', cwd: 'packages/web', port: 5173, env: { A: '1' } },
    { id: 'worker', name: 'Wrangler', command: 'npx wrangler dev', readyPattern: 'Ready on' },
  ],
};

async function loaded(config: unknown = CONFIG): Promise<RunManager> {
  configText = config === null ? null : JSON.stringify(config);
  const manager = makeManager();
  await manager.reloadConfig();
  return manager;
}

const statusOf = (manager: RunManager, id: string) => manager.views().find((v) => v.target.id === id)!.status;

beforeEach(() => {
  terminals = [];
  configText = null;
  openPorts = new Set();
  listenerPids = new Map();
  externalStops = [];
  externalStillTarget = undefined;
  changes = 0;
  time = 1_000_000;
  timers = [];
  createError = null;
});

describe('start', () => {
  it('runs a target with nothing to wait for as soon as it is spawned, in a pinned tab tied to the Runs panel', async () => {
    const manager = await loaded();
    const { run, previousStatus } = await manager.start('plain');
    expect(previousStatus).toBe('stopped');
    expect(run).toMatchObject({ status: 'running', pid: 9000, startedAt: time, hasLogs: true, terminalId: 'term-1' });
    expect(terminals[0].options).toEqual({
      key: 'plain',
      title: 'Plain',
      command: 'node watch.js',
      cwd: undefined,
      env: undefined,
      pinned: true,
      panelId: 'runs',
    });
    expect(terminals[0].statuses.at(-1)).toBe('success');
  });

  it('keeps a target with a port in starting until the port accepts connections', async () => {
    const manager = await loaded();
    const { run } = await manager.start('web');
    expect(run).toMatchObject({ status: 'starting', waitingFor: 'port 5173', url: 'http://localhost:5173' });
    expect(terminals[0].options).toMatchObject({ cwd: 'packages/web', env: { A: '1' } });

    await advance(1200);
    expect(statusOf(manager, 'web')).toBe('starting');
    openPorts.add(5173);
    await advance(500);
    expect(statusOf(manager, 'web')).toBe('running');
    expect(terminals[0].statuses).toEqual(['warning', 'success']);
  });

  it('matches readyPattern across chunk boundaries and through color codes', async () => {
    const manager = await loaded();
    await manager.start('worker');
    terminals[0].emitOutput('\x1b[32m[wrangler]\x1b[0m Rea');
    expect(statusOf(manager, 'worker')).toBe('starting');
    terminals[0].emitOutput('dy on http://localhost:8787\r\n');
    expect(statusOf(manager, 'worker')).toBe('running');
  });

  it('waitForReady resolves when the target becomes ready', async () => {
    const manager = await loaded();
    const pending = manager.start('worker', { waitForReady: true });
    await flush();
    terminals[0].emitOutput('Ready on :8787\n');
    const result = await pending;
    expect(result.run.status).toBe('running');
    expect(result.timedOut).toBeUndefined();
    expect(result.logs).toBeUndefined();
  });

  it('reports a crash before ready with the last log lines', async () => {
    const manager = await loaded();
    const pending = manager.start('worker', { waitForReady: true });
    await flush();
    terminals[0].log = 'Error: missing wrangler.toml';
    terminals[0].emitExit(1);
    const result = await pending;
    expect(result.run).toMatchObject({ status: 'crashed', exitCode: 1 });
    expect(result.run.startedAt).toBeUndefined();
    expect(result.logs).toBe('Error: missing wrangler.toml');
    expect(terminals[0].statuses.at(-1)).toBe('error');
  });

  it('gives up waiting after the timeout, leaves the target starting, and returns the log so far', async () => {
    const manager = await loaded();
    const pending = manager.start('worker', { waitForReady: true, timeoutMs: 30_000 });
    await flush();
    terminals[0].log = 'compiling...';
    await advance(30_000);
    const result = await pending;
    expect(result.timedOut).toBe(true);
    expect(result.run.status).toBe('starting');
    expect(result.logs).toBe('compiling...');
  });

  it('refuses to start a second copy when the port is held by another process, and shows it as external', async () => {
    const manager = await loaded();
    openPorts.add(5173);
    listenerPids.set(5173, 48213);
    await expect(manager.start('web')).rejects.toThrow(/Port 5173 is already in use by pid 48213/);
    expect(terminals).toHaveLength(0);
    expect(manager.views().find((v) => v.target.id === 'web')).toMatchObject({
      status: 'external',
      externalPid: 48213,
      hasLogs: false,
    });
  });

  it('rejects starting a target that is already live and names the configured ids for an unknown one', async () => {
    const manager = await loaded();
    await manager.start('plain');
    await expect(manager.start('plain')).rejects.toThrow(/already running/);
    await expect(manager.start('nope')).rejects.toThrow(/Configured targets: plain, web, worker/);
    expect(terminals).toHaveLength(1);
  });

  it('marks the target crashed when the terminal cannot be created', async () => {
    const manager = await loaded();
    createError = new Error('cwd does not exist: packages/web');
    await expect(manager.start('web')).rejects.toThrow(/cwd does not exist/);
    expect(manager.views().find((v) => v.target.id === 'web')).toMatchObject({
      status: 'crashed',
      error: 'cwd does not exist: packages/web',
    });
  });
});

describe('stop and restart', () => {
  it('stops through the terminal with a 5 s grace period and ends stopped, not crashed', async () => {
    const manager = await loaded();
    await manager.start('plain');
    const { run, previousStatus } = await manager.stop('plain');
    expect(terminals[0].stopCalls).toEqual([{ graceMs: 5000 }]);
    expect(previousStatus).toBe('running');
    expect(run.status).toBe('stopped');
    expect(run.pid).toBeUndefined();
    expect(terminals[0].statuses.at(-1)).toBeNull();
  });

  it('settles to stopped from the group being gone when no exit event arrives', async () => {
    const manager = await loaded();
    await manager.start('plain');
    terminals[0].exitOnStop = false;
    expect((await manager.stop('plain')).run.status).toBe('stopped');
  });

  it('reports a process group that survived SIGKILL instead of calling it stopped', async () => {
    const manager = await loaded();
    await manager.start('plain');
    terminals[0].exitOnStop = false;
    terminals[0].stopResult = { escalated: true, groupGone: false };
    const { run } = await manager.stop('plain');
    expect(run.status).toBe('crashed');
    expect(run.error).toMatch(/still running after SIGKILL/);
  });

  it('treats stopping a target that is not running as a no-op', async () => {
    const manager = await loaded();
    expect((await manager.stop('plain')).run.status).toBe('stopped');
    expect(terminals).toHaveLength(0);
  });

  it('restart stops the old run, starts a new terminal, and ignores a late exit from the old one', async () => {
    const manager = await loaded();
    await manager.start('plain');
    terminals[0].exitOnStop = false;
    const result = await manager.restart('plain');
    expect(result.previousStatus).toBe('running');
    expect(result.run.status).toBe('running');
    expect(terminals).toHaveLength(2);

    terminals[0].emitExit(1);
    expect(statusOf(manager, 'plain')).toBe('running');
  });

  it('shows a run that exits non-zero on its own as crashed, and one ended by SIGTERM as stopped', async () => {
    const manager = await loaded();
    await manager.start('plain');
    terminals[0].emitExit(1);
    expect(manager.views()[0]).toMatchObject({ status: 'crashed', exitCode: 1 });

    await manager.start('plain');
    terminals[1].emitExit(0, 15);
    expect(manager.views()[0]).toMatchObject({ status: 'stopped', exitCode: 143 });
  });
});

describe('external processes', () => {
  it('detects a port held by another process when the state is read, and clears it when the port frees up', async () => {
    const manager = await loaded();
    openPorts.add(5173);
    listenerPids.set(5173, 48213);
    let web = (await manager.snapshot()).runs.find((r) => r.target.id === 'web')!;
    expect(web).toMatchObject({ status: 'external', externalPid: 48213 });

    openPorts.delete(5173);
    web = (await manager.snapshot()).runs.find((r) => r.target.id === 'web')!;
    expect(web.status).toBe('stopped');
  });

  it('will not stop an external process from the agent tool, and only stops the pid it reported', async () => {
    const manager = await loaded();
    openPorts.add(5173);
    listenerPids.set(5173, 48213);
    await manager.snapshot();

    await expect(manager.stop('web')).rejects.toThrow(/running outside Nimbalyst \(pid 48213\)/);
    await expect(manager.stopExternal('web', 777)).rejects.toThrow(/not the process holding the port/);
    expect(externalStops).toEqual([]);

    await manager.stopExternal('web', 48213);
    expect(externalStops).toEqual([48213]);
    expect(statusOf(manager, 'web')).toBe('stopped');
  });

  // The confirmation named the process that held the port when the row was
  // drawn. By the click it can be a different process, or none.
  it('signals nothing when the port has changed hands since the row was drawn', async () => {
    const manager = await loaded();
    openPorts.add(5173);
    listenerPids.set(5173, 4321);
    await manager.snapshot();

    listenerPids.set(5173, 9876);
    await expect(manager.stopExternal('web', 4321)).rejects.toThrow(/no longer pid 4321. Nothing was stopped/);
    expect(externalStops).toEqual([]);
    expect(manager.views().find((v) => v.target.id === 'web')).toMatchObject({ status: 'external', externalPid: 9876 });
  });

  it('lets the stop force-kill only while the pid still holds the port', async () => {
    const manager = await loaded();
    openPorts.add(5173);
    listenerPids.set(5173, 4321);
    await manager.snapshot();
    await manager.stopExternal('web', 4321);

    listenerPids.set(5173, 4321);
    expect(await externalStillTarget!()).toBe(true);
    listenerPids.set(5173, 9876);
    expect(await externalStillTarget!()).toBe(false);
  });
});

describe('a start whose terminal is still being created', () => {
  /** A manager whose terminal creation waits until `release()` is called. */
  async function withHeldCreate() {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = makeManager({
      terminals: {
        createCommandTerminal: async (options) => {
          await held;
          const terminal = makeTerminal(options);
          terminals.push(terminal);
          return terminal;
        },
      },
    });
    configText = JSON.stringify(CONFIG);
    await manager.reloadConfig();
    return { manager, release };
  }

  it('is cancelled by stop, and the terminal is stopped as soon as it exists', async () => {
    const { manager, release } = await withHeldCreate();
    const starting = manager.start('plain');
    starting.catch(() => {});
    await flush();
    expect(statusOf(manager, 'plain')).toBe('starting');

    const stopping = manager.stop('plain');
    await flush();
    expect(statusOf(manager, 'plain')).toBe('stopped');

    release();
    await expect(starting).rejects.toThrow(/stopped while it was starting/);
    await stopping;
    expect(terminals[0].stopCalls).toEqual([{ graceMs: 5000 }]);
    expect(statusOf(manager, 'plain')).toBe('stopped');
  });

  it('is cancelled by a stop that arrives while the port is still being checked', async () => {
    let release!: (open: boolean) => void;
    const checking = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const manager = makeManager({ isPortOpen: () => checking });
    configText = JSON.stringify(CONFIG);
    await manager.reloadConfig();

    const starting = manager.start('web');
    starting.catch(() => {});
    await flush();
    await manager.stop('web');

    release(false);
    await expect(starting).rejects.toThrow(/stopped while it was starting/);
    expect(terminals).toHaveLength(0);
    expect(statusOf(manager, 'web')).toBe('stopped');
  });

  it('is cancelled when its target is removed from the config', async () => {
    const { manager, release } = await withHeldCreate();
    const starting = manager.start('plain');
    starting.catch(() => {});
    await flush();

    const removing = manager.removeTarget('plain');
    await flush();
    release();
    await expect(starting).rejects.toThrow(/stopped while it was starting/);
    await removing;
    expect(terminals[0].stopCalls).toHaveLength(1);
    expect(manager.views().some((v) => v.target.id === 'plain')).toBe(false);
  });

  it('refuses a second start instead of spawning a second copy', async () => {
    const { manager, release } = await withHeldCreate();
    const first = manager.start('web');
    await expect(manager.start('web')).rejects.toThrow(/already starting/);
    release();
    await first;
    expect(terminals).toHaveLength(1);
  });
});

describe('config', () => {
  it('keeps both targets when two are saved at the same time', async () => {
    const manager = await loaded({ targets: [] });
    await Promise.all([
      manager.saveTarget({ id: 'a', name: 'A', command: 'node a.js' }),
      manager.saveTarget({ id: 'b', name: 'B', command: 'node b.js' }),
    ]);
    expect(JSON.parse(configText!).targets.map((t: { id: string }) => t.id)).toEqual(['a', 'b']);
  });

  it('offers package.json suggestions only when there is no config file', async () => {
    const none = await loaded(null);
    expect((await none.snapshot()).suggestions).toEqual([{ id: 'dev', name: 'dev', command: 'pnpm run dev' }]);
    expect((await none.snapshot()).configExists).toBe(false);

    const empty = await loaded({ targets: [] });
    expect((await empty.snapshot()).suggestions).toEqual([]);
  });

  it('keeps the loaded targets and reports the error when the file stops parsing', async () => {
    const manager = await loaded();
    configText = '{ "targets": [';
    await manager.reloadConfig();
    const state = await manager.snapshot();
    expect(state.runs.map((r) => r.target.id)).toEqual(['plain', 'web', 'worker']);
    expect(state.configErrors[0]).toMatch(/not valid JSON/);
  });

  it('stops a running target that was removed from the file', async () => {
    const manager = await loaded();
    await manager.start('plain');
    configText = JSON.stringify({ targets: CONFIG.targets.slice(1) });
    await manager.reloadConfig();
    await flush();
    expect(terminals[0].stopCalls).toHaveLength(1);
    expect(manager.views().map((v) => v.target.id)).toEqual(['web', 'worker']);
  });

  it('saves and removes targets through the file, stopping a removed target first', async () => {
    const manager = await loaded();
    await manager.saveTarget({ id: 'api', name: 'API', command: 'node api.js', port: 8787 });
    expect(JSON.parse(configText!).targets.map((t: { id: string }) => t.id)).toEqual(['plain', 'web', 'worker', 'api']);

    await manager.start('plain');
    await manager.removeTarget('plain');
    expect(terminals[0].stopCalls).toHaveLength(1);
    expect(manager.views().map((v) => v.target.id)).toEqual(['web', 'worker', 'api']);
  });

  it('notifies on status changes so the gutter badge can follow', async () => {
    const manager = await loaded();
    const before = changes;
    await manager.start('plain');
    expect(changes).toBeGreaterThan(before);
  });
});

describe('logs', () => {
  it('reads the log with the target status, and says why there is none', async () => {
    const manager = await loaded();
    await expect(manager.logs('plain')).rejects.toThrow(/has not been started/);

    await manager.start('plain');
    terminals[0].log = 'listening';
    expect(await manager.logs('plain', { tail: 5 })).toMatchObject({ id: 'plain', status: 'running', text: 'listening' });
  });

  it('explains a closed log tab instead of surfacing the host error', async () => {
    const manager = await loaded();
    await manager.start('plain');
    terminals[0].emitExit(0);
    terminals[0].closed = true;
    await expect(manager.logs('plain')).rejects.toThrow(/log tab of "Plain" was closed/);
    expect(manager.views()[0].hasLogs).toBe(false);
    expect(await manager.revealLogs('plain')).toBe(false);
  });
});

describe('agent tools', () => {
  it('run_list reports status, port, url and uptime in seconds', async () => {
    const manager = await loaded();
    const tools = createRunToolHandlers(manager, () => time);
    await manager.start('plain');
    time += 65_000;
    const result = (await tools.list({})) as { targets: Array<Record<string, unknown>> };
    expect(result.targets[0]).toMatchObject({ id: 'plain', status: 'running', pid: 9000, uptimeSeconds: 65 });
    expect(result.targets[1]).toMatchObject({ id: 'web', status: 'stopped', port: 5173, url: 'http://localhost:5173' });
  });

  it('run_start waits for readiness by default and returns the transition with the log tab id', async () => {
    const manager = await loaded();
    const tools = createRunToolHandlers(manager, () => time);
    const pending = tools.start({ id: 'worker' });
    await flush();
    terminals[0].emitOutput('Ready on :8787\n');
    expect(await pending).toMatchObject({
      action: 'start',
      id: 'worker',
      previousStatus: 'stopped',
      status: 'running',
      terminalId: 'term-1',
    });
  });

  // The transcript line shows "crashed (exit N)" from this field.
  it('run_start reports a crash with the exit code as lastExitCode', async () => {
    const manager = await loaded();
    const tools = createRunToolHandlers(manager, () => time);
    const pending = tools.start({ id: 'worker' });
    await flush();
    terminals[0].emitExit(1);
    expect(await pending).toMatchObject({ action: 'start', id: 'worker', name: 'Wrangler', status: 'crashed', lastExitCode: 1 });
  });

  it('run_configure adds, edits by merging, clears a field, and removes', async () => {
    const manager = await loaded({ targets: [] });
    const tools = createRunToolHandlers(manager, () => time);
    await tools.configure({ action: 'add', id: 'api', name: 'API', command: 'node api.js', port: 8787 });
    await expect(tools.configure({ action: 'add', id: 'api', name: 'API', command: 'x' })).rejects.toThrow(/already exists/);

    await tools.configure({ action: 'edit', id: 'api', command: 'node api.js --watch', port: null });
    expect(JSON.parse(configText!).targets).toEqual([{ id: 'api', name: 'API', command: 'node api.js --watch' }]);
    await expect(tools.configure({ action: 'edit', id: 'ghost', name: 'x' })).rejects.toThrow(/No run target/);

    await tools.configure({ action: 'remove', id: 'api' });
    expect(JSON.parse(configText!).targets).toEqual([]);
  });

  it('builds an edited target from only the fields that were passed', () => {
    expect(
      targetFromConfigureParams(
        { id: 'web', url: 'http://localhost:4000' },
        { id: 'web', name: 'Web', command: 'vite', port: 4000 }
      )
    ).toEqual({ id: 'web', name: 'Web', command: 'vite', port: 4000, url: 'http://localhost:4000' });
  });
});
