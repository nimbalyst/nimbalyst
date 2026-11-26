/**
 * Main's side of the git runner: a `GitRunTransport` that sends git calls to
 * the runner utility process and matches the replies, on top of the generic
 * `UtilityProcessSupervisor`.
 *
 * No call fails because of the runner. When it is not ready (starting,
 * restarting, budget spent, stopped) `run` returns null and `runGit` runs the
 * call in process. When it dies with calls in flight, they re-run in process
 * within what is left of their timeout.
 *
 * A call with a `timeout` also gets main's own deadline, `timeout` plus a
 * margin, in case the runner never answers: it rejects with the error
 * `execFile` gives for a timeout and drops a later reply. A call without one
 * (the untracked ls-files chunks) gets no deadline; a hung runner is caught by
 * the supervisor's ping watchdog instead.
 *
 * Electron-free, so tests run it against a harness child.
 */
import {
  DEFAULT_SUPERVISOR_TIMING,
  UtilityProcessSupervisor,
  resolveUtilityEntryPath,
  type ChildToken,
  type LaunchUtilityProcess,
  type SupervisorLog,
  type SupervisorTiming,
} from '../../utilityProcess/UtilityProcessSupervisor';
import {
  GIT_RUNNER_PROTOCOL_VERSION,
  deserializeGitError,
  gitExecOptions,
  gitTimeoutError,
  type GitRunOptions,
  type GitRunReply,
  type GitRunRequest,
  type GitRunResult,
} from './gitRunnerProtocol';
import { runGitInProcess, type GitRunTransport } from './runGit';

/** The runner bundle electron-vite emits next to the main bundle. */
export const GIT_RUNNER_ENTRY = 'gitRunner.js';
export const GIT_RUNNER_SERVICE_NAME = 'nimbalyst-git-runner';
/** `NIMBALYST_GIT_RUNNER=off` keeps every git call in the main process. */
export const GIT_RUNNER_KILL_SWITCH = 'NIMBALYST_GIT_RUNNER';

export interface GitRunnerTiming extends SupervisorTiming {
  /** Main's deadline for a call is its `timeout` plus this. */
  deadlineMarginMs: number;
  /**
   * A deadline timer firing later than this after its due time means main was
   * stalled, and the runner's reply may be queued behind the stall: the
   * deadline re-arms once, for the margin, instead of rejecting.
   */
  deadlineLateMs: number;
}

export const DEFAULT_GIT_RUNNER_TIMING: GitRunnerTiming = {
  ...DEFAULT_SUPERVISOR_TIMING,
  deadlineMarginMs: 2_000,
  deadlineLateMs: 100,
};

/** Node clamps longer timers to 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export function isGitRunnerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GIT_RUNNER_KILL_SWITCH] !== 'off';
}

export interface CreateGitRunnerOptions {
  launch: LaunchUtilityProcess;
  isAppReady: () => boolean;
  log: SupervisorLog;
  /** Defaults to `gitRunner.js` next to the main bundle. */
  resolveEntry?: () => string;
  timing?: Partial<GitRunnerTiming>;
  now?: () => number;
  platform?: NodeJS.Platform;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface GitRunner {
  transport: GitRunTransport;
  supervisor: UtilityProcessSupervisor;
  pendingCount(): number;
  /** App quit: kill the runner; pending calls finish in process. */
  stop(): void;
}

interface PendingCall {
  id: number;
  args: string[];
  options: GitRunOptions;
  token: ChildToken;
  startedAt: number;
  dueAt: number;
  rearmed: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (result: GitRunResult) => void;
  reject: (error: unknown) => void;
}

function timeoutOf(options: GitRunOptions): number | undefined {
  const { timeout } = options;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
}

