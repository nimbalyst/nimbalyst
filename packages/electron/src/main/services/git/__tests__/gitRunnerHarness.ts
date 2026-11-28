/**
 * Test harness for the git runner: the real runner module (`gitRunnerRuntime`)
 * runs in this process behind a fake parent port, so the tests drive real git
 * children through the real protocol without starting Electron.
 *
 * The port copies every message with `structuredClone` (the serializer
 * Electron's `postMessage` uses, which keeps only `message` and `stack` of an
 * Error) and delivers it on a later macrotask, as a real port would.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import { createChildConnection, type ParentMessagePort } from '../../../utilityProcess/childConnection';
import type { LaunchUtilityProcess, SupervisedChild } from '../../../utilityProcess/UtilityProcessSupervisor';
import { createGitRunner, type GitRunnerTiming } from '../gitRunnerClient';
import { setGitRunTransport } from '../runGit';
import { startGitRunner } from '../gitRunnerRuntime';

/** Set while a message is handed to the runner module, so a `child_process` spy can tell who spawned. */
export interface SpawnSide {
  inRunner: boolean;
  /**
   * The env the runner was forked with, set with `inRunner`. A utility
   * process's env is fixed at fork, so a spy can hand it to a runner spawn
   * that passes no env instead of main's live `process.env`.
   */
  runnerEnv?: NodeJS.ProcessEnv;
}

/** One `execFile` call seen by a test's `child_process` spy. */
export interface RecordedSpawn {
  file: string;
  args: string[];
  options: Record<string, unknown>;
  inRunner: boolean;
  /** `performance.now()` when the spy saw the call, for spies that record it. */
  at?: number;
}

const realSetTimeout = globalThis.setTimeout;
let pidSeq = 7000;

export interface HarnessBehaviour {
  /** Send `ready` this long after spawn (real time). */
  readyDelayMs?: number;
  /** Exit with this code right after spawn, before `ready`. */
  exitBeforeReady?: number;
  /** Spawn but never start the runner module. */
  neverReady?: boolean;
}

export class HarnessChild extends EventEmitter implements SupervisedChild {
  pid: number | undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Every message main posted to this child. */
  readonly received: unknown[] = [];
  kills = 0;
  private alive = true;
  private exited = false;
  private upPaused = false;
  private held: unknown[] = [];
  private listener?: (event: { data: unknown }) => void;
  /** `utilityProcess.fork` gives the child main's `process.env` as it is at fork. */
  private readonly forkEnv: NodeJS.ProcessEnv = { ...process.env };

  constructor(private readonly side: SpawnSide, behaviour: HarnessBehaviour = {}) {
    super();
    const port: ParentMessagePort = {
      on: (_event, listener) => { this.listener = listener; },
      postMessage: (message) => this.sendUp(message),
    };
    setImmediate(() => {
      if (this.exited) return;
      this.pid = ++pidSeq;
      this.emit('spawn');
      if (behaviour.exitBeforeReady !== undefined) { this.exit(behaviour.exitBeforeReady); return; }
      if (behaviour.neverReady) return;
      const start = () => { if (this.alive) startGitRunner(createChildConnection(port)); };
      if (behaviour.readyDelayMs) realSetTimeout(start, behaviour.readyDelayMs);
      else start();
    });
  }

  postMessage(message: unknown): void {
    this.received.push(message);
    const copy = structuredClone(message);
    setImmediate(() => {
      if (!this.alive || !this.listener) return;
      this.side.inRunner = true;
      this.side.runnerEnv = this.forkEnv;
      try { this.listener({ data: copy }); } finally { this.side.inRunner = false; this.side.runnerEnv = undefined; }
    });
  }

  kill(): boolean {
    this.kills++;
    if (this.exited) return false;
    this.alive = false;
    setImmediate(() => this.exit(null));
    return true;
  }

  /** Hold messages from the runner to main until `resumeUp`. */
  pauseUp(): void { this.upPaused = true; }
  get heldCount(): number { return this.held.length; }
  resumeUp(): void {
    this.upPaused = false;
    for (const message of this.held.splice(0)) setImmediate(() => this.emit('message', message));
  }

