/**
 * Host side of `ctx.services.terminals` for backend modules.
 *
 * A backend module asks for a command terminal: one command, run in a PTY the
 * host owns, shown as a tab in the bottom terminal panel. The tab is the
 * command's log. The module follows output and exit through broker events and
 * signals the command's process group through the ops here.
 *
 * Ownership: every terminal is recorded with the extension, module and
 * workspace of the runtime that created it, taken from the host-derived
 * runtime context. Every op checks that record, so a module cannot read,
 * signal or close another extension's terminal, or one in another workspace.
 * When the owning module stops for any reason (extension disabled, project
 * closed, crash) the host stops its commands; on app quit it stops all of
 * them. The tabs stay, showing the saved output.
 *
 * This module deliberately imports neither `TerminalSessionManager` (which
 * loads node-pty at import time) nor the terminal store. `TerminalHandlers`
 * installs both through `installBackendTerminalsHost`, and
 * `extensionHostWiring` installs the event sink, so the broker dispatch and
 * its tests do not pull in a PTY.
 */
import * as path from 'path';
import * as fs from 'fs/promises';
import { ulid } from 'ulid';
import type {
  BackendTerminalReadResult,
  BackendTerminalStopResult,
} from '@nimbalyst/extension-sdk';
import { logger } from '../utils/logger';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import {
  PROCESS_GROUP_SIGNALS,
  isProcessGroupAlive,
  signalProcessGroup,
  stopProcessGroup,
  type ProcessGroupDeps,
  type ProcessGroupSignal,
} from '../services/processGroupStop';
import { readTerminalOutput, type TerminalOutputState } from '../services/terminalText';
import type { ProcessTerminalOptions } from '../services/TerminalSessionManager';
import type {
  TerminalInstance,
  TerminalStatusTone,
  WorkspaceTerminalState,
} from '../utils/terminalStore';
import {
  TERMINALS_EXIT_EVENT,
  TERMINALS_OUTPUT_EVENT,
  type BackendRuntimeContext,
} from './extensionBackendRpc';

/** Renderer channels. */
export const TERMINAL_LIST_CHANGED_CHANNEL = 'terminal:list-changed';
export const TERMINAL_REVEAL_CHANNEL = 'terminal:reveal';

/** Grace period when the app is quitting: the quit sequence has a hard deadline. */
export const QUIT_STOP_GRACE_MS = 2000;

const STATUS_TONES: readonly TerminalStatusTone[] = ['success', 'warning', 'error'];
const MAX_COMMAND_LENGTH = 8192;

export interface BackendTerminalsHostDeps {
  manager: {
    createProcessTerminal: (terminalId: string, options: ProcessTerminalOptions) => Promise<number | undefined>;
    getOutputState: (terminalId: string) => TerminalOutputState | null;
    isTerminalActive: (terminalId: string) => boolean;
    destroyTerminal: (terminalId: string) => Promise<void>;
  };
  store: {
    getWorkspaceTerminalState: (workspacePath: string) => WorkspaceTerminalState;
    insertTerminalInstance: (workspacePath: string, terminal: TerminalInstance, index?: number) => TerminalInstance;
    updateTerminalInstance: (
      workspacePath: string,
      terminalId: string,
      updates: Partial<Omit<TerminalInstance, 'id'>>
    ) => TerminalInstance | undefined;
    deleteTerminalInstance: (workspacePath: string, terminalId: string) => void;
    setActiveTerminal: (workspacePath: string, terminalId: string | undefined) => void;
  };
  /** Environment for the command before the caller's `env` is applied. */
  baseEnv: () => NodeJS.ProcessEnv;
  /** Send to every window. */
  broadcast: (channel: string, payload: unknown) => void;
  processGroup?: ProcessGroupDeps;
  newId?: () => string;
  platform?: NodeJS.Platform;
}

