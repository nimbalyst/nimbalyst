// @vitest-environment node
/**
 * Host side of `ctx.services.terminals`: a module's command terminals are
 * scoped to its own extension and workspace, their output and exit reach the
 * owning module, and they are stopped (process group, not just the shell) when
 * the module goes away, the tab is closed, or the app quits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../utils/workspaceIdentity', () => ({
  sameWorkspaceIdentity: (a: string, b: string) => a === b,
}));

import {
  _resetBackendTerminals,
  commandShellInvocation,
  dispatchBackendTerminalsOp,
  installBackendTerminalsHost,
  setBackendTerminalEventSink,
  resumeBackendTerminalsAfterAbortedQuit,
  stopAllBackendTerminals,
  stopBackendTerminalsForModule,
  stopCommandTerminalForTabClose,
  withLiveCommandTerminalStatus,
} from '../backendTerminals';
import type { ProcessTerminalOptions } from '../../services/TerminalSessionManager';
import type { TerminalInstance, WorkspaceTerminalState } from '../../utils/terminalStore';

let workspace: string;
let nextPid: number;
let nextId: number;

/** Live process groups by pid, and every signal sent to a group. */
const groups = new Map<number, { ignoresTerm: boolean; ignoresKill?: boolean }>();
/** When set, the PTY spawn waits for it: a create that is still in flight. */
let holdSpawn: Promise<void> | null = null;
/** When set, the next command's shell exits before the spawn returns its pid, leaving its group alive. */
let exitDuringSpawn = false;
/** Called when a held spawn has been reached. */
let onSpawnHeld: (() => void) | null = null;

/** Hold the next PTY spawn. `reached` resolves once a create is waiting in it. */
function holdNextSpawn(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  holdSpawn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    onSpawnHeld = resolve;
  });
  return { reached, release };
}
const signals: Array<[number, string | number]> = [];
const spawned = new Map<string, { pid: number; options: ProcessTerminalOptions; buffer: string }>();
const states = new Map<string, WorkspaceTerminalState>();
const broadcasts: Array<{ channel: string; payload: unknown }> = [];
const events: Array<{ owner: string; event: string; payload: any }> = [];

function stateFor(ws: string): WorkspaceTerminalState {
  let state = states.get(ws);
  if (!state) states.set(ws, (state = { terminals: {}, tabOrder: [] }));
  return state;
}

function esrch(): Error {
  return Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
}

/**
 * The PTY child exits: what node-pty's onExit does in the real manager. The
 * rest of its process group goes with it unless `leavesGroup` is set (the
 * shell exited but something it started is still running).
 */
function exitPty(terminalId: string, exitCode: number, signal?: number, leavesGroup = false): void {
  const entry = spawned.get(terminalId);
  if (!entry) return;
  if (!leavesGroup) groups.delete(entry.pid);
  // The scrollback is still readable while the exit is being handled.
  entry.options.onExit?.(exitCode, signal);
  spawned.delete(terminalId);
}

function install(): void {
  let now = 0;
  installBackendTerminalsHost({
    manager: {
      createProcessTerminal: async (terminalId, options) => {
        if (holdSpawn) {
          onSpawnHeld?.();
          await holdSpawn;
        }
        const pid = nextPid++;
        spawned.set(terminalId, { pid, options, buffer: '' });
        groups.set(pid, { ignoresTerm: false });
        if (exitDuringSpawn) {
          exitDuringSpawn = false;
          options.onExit?.(0);
        }
        return pid;
      },
      getOutputState: (terminalId) => {
        const entry = spawned.get(terminalId);
        return entry ? { buffer: entry.buffer, base: 0 } : null;
      },
      isTerminalActive: (terminalId) => spawned.has(terminalId),
      destroyTerminal: async (terminalId) => {
        spawned.delete(terminalId);
      },
    },
    store: {
      getWorkspaceTerminalState: (ws) => structuredClone(stateFor(ws)),
      insertTerminalInstance: (ws, terminal, index) => {
        const state = stateFor(ws);
        state.terminals[terminal.id] = terminal;
        if (index === undefined || index >= state.tabOrder.length) state.tabOrder.push(terminal.id);
        else state.tabOrder.splice(index, 0, terminal.id);
        return terminal;
      },
      updateTerminalInstance: (ws, id, updates) => {
        const state = stateFor(ws);
        if (!state.terminals[id]) return undefined;
        state.terminals[id] = { ...state.terminals[id], ...updates, id } as TerminalInstance;
        return state.terminals[id];
      },
      deleteTerminalInstance: (ws, id) => {
        const state = stateFor(ws);
        delete state.terminals[id];
        state.tabOrder = state.tabOrder.filter((t) => t !== id);
      },
      setActiveTerminal: (ws, id) => {
        stateFor(ws).activeTerminalId = id;
      },
    },
    baseEnv: () => ({ SHELL: '/bin/zsh', PATH: '/usr/bin' }),
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    platform: 'darwin',
    newId: () => `term-${nextId++}`,
    processGroup: {
      platform: 'darwin',
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      kill: (target, signal) => {
        const pid = Math.abs(target);
        const group = groups.get(pid);
        if (!group) throw esrch();
        signals.push([target, signal]);
        if ((signal === 'SIGKILL' && !group.ignoresKill) || (signal === 'SIGTERM' && !group.ignoresTerm)) {
          groups.delete(pid);
          // The shell dies with its group.
          for (const [terminalId, entry] of [...spawned]) {
            if (entry.pid === pid) exitPty(terminalId, 0, signal === 'SIGKILL' ? 9 : 15);
          }
        }
        return true;
      },
    },
  });
  setBackendTerminalEventSink((owner, event, payload) =>
    events.push({ owner: `${owner.extensionId}/${owner.moduleId}@${owner.workspacePath}`, event, payload })
  );
}

