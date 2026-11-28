/**
 * Supervises one Electron `utilityProcess` child on behalf of a main-process
 * owner (the git runner today; the watcher host is meant to reuse it).
 *
 * The owner keeps its own request bookkeeping. The supervisor owns the
 * child's lifecycle:
 * - lazy start: the first `acquire()` after `app` is ready forks the child;
 *   `acquire()` returns a token only once the child has sent `ready`, and
 *   never waits for it;
 * - stdio captured to the log with a `[name]` prefix;
 * - respawn on a backoff after an unexpected loss, with a crash budget; once
 *   the budget is spent the child stays down for a cool-off, after which the
 *   next `acquire()` retries once;
 * - a ping watchdog while the owner has work pending, measured in
 *   main-observed time: a ping timer that fires late means main stalled, so
 *   the deadline is reset rather than the child blamed. A child that has
 *   sent nothing since a ping went unanswered is measured from that ping,
 *   even across idle gaps between bursts of work;
 * - `stop()` for app quit.
 *
 * This module must not import `electron`: the launcher and the readiness check
 * are injected, so tests run it against a fake child and only the wiring
 * module that `index.ts` loads touches Electron.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { UtilityPingMessage } from './childConnection';

/** The parts of Electron's `UtilityProcess` the supervisor uses. */
export interface SupervisedChild {
  /** Undefined until `spawn` and again after `exit`, as in Electron. */
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: unknown): void;
  kill(): boolean;
  // Events: 'spawn' (), 'message' (message), 'exit' (code), 'error' (type, location).
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type LaunchUtilityProcess = (
  entryPath: string,
  options: { serviceName: string; stdio: 'pipe' },
) => SupervisedChild;

