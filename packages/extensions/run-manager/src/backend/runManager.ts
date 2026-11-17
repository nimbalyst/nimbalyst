/**
 * The run supervisor for one project: which targets exist, what state each is
 * in, and the start / stop / restart / logs operations behind both the panel
 * and the agent tools.
 *
 * A run is a command terminal from `ctx.services.terminals`. The host owns the
 * PTY, the tab and the log; this class owns only the status of each target and
 * decides when a starting target has become ready. It never spawns a process
 * itself, so it cannot leak one: when this module stops, the host stops every
 * terminal it created.
 *
 * Everything that touches the machine is injected (`RunManagerDeps`), so the
 * behavior is tested with fake terminals and no real processes.
 */
import type {
  BackendCommandTerminal,
  BackendTerminalReadOptions,
  BackendTerminalReadResult,
  BackendTerminalsService,
} from '@nimbalyst/extension-sdk';
import {
  RUNS_PANEL_ID,
  RUN_CONFIG_PATH,
  targetUrl,
  type RunStatus,
  type RunTarget,
  type RunView,
  type RunsSnapshot,
} from '../shared/types';
import { parseRunConfig, removeTarget, upsertTarget } from './runConfig';
import { isLive, nextStatus } from './runStatus';
import { suggestTargets, type PackageManager } from './suggestions';

/** Decision (2026-11-09): SIGTERM to the process group, SIGKILL after 5 s. */
export const STOP_GRACE_MS = 5000;
export const DEFAULT_READY_TIMEOUT_MS = 30_000;
export const MAX_READY_TIMEOUT_MS = 120_000;
/** Log lines returned with a start that did not come up. */
export const FAILURE_LOG_LINES = 40;

const PORT_PROBE_INTERVAL_MS = 400;
const OUTPUT_WINDOW_CHARS = 4000;
// Enough ANSI stripping to match a readiness pattern against colored output.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RunManagerDeps {
  terminals: BackendTerminalsService;
  /** `.nimbalyst/run.json`. `read` resolves null when the file does not exist. */
  config: {
    read: () => Promise<string | null>;
    write: (text: string) => Promise<void>;
  };
  /** The project's root `package.json` and package manager, for suggestions. */
  readPackageInfo: () => Promise<{ packageJson: string | null; packageManager: PackageManager }>;
  isPortOpen: (port: number) => Promise<boolean>;
  findListenerPid: (port: number) => Promise<number | undefined>;
  /**
   * SIGTERM, then SIGKILL after the grace period unless `stillTarget` says the
   * pid is no longer the process the user agreed to stop. Resolves whether the
   * pid is gone.
   */
  stopExternalProcess: (pid: number, stillTarget: () => Promise<boolean>) => Promise<boolean>;
  log: (level: LogLevel, message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after any status change, so the gutter badge can follow. */
  onChange?: () => void;
}

interface RunRecord {
  /** Never `external`: that is derived when the target is viewed. */
  status: Exclude<RunStatus, 'external'>;
  terminal?: BackendCommandTerminal;
  /** Bumped on every start; callbacks from an earlier start are ignored. */
  generation: number;
  startedAt?: number;
  exitCode?: number;
  error?: string;
  externalPid?: number;
  outputWindow: string;
  stopping?: Promise<void>;
  /**
   * Set from the moment a start is accepted until its terminal handle exists
   * (or the spawn failed, or a cancelled spawn has been stopped). Never rejects.
   */
  spawning?: Promise<void>;
  /** A start is past its checks but has not marked the target `starting` yet. */
  preparing?: boolean;
  /** Resolved when the current start leaves `starting`. */
  settleWaiters: Array<() => void>;
}

export interface StartOptions {
  /** Resolve only once the target is ready, has failed, or `timeoutMs` passed. */
  waitForReady?: boolean;
  timeoutMs?: number;
}

