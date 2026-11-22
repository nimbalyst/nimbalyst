/**
 * Signal and stop the process group of a PTY child.
 *
 * node-pty's child is a session and process-group leader, so its pid is also
 * the group id. A command such as `pnpm run dev` forks a chain
 * (pnpm -> vite -> esbuild); signalling only the direct child leaves the rest
 * of the chain running and holding its port (GitHub #903). Everything here
 * therefore targets the group.
 *
 * `stopProcessGroup` is the one stop path for command terminals: SIGTERM,
 * SIGKILL if the group outlives the grace period, then a check that the group
 * is gone. `kill`, the clock and the Windows process-tree kill are injected so
 * the escalation is tested without signalling anything real.
 */
import { spawnSync } from 'child_process';

export type ProcessGroupSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP';

export const PROCESS_GROUP_SIGNALS: readonly ProcessGroupSignal[] = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'];

export interface ProcessGroupDeps {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: string | number) => unknown;
  /** Windows only: end the process tree rooted at `pid`. Returns false if nothing was found. */
  taskkill?: (pid: number, force: boolean) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface StopProcessGroupOptions {
  /** How long the group gets to exit after SIGTERM before SIGKILL. Default 5000. */
  graceMs?: number;
  /** How often to check whether the group is gone. Default 100. */
  pollMs?: number;
  /** How long to wait for the group to disappear after SIGKILL. Default 2000. */
  killWaitMs?: number;
}

export interface StopProcessGroupResult {
  /** SIGKILL was needed. */
  escalated: boolean;
  /** No process is left in the group. False means something survived SIGKILL. */
  groupGone: boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** pid 0 is the caller's own group, 1 is init, and a negative pid is a group id. */
function assertStoppablePid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`Refusing to signal process group for pid ${String(pid)}`);
  }
}

function defaultTaskkill(pid: number, force: boolean): boolean {
  const args = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
  const result = spawnSync('taskkill.exe', args, { windowsHide: true, timeout: 5000 });
  return result.status === 0;
}

/**
 * Send `signal` to every process in the group led by `pid`. Returns false when
 * there was nothing left to signal.
 */
export function signalProcessGroup(
  pid: number,
  signal: ProcessGroupSignal,
  deps: ProcessGroupDeps = {}
): boolean {
  assertStoppablePid(pid);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    // No process groups or signals: taskkill walks the tree. Only SIGKILL forces.
    return (deps.taskkill ?? defaultTaskkill)(pid, signal === 'SIGKILL');
  }
  const kill = deps.kill ?? process.kill.bind(process);
  try {
    kill(-pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
  // No such group. The leader may still exist if it was moved out of its group.
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Whether any process is left in the group led by `pid`.
 *
 * Windows has no process groups, so there this only says whether the leader is
 * alive. `taskkill /T` ends the leader's tree, but nothing here can confirm
 * that a descendant which outlived the leader is gone.
 */
export function isProcessGroupAlive(pid: number, deps: ProcessGroupDeps = {}): boolean {
  assertStoppablePid(pid);
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? process.kill.bind(process);
  try {
    // Signal 0 only checks for existence. Windows has no groups, so check the leader.
    kill(platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process exists that we may not signal. It is still alive.
    return errorCode(error) === 'EPERM';
  }
}

async function waitUntilGone(
  pid: number,
  timeoutMs: number,
  pollMs: number,
  deps: ProcessGroupDeps
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    if (!isProcessGroupAlive(pid, deps)) return true;
    if (now() >= deadline) return false;
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

/**
 * SIGTERM the group, wait up to `graceMs`, SIGKILL whatever is left, and
 * report whether the group is gone.
 */
export async function stopProcessGroup(
  pid: number,
  options: StopProcessGroupOptions = {},
  deps: ProcessGroupDeps = {}
): Promise<StopProcessGroupResult> {
  assertStoppablePid(pid);
  const graceMs = options.graceMs ?? 5000;
  const pollMs = options.pollMs ?? 100;
  const killWaitMs = options.killWaitMs ?? 2000;

  if (!isProcessGroupAlive(pid, deps)) return { escalated: false, groupGone: true };
  const signalled = signalProcessGroup(pid, 'SIGTERM', deps);
  if (!signalled) {
    // Nothing took the signal. On POSIX that means the group is gone. On
    // Windows it also covers taskkill failing (a console program refuses the
    // polite request, taskkill timed out), which says nothing about the tree:
    // look again, and go straight to the forced kill if it is still there.
    if (!isProcessGroupAlive(pid, deps)) return { escalated: false, groupGone: true };
  } else if (await waitUntilGone(pid, graceMs, pollMs, deps)) {
    return { escalated: false, groupGone: true };
  }

  signalProcessGroup(pid, 'SIGKILL', deps);
  return { escalated: true, groupGone: await waitUntilGone(pid, killWaitMs, pollMs, deps) };
}