  /** The runner dies: main sees `exit` now. */
  crash(code = 1): void { this.exit(code); }
  /** The runner stops reading and writing; main has not seen `exit` yet. */
  dieSilently(): void { this.alive = false; }
  /** A message from this child that main receives late, after it was replaced. */
  deliverLate(message: unknown): void { this.emit('message', structuredClone(message)); }

  /** Run ids main sent to this child. */
  runIds(): number[] {
    return this.received.filter((m): m is { type: 'run'; id: number } => (m as { type?: string }).type === 'run').map((m) => m.id);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.alive = false;
    this.pid = undefined;
    this.emit('exit', code);
  }

  private sendUp(message: unknown): void {
    if (!this.alive) return;
    const copy = structuredClone(message);
    if (this.upPaused) { this.held.push(copy); return; }
    setImmediate(() => { if (!this.exited) this.emit('message', copy); });
  }
}

export interface HarnessRunner {
  runner: ReturnType<typeof createGitRunner>;
  launch: ReturnType<typeof vi.fn<LaunchUtilityProcess>>;
  children: HarnessChild[];
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  /** Start the runner if needed and wait until it is ready. */
  up(): Promise<HarnessChild>;
}

export function startHarnessRunner(side: SpawnSide, options: {
  behaviours?: HarnessBehaviour[];
  timing?: Partial<GitRunnerTiming>;
  isAppReady?: () => boolean;
  resolveEntry?: () => string;
  launch?: LaunchUtilityProcess;
  now?: () => number;
} = {}): HarnessRunner {
  const children: HarnessChild[] = [];
  const launch = vi.fn<LaunchUtilityProcess>(options.launch ?? (() => {
    const child = new HarnessChild(side, options.behaviours?.[children.length] ?? {});
    children.push(child);
    return child;
  }));
  const log = { info: vi.fn(), warn: vi.fn() };
  const runner = createGitRunner({
    launch,
    isAppReady: options.isAppReady ?? (() => true),
    log,
    resolveEntry: options.resolveEntry ?? (() => '/harness/out/main/gitRunner.js'),
    timing: options.timing,
    now: options.now,
  });
  setGitRunTransport(runner.transport);
  return {
    runner, launch, children, log,
    async up() {
      runner.supervisor.acquire();
      await until(() => runner.supervisor.state === 'ready', 'the runner to be ready');
      return children[children.length - 1];
    },
  };
}

/**
 * Poll in real time. `vi.waitFor` advances fake timers while it polls, which
 * would move the deadlines these tests measure.
 */
export async function until(check: () => boolean, label: string, limitMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > limitMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
}

/** Wait for every message already queued on `setImmediate` to be delivered. */
export async function flushPorts(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A directory holding a fake `git` (POSIX sh) whose first argument picks what it
 * does. Anything else runs the real git, after `FAKE_GIT_DELAY` seconds if set,
 * or hangs when the argv contains the word in `FAKE_GIT_HANG_ON`.
 */
export function makeFakeGitDir(realGit: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-fake-git-'));
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    '  sleep) exec sleep "$2" ;;',
    '  sleep-print) sleep "$2"; printf \'%s\' "$3"; exit 0 ;;',
    '  argv) printf \'%s\\0\' "$@"; exit 0 ;;',
    '  env-mark) printf \'%s\' "$FAKE_GIT_MARK"; exit 0 ;;',
    '  cat) cat "$2"; exit 0 ;;',
    '  bytes) head -c "$2" /dev/zero | tr \'\\0\' a; exit 0 ;;',
    'esac',
    'if [ -n "$FAKE_GIT_HANG_ON" ]; then',
    '  case " $* " in *" $FAKE_GIT_HANG_ON "*) exec sleep 30 ;; esac',
    'fi',
    'if [ -n "$FAKE_GIT_DELAY" ]; then sleep "$FAKE_GIT_DELAY"; fi',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'git'), script, { mode: 0o755 });
  return dir;
}

/** The own properties of an error that callers can read, minus `stack`. */
export function errorShape(error: unknown): { ctor: string; props: Record<string, unknown> } {
  const value = error as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(value)) if (key !== 'stack') props[key] = value[key];
  return { ctor: (error as object).constructor.name, props };
}