export interface StartResult {
  run: RunView;
  /** Status before this call. */
  previousStatus: RunStatus;
  /** `waitForReady` gave up while the target was still starting. */
  timedOut?: boolean;
  /** Last log lines, present when the target did not come up. */
  logs?: string;
}

export interface LogsResult extends BackendTerminalReadResult {
  id: string;
  status: RunStatus;
}

export class RunManager {
  private targets: RunTarget[] = [];
  private configExists = false;
  private configErrors: string[] = [];
  private readonly records = new Map<string, RunRecord>();
  private disposed = false;
  private loading: Promise<void> | null = null;
  private configEdits: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RunManagerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))))(ms);
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // A badge update must never break a run operation.
    }
  }

  private record(id: string): RunRecord {
    let record = this.records.get(id);
    if (!record) {
      record = { status: 'stopped', generation: 0, outputWindow: '', settleWaiters: [] };
      this.records.set(id, record);
    }
    return record;
  }

  private requireTarget(id: unknown): RunTarget {
    if (typeof id !== 'string' || id === '') throw new Error('A run target id is required');
    const target = this.targets.find((t) => t.id === id);
    if (!target) {
      const known = this.targets.map((t) => t.id);
      throw new Error(
        known.length > 0
          ? `No run target with id "${id}". Configured targets: ${known.join(', ')}.`
          : `No run target with id "${id}". ${RUN_CONFIG_PATH} defines no targets.`
      );
    }
    return target;
  }

  // ─── Config ──────────────────────────────────────────────────────────────

  /** Read `.nimbalyst/run.json`. Runs whose target was removed from the file are stopped. */
  reloadConfig(): Promise<void> {
    if (this.loading) return this.loading;
    const loading = (async () => {
      const text = await this.deps.config.read();
      this.configExists = text !== null;
      if (text === null) {
        this.targets = [];
        this.configErrors = [];
      } else {
        const parsed = parseRunConfig(text);
        // An unreadable file keeps the targets already loaded: a half-typed
        // edit must not take running targets out of the list.
        if (!parsed.fatal) this.targets = parsed.targets;
        this.configErrors = parsed.errors;
      }
      const ids = new Set(this.targets.map((t) => t.id));
      for (const [id, record] of this.records) {
        if (ids.has(id)) continue;
        if (isLive(record.status)) {
          this.deps.log('info', `[run] "${id}" was removed from ${RUN_CONFIG_PATH}; stopping it`);
          void this.stopRecord(id, record).catch((error) =>
            this.deps.log('error', `[run] failed to stop removed target "${id}": ${String(error)}`)
          );
        } else {
          this.records.delete(id);
        }
      }
      this.changed();
    })().finally(() => {
      if (this.loading === loading) this.loading = null;
    });
    this.loading = loading;
    return loading;
  }

  /**
   * One edit at a time: each reads the file, changes it and writes it back, so
   * two running together would each write a file without the other's change.
   */
  private editConfig(edit: (text: string | null) => string): Promise<void> {
    const run = async () => {
      await this.deps.config.write(edit(await this.deps.config.read()));
      await this.reloadConfig();
    };
    const result = this.configEdits.then(run, run);
    this.configEdits = result.catch(() => {});
    return result;
  }

  async saveTarget(target: RunTarget, replaceId?: string): Promise<void> {
    if (replaceId && replaceId !== target.id && isLive(this.record(replaceId).status)) {
      throw new Error(`Stop "${replaceId}" before changing its id`);
    }
    await this.editConfig((text) => upsertTarget(text, target, replaceId));
  }

  async removeTarget(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record && isLive(record.status)) await this.stopRecord(id, record);
    await this.editConfig((text) => removeTarget(text, id));
  }

  // ─── Views ───────────────────────────────────────────────────────────────

  private view(target: RunTarget): RunView {
    const record = this.record(target.id);
    const live = isLive(record.status);
    const external = !live && record.externalPid !== undefined;
    const view: RunView = {
      target,
      status: external ? 'external' : record.status,
      hasLogs: record.terminal !== undefined,
    };
    if (record.terminal) view.terminalId = record.terminal.id;
    const url = targetUrl(target);
    if (url) view.url = url;
    if (live && record.terminal) view.pid = record.terminal.pid;
    if (external) view.externalPid = record.externalPid;
    if (record.startedAt !== undefined && (record.status === 'starting' || record.status === 'running')) {
      view.startedAt = record.startedAt;
    }
    if (record.exitCode !== undefined && !live) view.exitCode = record.exitCode;
    if (record.status === 'starting') {
      if (target.port) view.waitingFor = `port ${target.port}`;
      else if (target.readyPattern) view.waitingFor = `"${target.readyPattern}"`;
    }
    if (record.error) view.error = record.error;
    return view;
  }

  /** Current statuses without looking at the machine. Used for the badge. */
  views(): RunView[] {
    return this.targets.map((target) => this.view(target));
  }

  /** For a target this app is not running: is something else holding its port? */
  private async detectExternal(target: RunTarget): Promise<void> {
    const record = this.record(target.id);
    if (!target.port || isLive(record.status)) {
      record.externalPid = undefined;
      return;
    }
    const generation = record.generation;
    let pid: number | undefined;
    if (await this.deps.isPortOpen(target.port)) {
      // 0 stands for "bound, owner unknown" when lsof cannot name the process.
      pid = (await this.deps.findListenerPid(target.port)) ?? 0;
    }
    // The target may have been started while the probe was in flight.
    if (record.generation === generation && !isLive(record.status)) record.externalPid = pid;
  }

  async snapshot(): Promise<RunsSnapshot> {
    await Promise.all(this.targets.map((target) => this.detectExternal(target)));
    let suggestions: RunTarget[] = [];
    if (this.targets.length === 0 && !this.configExists) {
      try {
        const info = await this.deps.readPackageInfo();
        suggestions = suggestTargets(info.packageJson, info.packageManager);
      } catch (error) {
        this.deps.log('warn', `[run] could not read package.json for suggestions: ${String(error)}`);
      }
    }
    return {
      configPath: RUN_CONFIG_PATH,
      configExists: this.configExists,
      configErrors: [...this.configErrors],
      runs: this.views(),
      suggestions,
    };
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  private settle(record: RunRecord): void {
    const waiters = record.settleWaiters;
    record.settleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private setTabStatus(record: RunRecord): void {
    const tone =
      record.status === 'running'
        ? 'success'
        : record.status === 'crashed'
          ? 'error'
          : record.status === 'starting' || record.status === 'stopping'
            ? 'warning'
            : null;
    void record.terminal?.setStatus(tone).catch(() => {
      // The tab may already be gone (closed by the user, or replaced by a restart).
    });
  }

  private markReady(id: string, generation: number): void {
    const record = this.record(id);
    if (record.generation !== generation || record.status !== 'starting') return;
    record.status = nextStatus(record.status, { type: 'ready' }) as RunRecord['status'];
    this.deps.log('info', `[run] "${id}" is ready`);
    this.setTabStatus(record);
    this.settle(record);
    this.changed();
  }

  private handleExit(id: string, generation: number, exitCode: number, signal?: number): void {
    const record = this.record(id);
    if (record.generation !== generation || !isLive(record.status)) return;
    const previous = record.status;
    record.status = nextStatus(previous, { type: 'exit', exitCode, signal }) as RunRecord['status'];
    // A signalled process reports code 0; show the shell convention instead.
    record.exitCode = signal ? 128 + signal : exitCode;
    record.startedAt = undefined;
    this.deps.log(
      record.status === 'crashed' ? 'warn' : 'info',
      `[run] "${id}" exited with code ${exitCode} while ${previous}: now ${record.status}`
    );
    this.setTabStatus(record);
    this.settle(record);
    this.changed();
  }

  private async watchPort(id: string, generation: number, port: number): Promise<void> {
    const record = this.record(id);
    while (!this.disposed && record.generation === generation && record.status === 'starting') {
      if (await this.deps.isPortOpen(port)) {
        this.markReady(id, generation);
        return;
      }
      await this.sleep(PORT_PROBE_INTERVAL_MS);
    }
  }

  private watchOutput(id: string, generation: number, pattern: RegExp, data: string): void {
    const record = this.record(id);
    if (record.generation !== generation || record.status !== 'starting') return;
    // A match can straddle two chunks, so test a rolling window, not the chunk.
    record.outputWindow = (record.outputWindow + data.replace(ANSI_PATTERN, '')).slice(-OUTPUT_WINDOW_CHARS);
    if (pattern.test(record.outputWindow)) this.markReady(id, generation);
  }

  private waitUntilSettled(record: RunRecord, generation: number, timeoutMs: number): Promise<boolean> {
    if (record.generation !== generation || record.status !== 'starting') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (settled: boolean) => {
        if (done) return;
        done = true;
        resolve(settled);
      };
      record.settleWaiters.push(() => finish(true));
      void this.sleep(timeoutMs).then(() => finish(false));
    });
  }

  async start(id: string, options: StartOptions = {}): Promise<StartResult> {
    const target = this.requireTarget(id);
    const record = this.record(id);
    const previousStatus = this.view(target).status;
    if (isLive(record.status) || record.preparing) {
      throw new Error(
        `"${target.name}" is already ${record.preparing ? 'starting' : record.status}. Use restart to start it again.`
      );
    }
    if (this.disposed) throw new Error('The run manager is shutting down');

    // Claimed before the first await, so a second start (the panel and an
    // agent at once) is refused instead of spawning a second copy.
    record.preparing = true;
    try {
      // A cancelled start may still be handing its terminal back.
      if (record.spawning) await record.spawning;

      // A second copy would fail on the port and bury the real one's state.
      if (target.port && (await this.deps.isPortOpen(target.port))) {
        const pid = await this.deps.findListenerPid(target.port);
        record.externalPid = pid ?? 0;
        this.changed();
        throw new Error(
          `Port ${target.port} is already in use${pid ? ` by pid ${pid}` : ''}, by a process Nimbalyst did not start. ` +
            `"${target.name}" was not started.`
        );
      }
      // The target may have been removed, or the module stopped, meanwhile.
      if (this.disposed || !this.targets.some((t) => t.id === id)) {
        throw new Error(`"${target.name}" is no longer a run target`);
      }
      record.status = nextStatus(record.status, { type: 'start' }) as RunRecord['status'];
    } finally {
      record.preparing = false;
    }
    const generation = ++record.generation;
    record.startedAt = this.now();
    record.exitCode = undefined;
    record.error = undefined;
    record.externalPid = undefined;
    record.outputWindow = '';
    this.changed();

    let spawned!: () => void;
    const spawning = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    record.spawning = spawning;
    const finishSpawning = () => {
      if (record.spawning === spawning) record.spawning = undefined;
      spawned();
    };

    let terminal: BackendCommandTerminal;
    try {
      terminal = await this.deps.terminals.createCommandTerminal({
        key: target.id,
        title: target.name,
        command: target.command,
        cwd: target.cwd,
        env: target.env,
        pinned: true,
        panelId: RUNS_PANEL_ID,
      });
    } catch (error) {
      if (record.generation === generation) {
        record.status = 'crashed';
        record.startedAt = undefined;
        record.error = error instanceof Error ? error.message : String(error);
        this.settle(record);
        this.changed();
      }
      finishSpawning();
      throw error;
    }
    if (record.generation !== generation) {
      // Stopped, removed or shut down while the terminal was being created:
      // there was no handle to stop then, so stop it now that there is one.
      try {
        const result = await terminal.stop({ graceMs: STOP_GRACE_MS });
        if (!result.groupGone) {
          this.deps.log('error', `[run] "${id}" was cancelled while starting and some of its processes survived SIGKILL`);
        }
      } catch (error) {
        this.deps.log('error', `[run] could not stop "${id}" after its start was cancelled: ${String(error)}`);
      } finally {
        finishSpawning();
      }
      throw new Error(`"${target.name}" was stopped while it was starting`);
    }
    record.terminal = terminal;
    finishSpawning();
    this.deps.log('info', `[run] started "${id}" (pid ${terminal.pid}): ${target.command}`);
    this.setTabStatus(record);

    terminal.onExit(({ exitCode, signal }) => this.handleExit(id, generation, exitCode, signal));
    if (target.port) {
      void this.watchPort(id, generation, target.port);
    } else if (target.readyPattern) {
      const pattern = new RegExp(target.readyPattern);
      terminal.onOutput((chunk) => this.watchOutput(id, generation, pattern, chunk.data));
    } else {
      // Nothing to wait for: it counts as running once it has been spawned.
      this.markReady(id, generation);
    }

    let timedOut = false;
    if (options.waitForReady) {
      const requested = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_READY_TIMEOUT_MS, 0), MAX_READY_TIMEOUT_MS);
      timedOut = !(await this.waitUntilSettled(record, generation, timeoutMs));
    }

    const run = this.view(target);
    const result: StartResult = { run, previousStatus };
    if (timedOut) result.timedOut = true;
    if (run.status === 'crashed' || timedOut) {
      try {
        result.logs = (await terminal.read({ tail: FAILURE_LOG_LINES })).text;
      } catch (error) {
        this.deps.log('warn', `[run] could not read the log of "${id}": ${String(error)}`);
      }
    }
    return result;
  }

  // ─── Stop ────────────────────────────────────────────────────────────────

  private stopRecord(id: string, record: RunRecord): Promise<void> {
    if (record.stopping) return record.stopping;
    if (!isLive(record.status)) return Promise.resolve();
    if (record.spawning) {
      // Its terminal is still being created, so there is nothing to signal
      // yet. Cancel the start: it stops the terminal as soon as it has one.
      const spawning = record.spawning;
      record.generation += 1;
      record.status = 'stopped';
      record.startedAt = undefined;
      this.deps.log('info', `[run] "${id}" was stopped while it was starting`);
      this.settle(record);
      this.changed();
      return spawning;
    }
    if (!record.terminal) return Promise.resolve();
    const terminal = record.terminal;
    const generation = record.generation;
    record.status = nextStatus(record.status, { type: 'stop' }) as RunRecord['status'];
    this.setTabStatus(record);
    this.settle(record);
    this.changed();

    const stopping = (async () => {
      let failure: string | undefined;
      try {
        const result = await terminal.stop({ graceMs: STOP_GRACE_MS });
        if (result.escalated) this.deps.log('warn', `[run] "${id}" ignored SIGTERM and was killed`);
        if (!result.groupGone) failure = 'Some of its processes are still running after SIGKILL.';
      } catch (error) {
        failure = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (record.generation !== generation) return;
      if (failure) {
        record.error = failure;
        this.deps.log('error', `[run] "${id}" did not stop cleanly: ${failure}`);
      }
      // The exit event normally got here first. If not, the group being gone settles it.
      if (record.status === 'stopping') {
        record.status = failure ? 'crashed' : (nextStatus(record.status, { type: 'gone' }) as RunRecord['status']);
        record.startedAt = undefined;
      }
      this.setTabStatus(record);
      this.changed();
    })().finally(() => {
      if (record.stopping === stopping) record.stopping = undefined;
    });
    record.stopping = stopping;
    return stopping;
  }

  /** Stop a target. Stopping one that is not running is not an error. */
  async stop(id: string): Promise<{ run: RunView; previousStatus: RunStatus }> {
    const target = this.requireTarget(id);
    const record = this.record(id);
    const previousStatus = this.view(target).status;
    if (previousStatus === 'external') {
      throw new Error(
        `"${target.name}" is running outside Nimbalyst${record.externalPid ? ` (pid ${record.externalPid})` : ''}. ` +
          'It can only be stopped from the Runs panel, which asks the user to confirm.'
      );
    }
    await this.stopRecord(id, record);
    return { run: this.view(target), previousStatus };
  }

  async restart(id: string, options: StartOptions = {}): Promise<StartResult> {
    const target = this.requireTarget(id);
    const record = this.record(id);
    const previousStatus = this.view(target).status;
    await this.stopRecord(id, record);
    const result = await this.start(id, options);
    return { ...result, previousStatus };
  }

  /**
   * Stop a process started outside Nimbalyst that holds a target's port. The
   * panel confirms first, naming `pid`. That confirmation is for the process
   * that held the port when the row was drawn, so the port is looked up again
   * here, and again before a force-kill: a pid that no longer holds the port
   * is not signalled.
   */
  async stopExternal(id: string, pid: number): Promise<void> {
    const target = this.requireTarget(id);
    const record = this.record(id);
    const port = target.port;
    // Only the pid this module itself reported for this target can be stopped.
    if (!port || !Number.isInteger(pid) || pid <= 1 || record.externalPid !== pid) {
      throw new Error(`pid ${String(pid)} is not the process holding the port of "${target.name}"`);
    }
    const holdsPort = async () => (await this.deps.findListenerPid(port)) === pid;
    if (!(await holdsPort())) {
      await this.detectExternal(target);
      this.changed();
      throw new Error(
        `The process on port ${port} is no longer pid ${pid}. Nothing was stopped; check the row and try again.`
      );
    }
    const gone = await this.deps.stopExternalProcess(pid, holdsPort);
    // Not gone, but it let go of the port: it is shutting down on its own.
    const released = gone || !(await this.deps.isPortOpen(port));
    this.deps.log(
      released ? 'info' : 'error',
      `[run] external pid ${pid} for "${id}" ${gone ? 'stopped' : released ? 'released the port' : 'did not stop'}`
    );
    await this.detectExternal(target);
    this.changed();
    if (!released) throw new Error(`pid ${pid} did not stop`);
  }

  // ─── Logs ────────────────────────────────────────────────────────────────

  async logs(id: string, options: BackendTerminalReadOptions = {}): Promise<LogsResult> {
    const target = this.requireTarget(id);
    const record = this.record(id);
    const status = this.view(target).status;
    if (!record.terminal) {
      throw new Error(
        status === 'external'
          ? `No logs: "${target.name}" was not started by Nimbalyst.`
          : `No logs: "${target.name}" has not been started since Nimbalyst opened this project.`
      );
    }
    try {
      return { id, status, ...(await record.terminal.read(options)) };
    } catch (error) {
      throw this.tabGone(record, target, error);
    }
  }

  async revealLogs(id: string): Promise<boolean> {
    const target = this.requireTarget(id);
    const record = this.record(id);
    if (!record.terminal) return false;
    try {
      await record.terminal.reveal();
    } catch (error) {
      throw this.tabGone(record, target, error);
    }
    return true;
  }

  /** The user closed the log tab: the host no longer knows the terminal. */
  private tabGone(record: RunRecord, target: RunTarget, error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Unknown terminal/.test(message)) return error instanceof Error ? error : new Error(message);
    if (!isLive(record.status)) record.terminal = undefined;
    return new Error(`No logs: the log tab of "${target.name}" was closed.`);
  }

  /** The module is stopping. The host stops the terminals; this only stops the watchers. */
  dispose(): void {
    this.disposed = true;
    for (const record of this.records.values()) {
      record.generation += 1;
      this.settle(record);
    }
  }
}