export interface SupervisorLog {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

export interface SupervisorTiming {
  /** Delay before respawn after the Nth loss inside the crash window. */
  respawnBackoffMs: readonly number[];
  /** Losses allowed inside `crashWindowMs`; one more and the child stays down. */
  maxCrashesInWindow: number;
  crashWindowMs: number;
  /** How long the child stays down once the budget is spent. */
  coolOffMs: number;
  /**
   * A child that has not sent `ready` by then is killed and counts as a failed
   * start. A ready timer that fires late (main stalled) re-arms once.
   */
  readyTimeoutMs: number;
  pingIntervalMs: number;
  /** No message from the child for this long, while work is pending, kills it. */
  pingTimeoutMs: number;
  /** POSIX: SIGKILL a child that has not exited this long after `kill()`. */
  killGraceMs: number;
  /** A timer that fires later than this after its due time means main stalled. */
  lateTimerMs: number;
}

export const DEFAULT_SUPERVISOR_TIMING: SupervisorTiming = {
  // Same schedule and budget as the SQLite worker (SQLiteDatabaseProxy).
  respawnBackoffMs: [250, 1_000, 4_000, 15_000, 30_000],
  maxCrashesInWindow: 5,
  crashWindowMs: 10 * 60_000,
  coolOffMs: 60_000,
  readyTimeoutMs: 20_000,
  pingIntervalMs: 2_000,
  pingTimeoutMs: 10_000,
  killGraceMs: 2_000,
  lateTimerMs: 1_000,
};

/**
 * `idle`: not started. `starting`: forked, waiting for `ready`. `ready`: in use.
 * `restarting`: lost, waiting on the backoff. `exhausted`: budget spent, in
 * cool-off. `stopped`: app quit; never starts again.
 */
export type SupervisorState = 'idle' | 'starting' | 'ready' | 'restarting' | 'exhausted' | 'stopped';

/** Identifies one child instance. Instances are numbered from 1 and never reused. */
export interface ChildToken { readonly instance: number }

export interface UtilityProcessSupervisorOptions {
  /** Log prefix without brackets, e.g. `GitRunner`. */
  name: string;
  serviceName: string;
  /** The `protocol` the child's `ready` message must carry. */
  protocolVersion: number;
  /** Absolute path of the child's entry file. May throw when it is missing. */
  resolveEntry: () => string;
  launch: LaunchUtilityProcess;
  isAppReady: () => boolean;
  log: SupervisorLog;
  /** Every message from the current ready child other than the handshake and pongs. */
  onMessage: (message: unknown, token: ChildToken) => void;
  /** The child that `token` names is gone; settle whatever was sent to it. */
  onLost: (token: ChildToken, reason: string) => void;
  /** Whether the owner has requests in flight. The watchdog pings only then. */
  hasPendingWork: () => boolean;
  timing?: Partial<SupervisorTiming>;
  now?: () => number;
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

interface ChildRecord {
  token: ChildToken;
  child: SupervisedChild | null;
  /** From `spawn`: Electron clears `child.pid` on exit, the SIGKILL still needs it. */
  pid: number | undefined;
  ready: boolean;
  exited: boolean;
  /** When main sent the first ping still unanswered: no message from the child since. */
  owedSince?: number;
  readyTimer?: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Find a utility entry emitted next to the main bundle. The calling code may be
 * bundled into `out/main/` or `out/main/chunks/`, and the out dir differs per
 * dev instance (`out2/` for dev:user2), so resolve from `baseDir` (the bundle's
 * `__dirname`), then one level up.
 */
export function resolveUtilityEntryPath(fileName: string, baseDir: string = __dirname): string {
  const candidates = [path.join(baseDir, fileName), path.join(baseDir, '..', fileName)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${fileName} not found. Tried: ${candidates.join(', ')}`);
}

export class UtilityProcessSupervisor {
  private currentState: SupervisorState = 'idle';
  private current: ChildRecord | null = null;
  private instanceSeq = 0;
  private crashTimes: number[] = [];
  private exhaustedAt = 0;
  private retryingAfterCoolOff = false;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private pingDueAt = 0;
  private lastHeardAt = 0;
  private pingSeq = 0;
  private readonly timing: SupervisorTiming;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;

  constructor(private readonly options: UtilityProcessSupervisorOptions) {
    this.timing = { ...DEFAULT_SUPERVISOR_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.killProcess = options.killProcess ?? ((pid, signal) => { process.kill(pid, signal); });
  }

  get state(): SupervisorState {
    return this.currentState;
  }

  /**
   * The current child if it is ready, else null. Starts the child when it has
   * not been started, or retries once after the cool-off. Never waits.
   */
  acquire(): ChildToken | null {
    switch (this.currentState) {
      case 'ready':
        return this.current!.token;
      case 'idle':
        this.start();
        return null;
      case 'exhausted':
        if (this.now() - this.exhaustedAt >= this.timing.coolOffMs) {
          this.retryingAfterCoolOff = true;
          this.start();
        }
        return null;
      default:
        return null;
    }
  }

  /** Post to the child `token` names. False when it is not the current ready child. */
  post(token: ChildToken, message: unknown): boolean {
    const record = this.current;
    if (!record || record.token !== token || !record.ready || !record.child) return false;
    try {
      record.child.postMessage(message);
      return true;
    } catch {
      return false;
    }
  }

  /** The owner has work in flight: run the watchdog. */
  workStarted(): void {
    if (this.currentState !== 'ready' || this.pingTimer || !this.options.hasPendingWork()) return;
    // A child that stopped answering during an earlier burst is still silent.
    this.lastHeardAt = this.current!.owedSince ?? this.now();
    this.schedulePing();
  }

  /** The owner settled work: stop the watchdog once nothing is pending. */
  workFinished(): void {
    if (!this.options.hasPendingWork()) this.clearPing();
  }

  /** App quit: kill the child and never start another. */
  stop(): void {
    if (this.currentState === 'stopped') return;
    this.currentState = 'stopped';
    if (this.respawnTimer) clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
    this.clearPing();
    const record = this.current;
    this.current = null;
    if (!record) return;
    if (record.readyTimer) clearTimeout(record.readyTimer);
    this.terminate(record);
    this.options.onLost(record.token, 'stopped');
  }

  private start(): void {
    if (!this.options.isAppReady()) return;
    const record: ChildRecord = { token: { instance: ++this.instanceSeq }, child: null, pid: undefined, ready: false, exited: false };
    this.current = record;
    this.currentState = 'starting';
    const { name } = this.options;
    let child: SupervisedChild;
    try {
      child = this.options.launch(this.options.resolveEntry(), { serviceName: this.options.serviceName, stdio: 'pipe' });
    } catch (error) {
      record.exited = true;
      this.lose(record, `start failed: ${describeError(error)}`);
      return;
    }
    record.child = child;
    child.on('spawn', () => { record.pid = child.pid; });
    child.on('message', (message: unknown) => this.handleMessage(record, message));
    child.on('exit', (code: number) => {
      record.exited = true;
      if (record.killTimer) clearTimeout(record.killTimer);
      record.killTimer = undefined;
      this.lose(record, `exited with code ${code}`);
    });
    child.on('error', (type: string, location: string) => this.lose(record, `${type} at ${location}`));
    // A dying child's output is the most useful, so it is logged even after loss.
    child.stdout?.on('data', (chunk: Buffer | string) => {
      this.options.log.info(`[${name}] stdout: ${chunk.toString().trimEnd()}`);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.options.log.warn(`[${name}] stderr: ${chunk.toString().trimEnd()}`);
    });
    this.armReadyTimer(record, false);
  }

  private armReadyTimer(record: ChildRecord, rearmed: boolean): void {
    const dueAt = this.now() + this.timing.readyTimeoutMs;
    record.readyTimer = setTimeout(() => {
      record.readyTimer = undefined;
      if (!rearmed && this.now() - dueAt > this.timing.lateTimerMs) {
        // Main was stalled; the child's ready may be queued behind the stall.
        this.armReadyTimer(record, true);
        return;
      }
      this.lose(record, `no ready message within ${this.timing.readyTimeoutMs} ms`);
    }, this.timing.readyTimeoutMs);
  }

  private handleMessage(record: ChildRecord, raw: unknown): void {
    // A replaced child's queued messages (ready, pongs, replies) are not ours.
    if (this.current !== record) return;
    this.lastHeardAt = this.now();
    record.owedSince = undefined;
    const message = raw as { type?: unknown; protocol?: unknown } | null;
    if (message?.type === 'pong') return;
    if (message?.type === 'ready') {
      if (record.ready) return;
      if (message.protocol !== this.options.protocolVersion) {
        this.lose(record, `protocol ${String(message.protocol)}, expected ${this.options.protocolVersion}`);
        return;
      }
      if (record.readyTimer) clearTimeout(record.readyTimer);
      record.readyTimer = undefined;
      record.ready = true;
      this.currentState = 'ready';
      const pid = record.pid ?? record.child?.pid;
      if (this.retryingAfterCoolOff) {
        this.retryingAfterCoolOff = false;
        this.crashTimes = [];
        this.options.log.info(`[${this.options.name}] running again after cool-off`, { pid });
      } else {
        this.options.log.info(`[${this.options.name}] ready`, { pid });
      }
      return;
    }
    if (!record.ready) return;
    this.options.onMessage(raw, record.token);
  }

  private lose(record: ChildRecord, reason: string): void {
    if (this.current !== record) return;
    this.current = null;
    if (record.readyTimer) clearTimeout(record.readyTimer);
    record.readyTimer = undefined;
    this.clearPing();
    this.terminate(record);
    this.charge(reason, record.ready);
    this.options.onLost(record.token, reason);
  }

  private charge(reason: string, wasReady: boolean): void {
    const now = this.now();
    const { name } = this.options;
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.timing.crashWindowMs);
    this.crashTimes.push(now);
    if (this.retryingAfterCoolOff && !wasReady) {
      // The one retry after a cool-off failed: stay down quietly for another one.
      this.retryingAfterCoolOff = false;
      this.currentState = 'exhausted';
      this.exhaustedAt = now;
      return;
    }
    if (this.crashTimes.length > this.timing.maxCrashesInWindow) {
      this.currentState = 'exhausted';
      this.exhaustedAt = now;
      this.options.log.warn(
        `[${name}] failed ${this.crashTimes.length} times in ${Math.round(this.timing.crashWindowMs / 60_000)} min; ` +
        `staying down for ${Math.round(this.timing.coolOffMs / 1000)} s`,
        { reason },
      );
      return;
    }
    const steps = this.timing.respawnBackoffMs;
    const delay = steps[Math.min(this.crashTimes.length - 1, steps.length - 1)];
    this.currentState = 'restarting';
    this.options.log.warn(`[${name}] lost (${reason}); restarting in ${delay} ms`, {
      crashesInWindow: this.crashTimes.length,
    });
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.currentState === 'restarting') this.start();
    }, delay);
  }

  private terminate(record: ChildRecord): void {
    if (record.exited || !record.child) return;
    const child = record.child;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    const pid = record.pid ?? child.pid;
    // On Windows kill() terminates the process. On POSIX a stopped or wedged
    // child may never act on SIGTERM.
    if (this.platform === 'win32' || pid === undefined) return;
    record.killTimer = setTimeout(() => {
      record.killTimer = undefined;
      if (record.exited) return;
      try {
        this.killProcess(pid, 'SIGKILL');
      } catch {
        // Exited in the meantime.
      }
    }, this.timing.killGraceMs);
  }

  private schedulePing(): void {
    this.pingDueAt = this.now() + this.timing.pingIntervalMs;
    this.pingTimer = setTimeout(() => this.pingTick(), this.timing.pingIntervalMs);
  }

  private clearPing(): void {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private pingTick(): void {
    this.pingTimer = null;
    const record = this.current;
    if (!record || this.currentState !== 'ready' || !this.options.hasPendingWork()) return;
    const now = this.now();
    if (now - this.pingDueAt > this.timing.lateTimerMs) {
      // Main was stalled; the child's answers may be queued behind the stall.
      this.lastHeardAt = now;
    } else if (now - this.lastHeardAt >= this.timing.pingTimeoutMs) {
      this.lose(record, `unresponsive: no answer for ${now - this.lastHeardAt} ms`);
      return;
    }
    if (this.post(record.token, { type: 'ping', seq: ++this.pingSeq } satisfies UtilityPingMessage)) record.owedSince ??= now;
    this.schedulePing();
  }
}
