import {
  spawn as defaultSpawn,
  type ChildProcess,
} from 'node:child_process';

const WINDOWS_TREE_KILL_TIMEOUT_MS = 5_000;
const terminationStarted = new WeakSet<object>();

type OwnedChildProcess = Pick<
  ChildProcess,
  'pid' | 'killed' | 'exitCode' | 'signalCode' | 'kill'
>;

type TaskkillProcess = Pick<ChildProcess, 'once' | 'unref' | 'kill'>;
type SpawnTaskkill = (
  command: string,
  args: string[],
  options: { stdio: 'ignore'; windowsHide: true; detached: true },
) => TaskkillProcess;

export interface ProcessTreeTerminationDeps {
  platform?: NodeJS.Platform;
  spawn?: SpawnTaskkill;
}

function hasExited(child: OwnedChildProcess): boolean {
  return typeof child.exitCode === 'number'
    || (child.signalCode !== null && child.signalCode !== undefined);
}

function terminateDirectChild(child: OwnedChildProcess): void {
  if (child.killed || hasExited(child)) return;
  try {
    child.kill();
  } catch {
    // Cleanup is intentionally idempotent and best-effort.
  }
}

/**
 * Terminate only the process tree rooted at a child process Nimbalyst spawned.
 *
 * Windows does not propagate `ChildProcess.kill()` to descendants. Codex can
 * leave git/MCP grandchildren behind, so start taskkill's exact root-PID tree
 * mode before the caller closes stdin. The detached helper cannot freeze the
 * Electron main thread and can finish during app shutdown. A bounded fallback
 * preserves direct-child cleanup if taskkill cannot start, fails, or hangs.
 *
 * This deliberately never scans by executable name, command line, or age. A
 * Windows Job Object bound at spawn time would eliminate the OS-level PID reuse
 * window entirely; until that larger native integration exists, keeping the
 * owned root alive while taskkill starts is the narrowest safe tree approach.
 */
export function terminateOwnedProcessTree(
  child: OwnedChildProcess,
  deps: ProcessTreeTerminationDeps = {},
): void {
  if (!child || typeof child !== 'object') return;
  if (terminationStarted.has(child)) return;
  terminationStarted.add(child);
  if (hasExited(child)) return;

  const platform = deps.platform ?? process.platform;
  const pid = child.pid;
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
    terminateDirectChild(child);
    return;
  }

  const spawnTaskkill: SpawnTaskkill = deps.spawn
    ?? ((command, args, options) => defaultSpawn(command, args, options));
  let taskkill: TaskkillProcess;
  try {
    taskkill = spawnTaskkill(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      },
    );
  } catch {
    terminateDirectChild(child);
    return;
  }

  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settle = (succeeded: boolean) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (!succeeded) terminateDirectChild(child);
  };

  taskkill.once('error', () => settle(false));
  taskkill.once('exit', (code) => settle(code === 0));
  taskkill.unref();

  timeout = setTimeout(() => {
    try { taskkill.kill(); } catch { /* noop */ }
    settle(false);
  }, WINDOWS_TREE_KILL_TIMEOUT_MS);
  (timeout as { unref?: () => void }).unref?.();
  if (settled) clearTimeout(timeout);
}