/** Delivers a broker event to one module's runtime. Installed by extensionHostWiring. */
export type BackendTerminalEventSink = (
  owner: { extensionId: string; moduleId: string; workspacePath: string },
  event: string,
  payload: unknown
) => void;

interface OwnedTerminal {
  terminalId: string;
  extensionId: string;
  moduleId: string;
  workspacePath: string;
  key: string;
  pid: number;
  /** Code units of output so far; the cursor of the next chunk. */
  written: number;
  exited: boolean;
  exitCode?: number;
  /** Scrollback captured at exit, so the log stays readable after the PTY is gone. */
  finalOutput?: TerminalOutputState;
  /** The process group has been seen gone. Its pid may be reused; never signal it again. */
  groupGone: boolean;
  stopping?: Promise<BackendTerminalStopResult>;
}

type OwnerContext = Pick<BackendRuntimeContext, 'extensionId' | 'moduleId' | 'workspacePath'>;

/**
 * A `create` that has not produced a terminal yet. A terminal becomes `owned`
 * only once its process exists, so a module stop (or app quit) that happens
 * first would otherwise never see it. Cancelling the pending create makes it
 * stop its own terminal the moment it has one.
 */
interface PendingCreate {
  owner: OwnerContext;
  cancelled: boolean;
  /** Grace for the stop of a cancelled create. */
  graceMs?: number;
  /** Settles when the create has finished, cleanup of a cancelled one included. Never rejects. */
  done: Promise<void>;
}

let deps: BackendTerminalsHostDeps | null = null;
let eventSink: BackendTerminalEventSink | null = null;
const owned = new Map<string, OwnedTerminal>();
const pendingCreates = new Set<PendingCreate>();
/** The app is quitting: no new command may start. */
let shuttingDown = false;
let quitDrain: Promise<void> | null = null;

export function installBackendTerminalsHost(next: BackendTerminalsHostDeps | null): void {
  deps = next;
}

export function setBackendTerminalEventSink(sink: BackendTerminalEventSink | null): void {
  eventSink = sink;
}

function host(): BackendTerminalsHostDeps {
  if (!deps) throw new Error('The terminal service is not available yet');
  return deps;
}

function emit(record: OwnedTerminal, event: string, payload: unknown): void {
  try {
    eventSink?.(record, event, payload);
  } catch (error) {
    logger.main.warn(`[backendTerminals] ${event} delivery to ${record.extensionId} failed:`, error);
  }
}

function listChanged(workspacePath: string): void {
  host().broadcast(TERMINAL_LIST_CHANGED_CHANNEL, { workspacePath });
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

function requireOwned(ctx: OwnerContext, terminalId: unknown): OwnedTerminal {
  const id = requireString(terminalId, 'terminalId');
  const record = owned.get(id);
  // The same error for "no such terminal" and "someone else's terminal": a
  // module learns nothing about terminals it does not own.
  if (
    !record ||
    record.extensionId !== ctx.extensionId ||
    !sameWorkspaceIdentity(record.workspacePath, ctx.workspacePath)
  ) {
    throw new Error(`Unknown terminal: ${id}`);
  }
  return record;
}

async function resolveCwd(workspacePath: string, cwd: unknown): Promise<string> {
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('cwd must be a string');
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, cwd && cwd.length > 0 ? cwd : '.');
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`cwd must stay inside the project: ${String(cwd)}`);
  }
  let stat;
  let realCwd: string;
  try {
    stat = await fs.stat(resolved);
    realCwd = await fs.realpath(resolved);
  } catch {
    throw new Error(`cwd does not exist: ${String(cwd)}`);
  }
  if (!stat.isDirectory()) throw new Error(`cwd is not a directory: ${String(cwd)}`);
  // The lexical check above passes a symlink inside the project that points
  // out of it. Compare where the paths really lead.
  const realRoot = await fs.realpath(root);
  if (realCwd !== realRoot && !realCwd.startsWith(realRoot + path.sep)) {
    throw new Error(`cwd must stay inside the project: ${String(cwd)}`);
  }
  return resolved;
}