export function createGitRunner(options: CreateGitRunnerOptions): GitRunner {
  const timing: GitRunnerTiming = { ...DEFAULT_GIT_RUNNER_TIMING, ...options.timing };
  const now = options.now ?? Date.now;
  const pending = new Map<number, PendingCall>();
  // Unique across restarts of the runner process, so a late reply can never
  // match a newer call.
  let lastId = 0;

  const supervisor = new UtilityProcessSupervisor({
    name: 'GitRunner',
    serviceName: GIT_RUNNER_SERVICE_NAME,
    protocolVersion: GIT_RUNNER_PROTOCOL_VERSION,
    resolveEntry: options.resolveEntry ?? (() => resolveUtilityEntryPath(GIT_RUNNER_ENTRY)),
    launch: options.launch,
    isAppReady: options.isAppReady,
    log: options.log,
    onMessage: (message, token) => handleReply(message as GitRunReply, token),
    onLost: (token) => {
      for (const call of [...pending.values()]) if (call.token === token) rerunInProcess(call);
    },
    hasPendingWork: () => pending.size > 0,
    timing,
    now,
    platform: options.platform,
    killProcess: options.killProcess,
  });

  function settle(call: PendingCall): void {
    if (call.timer) clearTimeout(call.timer);
    call.timer = undefined;
    pending.delete(call.id);
    supervisor.workFinished();
  }

  function handleReply(message: GitRunReply, token: ChildToken): void {
    if (message?.type !== 'result' && message?.type !== 'failure') return;
    const call = pending.get(message.id);
    if (!call || call.token !== token) return;
    settle(call);
    if (message.type === 'result') call.resolve({ stdout: message.stdout, stderr: message.stderr });
    else call.reject(deserializeGitError(message.error));
  }

  /** The runner is gone: run the call here, within what is left of its timeout. */
  function rerunInProcess(call: PendingCall): void {
    settle(call);
    let callOptions = call.options;
    const timeout = timeoutOf(call.options);
    if (timeout !== undefined) {
      const remaining = Math.floor(timeout - (now() - call.startedAt));
      if (remaining < 1) {
        call.reject(gitTimeoutError(call.args));
        return;
      }
      callOptions = { ...call.options, timeout: remaining };
    }
    runGitInProcess(call.args, callOptions).then(call.resolve, call.reject);
  }

  function armDeadline(call: PendingCall, delay: number): void {
    call.dueAt = now() + delay;
    call.timer = setTimeout(() => onDeadline(call), Math.min(delay, MAX_TIMER_MS));
  }

  function onDeadline(call: PendingCall): void {
    call.timer = undefined;
    if (pending.get(call.id) !== call) return;
    if (!call.rearmed && now() - call.dueAt > timing.deadlineLateMs) {
      call.rearmed = true;
      armDeadline(call, timing.deadlineMarginMs);
      return;
    }
    settle(call);
    call.reject(gitTimeoutError(call.args));
  }

  const transport: GitRunTransport = {
    run(args, callOptions) {
      const token = supervisor.acquire();
      if (!token) return null;
      const id = ++lastId;
      const request: GitRunRequest = {
        type: 'run',
        id,
        args: [...args],
        // git gets the env main would have used for this call.
        options: { ...gitExecOptions(callOptions), env: callOptions.env ?? { ...process.env } },
      };
      return new Promise<GitRunResult>((resolve, reject) => {
        const call: PendingCall = {
          id, args: request.args, options: { ...callOptions }, token, startedAt: now(), dueAt: 0, rearmed: false, resolve, reject,
        };
        // Registered before the send: a runner that dies before main sees the
        // send fail still settles the call through onLost.
        pending.set(id, call);
        const timeout = timeoutOf(callOptions);
        if (timeout !== undefined) armDeadline(call, timeout + timing.deadlineMarginMs);
        if (!supervisor.post(token, request)) {
          rerunInProcess(call);
          return;
        }
        supervisor.workStarted();
      });
    },
  };

  return {
    transport,
    supervisor,
    pendingCount: () => pending.size,
    stop: () => supervisor.stop(),
  };
}