const owner = () => ({ extensionId: 'com.example.runs', moduleId: 'core', workspacePath: workspace });
const other = () => ({ extensionId: 'com.example.other', moduleId: 'core', workspacePath: workspace });

async function start(key = 'web', extra: Record<string, unknown> = {}) {
  return (await dispatchBackendTerminalsOp(owner(), 'create', {
    key,
    title: 'Web dev server',
    command: 'pnpm run dev',
    ...extra,
  })) as { terminalId: string; pid: number };
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backend-terminals-')));
  fs.mkdirSync(path.join(workspace, 'packages', 'web'), { recursive: true });
  nextPid = 5000;
  nextId = 1;
  holdSpawn = null;
  exitDuringSpawn = false;
  onSpawnHeld = null;
  groups.clear();
  signals.length = 0;
  spawned.clear();
  states.clear();
  broadcasts.length = 0;
  events.length = 0;
  _resetBackendTerminals();
  install();
});

afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

describe('create', () => {
  it('runs the command through the login shell in the resolved cwd and adds a pinned command tab', async () => {
    const { terminalId, pid } = await start('web', {
      cwd: 'packages/web',
      env: { NODE_ENV: 'development' },
      pinned: true,
      panelId: 'runs',
    });
    const { options } = spawned.get(terminalId)!;
    expect(pid).toBe(5000);
    expect(options.executable).toBe('/bin/zsh');
    expect(options.args).toEqual(['-lc', 'pnpm run dev']);
    expect(options.cwd).toBe(path.join(workspace, 'packages', 'web'));
    expect(options.env).toMatchObject({ PATH: '/usr/bin', NODE_ENV: 'development' });
    expect(stateFor(workspace).terminals[terminalId]).toMatchObject({
      title: 'Web dev server',
      kind: 'command',
      pinned: true,
      command: 'pnpm run dev',
      owner: { extensionId: 'com.example.runs', key: 'web', panelId: 'com.example.runs.runs' },
    });
    expect(broadcasts.at(-1)).toEqual({ channel: 'terminal:list-changed', payload: { workspacePath: workspace } });
  });

  it('rejects a cwd outside the project and leaves no tab behind', async () => {
    await expect(start('web', { cwd: '../elsewhere' })).rejects.toThrow(/inside the project/);
    await expect(start('web', { cwd: 'missing-dir' })).rejects.toThrow(/does not exist/);
    expect(stateFor(workspace).tabOrder).toEqual([]);
    expect(spawned.size).toBe(0);
  });

  it('rejects a cwd that is a link inside the project to a folder outside it', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backend-terminals-outside-')));
    try {
      fs.symlinkSync(outside, path.join(workspace, 'linked-folder'), 'dir');
      await expect(start('web', { cwd: 'linked-folder' })).rejects.toThrow(/inside the project/);
      expect(spawned.size).toBe(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to start a key that is still running', async () => {
    await start('web');
    await expect(start('web')).rejects.toThrow(/still running/);
    expect(spawned.size).toBe(1);
  });

  it('replaces the previous tab of a stopped key in the same tab position', async () => {
    const first = await start('web');
    await start('worker');
    exitPty(first.terminalId, 1);
    groups.delete(first.pid);

    const second = await start('web');
    expect(second.terminalId).not.toBe(first.terminalId);
    const state = stateFor(workspace);
    expect(state.terminals[first.terminalId]).toBeUndefined();
    expect(state.tabOrder[0]).toBe(second.terminalId);
    expect(state.tabOrder).toHaveLength(2);
  });
});

describe('output and exit events', () => {
  it('delivers output with a running cursor and the exit code to the owning module only', async () => {
    const { terminalId } = await start();
    const { options } = spawned.get(terminalId)!;
    options.onData?.('ready\r\n');
    options.onData?.('GET /\r\n');
    exitPty(terminalId, 1);

    const scope = `com.example.runs/core@${workspace}`;
    expect(events).toEqual([
      { owner: scope, event: 'terminals:output', payload: { terminalId, data: 'ready\r\n', cursor: 7 } },
      { owner: scope, event: 'terminals:output', payload: { terminalId, data: 'GET /\r\n', cursor: 14 } },
      { owner: scope, event: 'terminals:exit', payload: { terminalId, exitCode: 1 } },
    ]);
  });

  it('reports the signal that ended the command', async () => {
    const { terminalId } = await start();
    await dispatchBackendTerminalsOp(owner(), 'kill', { terminalId, signal: 'SIGTERM' });
    expect(events.at(-1)).toMatchObject({
      event: 'terminals:exit',
      payload: { terminalId, exitCode: 0, signal: 15 },
    });
  });

  it('keeps the log readable after the process has exited', async () => {
    const { terminalId } = await start();
    spawned.get(terminalId)!.buffer = '\x1b[31mError: port in use\x1b[0m\r\n';
    exitPty(terminalId, 1);
    const result = await dispatchBackendTerminalsOp(owner(), 'read', { terminalId, tail: 10 });
    expect(result).toMatchObject({ text: 'Error: port in use', gap: false });
  });
});

describe('ownership', () => {
  it('rejects every op on a terminal from another extension or workspace', async () => {
    const { terminalId } = await start();
    for (const op of ['kill', 'stop', 'read', 'reveal', 'setStatus', 'dispose']) {
      await expect(dispatchBackendTerminalsOp(other(), op, { terminalId })).rejects.toThrow(/Unknown terminal/);
      await expect(
        dispatchBackendTerminalsOp({ ...owner(), workspacePath: '/another/project' }, op, { terminalId })
      ).rejects.toThrow(/Unknown terminal/);
    }
    expect(signals).toEqual([]);
    expect(spawned.has(terminalId)).toBe(true);
  });
});

describe('stopping', () => {
  it('stop signals the process group and reports it gone', async () => {
    const { terminalId, pid } = await start();
    const result = await dispatchBackendTerminalsOp(owner(), 'stop', { terminalId });
    expect(result).toEqual({ escalated: false, groupGone: true });
    expect(signals.filter(([, s]) => s !== 0)).toEqual([[-pid, 'SIGTERM']]);
  });

  it('stop escalates to SIGKILL for a group that ignores SIGTERM', async () => {
    const { terminalId, pid } = await start();
    groups.get(pid)!.ignoresTerm = true;
    const result = await dispatchBackendTerminalsOp(owner(), 'stop', { terminalId, graceMs: 500 });
    expect(result).toEqual({ escalated: true, groupGone: true });
    expect(signals.filter(([, s]) => s !== 0).map(([, s]) => s)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('never signals a pid again once its group has been seen gone', async () => {
    const { terminalId, pid } = await start();
    await dispatchBackendTerminalsOp(owner(), 'stop', { terminalId });
    // The pid is reused by an unrelated process.
    groups.set(pid, { ignoresTerm: false });
    signals.length = 0;
    await dispatchBackendTerminalsOp(owner(), 'kill', { terminalId, signal: 'SIGKILL' });
    await dispatchBackendTerminalsOp(owner(), 'stop', { terminalId });
    expect(signals).toEqual([]);
    expect(groups.has(pid)).toBe(true);
  });

  it('stops only the stopped module\'s commands and keeps their tabs without a status dot', async () => {
    const mine = await start('web');
    await dispatchBackendTerminalsOp(owner(), 'setStatus', { terminalId: mine.terminalId, tone: 'success' });
    const theirs = (await dispatchBackendTerminalsOp(other(), 'create', {
      key: 'sim',
      title: 'Simulator',
      command: 'xcrun simctl boot',
    })) as { terminalId: string; pid: number };

    await stopBackendTerminalsForModule('com.example.runs', 'core', workspace);

    expect(groups.has(mine.pid)).toBe(false);
    expect(groups.has(theirs.pid)).toBe(true);
    const tab = stateFor(workspace).terminals[mine.terminalId];
    expect(tab).toBeDefined();
    expect(tab.statusTone).toBeUndefined();
    // The module is gone, so its handle no longer resolves.
    await expect(dispatchBackendTerminalsOp(owner(), 'read', { terminalId: mine.terminalId })).rejects.toThrow(
      /Unknown terminal/
    );
  });

  // A terminal is only tracked once its process exists. A module that stops
  // while one is being spawned must not leave that process behind.
  it('stops a command whose spawn finishes after its module was stopped', async () => {
    const { reached, release } = holdNextSpawn();
    const creating = start('web');
    creating.catch(() => {});
    await reached;

    let stopped = false;
    const stopping = stopBackendTerminalsForModule('com.example.runs', 'core', workspace).then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    release();
    await expect(creating).rejects.toThrow(/stopped while the command was starting/);
    await stopping;
    expect(signals.filter(([, s]) => s !== 0)).toEqual([[-5000, 'SIGTERM']]);
    expect(groups.size).toBe(0);
  });

  it('stops a command still being spawned at app quit, and starts nothing after that', async () => {
    const { reached, release } = holdNextSpawn();
    const creating = start('web');
    creating.catch(() => {});
    await reached;

    const quitting = stopAllBackendTerminals();
    release();
    await quitting;
    await expect(creating).rejects.toThrow(/stopped while the command was starting/);
    expect(signals.filter(([, s]) => s !== 0)).toEqual([[-5000, 'SIGTERM']]);
    expect(groups.size).toBe(0);

    holdSpawn = null;
    await expect(start('worker')).rejects.toThrow(/quitting/);
    expect(spawned.size).toBe(0);
  });

  // Quit starts the stop early and awaits it again before PTYs are destroyed.
  it('signals each command once when the stop at quit is asked for twice', async () => {
    const { pid } = await start();
    await Promise.all([stopAllBackendTerminals(), stopAllBackendTerminals()]);
    await stopAllBackendTerminals();
    expect(signals.filter(([, s]) => s !== 0)).toEqual([[-pid, 'SIGTERM']]);
  });

  it('starts commands again after a quit that did not go through', async () => {
    await stopAllBackendTerminals();
    await expect(start('web')).rejects.toThrow(/quitting/);
    resumeBackendTerminalsAfterAbortedQuit();
    const { pid } = await start('web');
    await stopAllBackendTerminals();
    expect(groups.has(pid)).toBe(false);
  });

  // `sh -lc 'server & exit'`: the shell is gone, the server still holds the port.
  it('stops what a command left running in its process group after its shell exited', async () => {
    const { terminalId, pid } = await start();
    exitPty(terminalId, 0, undefined, true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(signals.filter(([, s]) => s !== 0)).toEqual([[-pid, 'SIGTERM']]);
    expect(groups.has(pid)).toBe(false);
  });

  it('stops what a command left running when its shell exited before the spawn returned', async () => {
    exitDuringSpawn = true;
    const { pid } = await start();
    await new Promise((resolve) => setImmediate(resolve));
    expect(signals.filter(([, s]) => s !== 0)).toEqual([[-pid, 'SIGTERM']]);
    expect(groups.has(pid)).toBe(false);
  });

  it('keeps a group that survived SIGKILL on the books so the stop at quit tries again', async () => {
    const { terminalId, pid } = await start();
    groups.set(pid, { ignoresTerm: true, ignoresKill: true });
    expect(await stopCommandTerminalForTabClose(terminalId)).toBe(true);
    expect(groups.has(pid)).toBe(true);

    groups.set(pid, { ignoresTerm: false });
    signals.length = 0;
    await stopAllBackendTerminals();
    expect(signals.filter(([, s]) => s !== 0)).toEqual([[-pid, 'SIGTERM']]);
    expect(groups.has(pid)).toBe(false);
  });

  it('stops every command on app quit', async () => {
    const a = await start('web');
    const b = await start('worker');
    await stopAllBackendTerminals();
    expect(groups.has(a.pid)).toBe(false);
    expect(groups.has(b.pid)).toBe(false);
  });

  it('closing the tab stops the command; an ordinary terminal is left to the caller', async () => {
    const { terminalId, pid } = await start();
    expect(await stopCommandTerminalForTabClose(terminalId)).toBe(true);
    expect(groups.has(pid)).toBe(false);
    expect(await stopCommandTerminalForTabClose('a-shell-terminal')).toBe(false);
  });
});

describe('withLiveCommandTerminalStatus', () => {
  it('drops the status dot of a command tab whose owner is not running', async () => {
    const { terminalId } = await start();
    await dispatchBackendTerminalsOp(owner(), 'setStatus', { terminalId, tone: 'success' });
    const stale: TerminalInstance = {
      ...stateFor(workspace).terminals[terminalId],
      id: 'from-last-launch',
      statusTone: 'success',
    };
    const state: WorkspaceTerminalState = {
      terminals: { ...stateFor(workspace).terminals, [stale.id]: stale },
      tabOrder: [terminalId, stale.id],
    };
    const result = withLiveCommandTerminalStatus(state);
    expect(result.terminals[terminalId].statusTone).toBe('success');
    expect(result.terminals[stale.id].statusTone).toBeUndefined();
  });
});

describe('commandShellInvocation', () => {
  it('uses cmd.exe on Windows', () => {
    expect(commandShellInvocation('npm start', { ComSpec: 'C:\\Windows\\cmd.exe' }, 'win32')).toEqual({
      executable: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm start'],
    });
  });
});