function resolveEnv(base: NodeJS.ProcessEnv, extra: unknown): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (extra === undefined || extra === null) return env;
  if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error('env must be an object of strings');
  for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`env.${name} must be a string`);
    env[name] = value;
  }
  return env;
}

/** How the command is handed to a shell so the user's PATH and profile apply. */
export function commandShellInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): { executable: string; args: string[] } {
  if (platform === 'win32') {
    return { executable: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { executable: env.SHELL || '/bin/sh', args: ['-lc', command] };
}

function groupAlive(record: OwnedTerminal): boolean {
  if (record.groupGone) return false;
  if (!isProcessGroupAlive(record.pid, host().processGroup)) {
    record.groupGone = true;
    return false;
  }
  return true;
}

const CREATE_CANCELLED = 'The extension stopped while the command was starting';

/**
 * The shell is gone. Anything it started that is still in its process group (a
 * backgrounded server, a child that ignored the hangup) has nothing left to
 * supervise it and may still hold the port, so it is stopped with the command.
 */
function stopLeftovers(record: OwnedTerminal): void {
  if (record.pid <= 1 || !groupAlive(record)) return;
  logger.main.warn(
    `[backendTerminals] "${record.key}" exited but processes it started are still running; stopping them`
  );
  void stopRecord(record, undefined).catch((error) =>
    logger.main.error(`[backendTerminals] failed to stop what "${record.key}" left behind:`, error)
  );
}

async function createCommandTerminal(
  ctx: OwnerContext,
  args: Record<string, unknown>,
  pending: PendingCreate
): Promise<{ terminalId: string; pid: number }> {
  const h = host();
  const key = requireString(args.key, 'key');
  const title = requireString(args.title, 'title');
  const command = requireString(args.command, 'command');
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('command is too long');
  if (args.panelId !== undefined && typeof args.panelId !== 'string') throw new Error('panelId must be a string');
  const cwd = await resolveCwd(ctx.workspacePath, args.cwd);
  if (pending.cancelled) throw new Error(CREATE_CANCELLED);
  const baseEnv = h.baseEnv();
  const env = resolveEnv(baseEnv, args.env);
  const platform = h.platform ?? process.platform;
  const { executable, args: shellArgs } = commandShellInvocation(command, baseEnv, platform);

  // A key has one tab. Replace the previous one so each start has an empty log.
  const state = h.store.getWorkspaceTerminalState(ctx.workspacePath);
  let tabIndex: number | undefined;
  for (const previous of Object.values(state.terminals)) {
    if (previous?.owner?.extensionId !== ctx.extensionId || previous.owner.key !== key) continue;
    const record = owned.get(previous.id);
    if (h.manager.isTerminalActive(previous.id) || (record && groupAlive(record))) {
      throw new Error(`"${key}" is still running; stop it before starting it again`);
    }
    const index = state.tabOrder.indexOf(previous.id);
    if (index >= 0 && tabIndex === undefined) tabIndex = index;
    h.store.deleteTerminalInstance(ctx.workspacePath, previous.id);
    owned.delete(previous.id);
  }

  const terminalId = (h.newId ?? ulid)();
  const now = Date.now();
  const record: OwnedTerminal = {
    terminalId,
    extensionId: ctx.extensionId,
    moduleId: ctx.moduleId,
    workspacePath: ctx.workspacePath,
    key,
    pid: 0,
    written: 0,
    exited: false,
    groupGone: false,
  };

  // The tab exists before the PTY so the manager's first state persist finds it.
  h.store.insertTerminalInstance(
    ctx.workspacePath,
    {
      id: terminalId,
      title,
      shellName: 'run',
      shellPath: executable,
      cwd,
      createdAt: now,
      lastActiveAt: now,
      kind: 'command',
      owner: {
        extensionId: ctx.extensionId,
        key,
        ...(typeof args.panelId === 'string' && args.panelId
          ? { panelId: `${ctx.extensionId}.${args.panelId}` }
          : {}),
      },
      pinned: args.pinned === true,
      command,
    },
    tabIndex
  );

  let pid: number | undefined;
  try {
    pid = await h.manager.createProcessTerminal(terminalId, {
      cwd,
      executable,
      args: shellArgs,
      env,
      shellName: 'run',
      provider: 'extension-command',
      workspacePath: ctx.workspacePath,
      onData: (data) => {
        record.written += data.length;
        emit(record, TERMINALS_OUTPUT_EVENT, { terminalId, data, cursor: record.written });
      },
      onExit: (exitCode, signal) => {
        if (record.exited) return;
        record.exited = true;
        record.exitCode = exitCode;
        record.finalOutput = h.manager.getOutputState(terminalId) ?? undefined;
        logger.main.info(
          `[backendTerminals] ${record.extensionId} "${record.key}" (${terminalId}) exited with code ${exitCode}` +
            (signal ? ` on signal ${signal}` : '')
        );
        emit(record, TERMINALS_EXIT_EVENT, { terminalId, exitCode, ...(signal ? { signal } : {}) });
        stopLeftovers(record);
      },
    });
  } catch (error) {
    h.store.deleteTerminalInstance(ctx.workspacePath, terminalId);
    listChanged(ctx.workspacePath);
    throw error;
  }
  if (typeof pid !== 'number' || pid <= 1) {
    h.store.deleteTerminalInstance(ctx.workspacePath, terminalId);
    listChanged(ctx.workspacePath);
    throw new Error('The command could not be started');
  }

  record.pid = pid;
  owned.set(terminalId, record);
  listChanged(ctx.workspacePath);
  // The shell can exit before its pid got here; the exit handler could not
  // check the group then.
  if (record.exited) stopLeftovers(record);
  if (pending.cancelled) {
    // The module stopped (or the app began quitting) while the process was
    // being spawned. Nothing else knows about this terminal yet: stop it here.
    logger.main.info(
      `[backendTerminals] ${ctx.extensionId} "${key}" (${terminalId}) pid ${pid} started after its owner stopped; stopping it`
    );
    await stopAndRelease(record, pending.graceMs);
    throw new Error(CREATE_CANCELLED);
  }
  logger.main.info(
    `[backendTerminals] ${ctx.extensionId} started "${key}" (${terminalId}) pid ${pid} in ${cwd}`
  );
  return { terminalId, pid };
}

function stopRecord(record: OwnedTerminal, graceMs: number | undefined): Promise<BackendTerminalStopResult> {
  if (record.stopping) return record.stopping;
  if (!groupAlive(record)) return Promise.resolve({ escalated: false, groupGone: true });
  const stopping = stopProcessGroup(record.pid, { graceMs }, host().processGroup)
    .then((result) => {
      if (result.groupGone) record.groupGone = true;
      else {
        logger.main.error(
          `[backendTerminals] process group ${record.pid} of "${record.key}" survived SIGKILL`
        );
      }
      if (result.escalated) {
        logger.main.warn(`[backendTerminals] "${record.key}" (pid ${record.pid}) needed SIGKILL to stop`);
      }
      return result;
    })
    .finally(() => {
      if (record.stopping === stopping) record.stopping = undefined;
    });
  record.stopping = stopping;
  return stopping;
}

function parseGraceMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('graceMs must be a non-negative number');
  }
  return Math.min(value, 60_000);
}

/** One `ctx.services.terminals` call from a backend module. */
export async function dispatchBackendTerminalsOp(
  ctx: OwnerContext,
  op: string,
  rawArgs: unknown
): Promise<unknown> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  switch (op) {
    case 'create': {
      if (shuttingDown) throw new Error('Nimbalyst is quitting; no command can be started');
      const pending: PendingCreate = { owner: ctx, cancelled: false, done: Promise.resolve() };
      const creating = createCommandTerminal(ctx, args, pending);
      pending.done = creating.then(
        () => {},
        () => {}
      );
      pendingCreates.add(pending);
      try {
        return await creating;
      } finally {
        pendingCreates.delete(pending);
      }
    }
    case 'kill': {
      const record = requireOwned(ctx, args.terminalId);
      const signal = (args.signal ?? 'SIGTERM') as ProcessGroupSignal;
      if (!PROCESS_GROUP_SIGNALS.includes(signal)) throw new Error(`Unsupported signal: ${String(args.signal)}`);
      if (groupAlive(record)) signalProcessGroup(record.pid, signal, host().processGroup);
      return {};
    }
    case 'stop': {
      const record = requireOwned(ctx, args.terminalId);
      return stopRecord(record, parseGraceMs(args.graceMs));
    }
    case 'read': {
      const record = requireOwned(ctx, args.terminalId);
      const state = host().manager.getOutputState(record.terminalId) ?? record.finalOutput ?? { buffer: '', base: 0 };
      const result: BackendTerminalReadResult = readTerminalOutput(state, {
        tail: typeof args.tail === 'number' ? args.tail : undefined,
        since: typeof args.since === 'number' ? args.since : undefined,
        maxChars: typeof args.maxChars === 'number' && args.maxChars > 0 ? args.maxChars : undefined,
      });
      return result;
    }
    case 'reveal': {
      const record = requireOwned(ctx, args.terminalId);
      host().store.setActiveTerminal(record.workspacePath, record.terminalId);
      host().broadcast(TERMINAL_REVEAL_CHANNEL, {
        workspacePath: record.workspacePath,
        terminalId: record.terminalId,
      });
      return {};
    }
    case 'setStatus': {
      const record = requireOwned(ctx, args.terminalId);
      const tone = args.tone ?? null;
      if (tone !== null && !STATUS_TONES.includes(tone as TerminalStatusTone)) {
        throw new Error(`Invalid status tone: ${String(tone)}`);
      }
      host().store.updateTerminalInstance(record.workspacePath, record.terminalId, {
        statusTone: (tone as TerminalStatusTone | null) ?? undefined,
      });
      listChanged(record.workspacePath);
      return {};
    }
    case 'dispose': {
      const record = requireOwned(ctx, args.terminalId);
      const stopped = await stopRecord(record, undefined);
      if (!stopped.groupGone) {
        throw new Error(`"${record.key}" still has running processes after SIGKILL; its tab was kept`);
      }
      if (host().manager.isTerminalActive(record.terminalId)) {
        await host().manager.destroyTerminal(record.terminalId);
      }
      host().store.deleteTerminalInstance(record.workspacePath, record.terminalId);
      owned.delete(record.terminalId);
      listChanged(record.workspacePath);
      return {};
    }
    default:
      throw new Error(`Unknown terminals op: ${op}`);
  }
}

async function stopAndRelease(record: OwnedTerminal, graceMs: number | undefined): Promise<void> {
  let groupGone = false;
  try {
    groupGone = (await stopRecord(record, graceMs)).groupGone;
  } catch (error) {
    logger.main.error(`[backendTerminals] failed to stop "${record.key}" (pid ${record.pid}):`, error);
  }
  // A group that survived stays on the books: forgetting it would leave
  // nothing able to stop it later (a retry, or the stop at app quit).
  if (groupGone) owned.delete(record.terminalId);
  try {
    // The owner that kept this dot current is gone.
    host().store.updateTerminalInstance(record.workspacePath, record.terminalId, { statusTone: undefined });
  } catch (error) {
    logger.main.warn(`[backendTerminals] failed to clear tab status for ${record.terminalId}:`, error);
  }
}

/**
 * Stop every command a module started in a workspace. Called when the module
 * stops or crashes: nothing is left to supervise the commands. The tabs stay.
 */
export async function stopBackendTerminalsForModule(
  extensionId: string,
  moduleId: string,
  workspacePath: string
): Promise<void> {
  const ownedBy = (r: OwnerContext) =>
    r.extensionId === extensionId && r.moduleId === moduleId && sameWorkspaceIdentity(r.workspacePath, workspacePath);
  // Commands still being spawned are not in `owned` yet. Cancel them and wait:
  // each stops its own terminal once the process exists.
  const starting = [...pendingCreates].filter((pending) => ownedBy(pending.owner));
  for (const pending of starting) pending.cancelled = true;
  await Promise.all(starting.map((pending) => pending.done));

  const records = [...owned.values()].filter(ownedBy);
  if (records.length === 0) return;
  logger.main.info(
    `[backendTerminals] stopping ${records.length} command(s) of ${extensionId}/${moduleId} in ${workspacePath}`
  );
  await Promise.all(records.map((record) => stopAndRelease(record, undefined)));
  if (deps) listChanged(workspacePath);
}

/**
 * Stop every extension-owned command and refuse new ones. Called on every path
 * that ends the process (quit, restart, update install) before PTYs are
 * destroyed. The first call does the work; later calls return the same
 * promise, so a path can start the stop early and await it again later
 * without paying the grace period twice.
 */
export function stopAllBackendTerminals(options: { graceMs?: number } = {}): Promise<void> {
  quitDrain ??= drainForQuit(options.graceMs ?? QUIT_STOP_GRACE_MS);
  return quitDrain;
}

async function drainForQuit(graceMs: number): Promise<void> {
  shuttingDown = true;
  const starting = [...pendingCreates];
  for (const pending of starting) {
    pending.cancelled = true;
    pending.graceMs = graceMs;
  }
  const records = [...owned.values()];
  if (records.length + starting.length > 0) {
    logger.main.info(
      `[backendTerminals] stopping ${records.length} command(s) for app quit` +
        (starting.length > 0 ? ` and ${starting.length} still starting` : '')
    );
  }
  await Promise.all([
    ...records.map((record) => stopAndRelease(record, graceMs)),
    ...starting.map((pending) => pending.done),
  ]);
}

/**
 * The quit, restart or update that called `stopAllBackendTerminals` did not
 * go through and the app is staying open. Commands that were stopped stay
 * stopped; this only lets new ones start again.
 */
export function resumeBackendTerminalsAfterAbortedQuit(): void {
  shuttingDown = false;
  quitDrain = null;
}

/**
 * The user closed a command terminal's tab: stop the command first so closing
 * the tab cannot leave its process group running. Returns false when the
 * terminal is not a live extension command (the caller closes it as usual).
 */
export async function stopCommandTerminalForTabClose(terminalId: string): Promise<boolean> {
  const record = owned.get(terminalId);
  if (!record) return false;
  const result = await stopRecord(record, undefined);
  // Kept when something survived, so the stop at app quit tries again.
  if (result.groupGone) owned.delete(terminalId);
  return true;
}

/**
 * A status dot is only true while its owner is alive to maintain it. Strip
 * dots from command tabs with no live owner (the app was restarted, or the
 * extension stopped) before the tab list reaches a window.
 */
export function withLiveCommandTerminalStatus(state: WorkspaceTerminalState): WorkspaceTerminalState {
  let terminals = state.terminals;
  for (const [id, terminal] of Object.entries(state.terminals)) {
    if (!terminal?.statusTone || owned.has(id)) continue;
    if (terminals === state.terminals) terminals = { ...state.terminals };
    const { statusTone: _stale, ...rest } = terminal;
    terminals[id] = rest;
  }
  return terminals === state.terminals ? state : { ...state, terminals };
}

/** Test-only. */
export function _resetBackendTerminals(): void {
  owned.clear();
  pendingCreates.clear();
  shuttingDown = false;
  quitDrain = null;
  deps = null;
  eventSink = null;
}
