/**
 * Looking at the machine: is a port open, and which process holds it.
 *
 * `isPortOpen` is the readiness check for a target with a `port`, and the
 * cheap first half of spotting a copy started outside Nimbalyst. `findListenerPid`
 * names the process, using `lsof` (or `netstat` on Windows).
 */
import { execFile } from 'node:child_process';
import { connect } from 'node:net';

function canConnect(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Whether something accepts connections on the port. Dev servers bind either
 * the IPv4 or the IPv6 loopback depending on how `localhost` resolves, so both
 * are tried.
 */
export async function isPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  const results = await Promise.all([
    canConnect(port, '127.0.0.1', timeoutMs),
    canConnect(port, '::1', timeoutMs),
  ]);
  return results.some(Boolean);
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 4000, windowsHide: true }, (_error, stdout) => {
      // lsof exits 1 when nothing matches; the empty output is the answer.
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** Distinct pids in `lsof -t` output. */
export function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 1) pids.add(pid);
  }
  return [...pids];
}

/** Distinct pids of the LISTENING rows for `port` in `netstat -ano -p tcp` output. */
export function parseNetstatPids(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[3] !== 'LISTENING') continue;
    if (!columns[1].endsWith(`:${port}`)) continue;
    const pid = Number.parseInt(columns[4], 10);
    if (Number.isInteger(pid) && pid > 1) pids.add(pid);
  }
  return [...pids];
}

/** Every process listening on a TCP port (one per interface is possible). */
export async function findListenerPids(
  port: number,
  platform: NodeJS.Platform = process.platform
): Promise<number[]> {
  if (platform === 'win32') {
    return parseNetstatPids(await run('netstat', ['-ano', '-p', 'tcp']), port);
  }
  return parseLsofPids(await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
}

/**
 * The one process listening on a TCP port. Undefined when none can be found
 * and when more than one process listens on it (different interfaces): then
 * there is no single owner to name, and nothing this app should offer to stop.
 */
export async function findListenerPid(
  port: number,
  platform: NodeJS.Platform = process.platform
): Promise<number | undefined> {
  const pids = await findListenerPids(port, platform);
  return pids.length === 1 ? pids[0] : undefined;
}

export interface StopExternalOptions {
  graceMs?: number;
  /**
   * Asked before SIGKILL: is this pid still the process the user agreed to
   * stop? A pid that gave up the port is on its way out, or is no longer the
   * same process; either way it is not force-killed.
   */
  stillTarget?: () => Promise<boolean>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Stop a process that was started outside Nimbalyst: SIGTERM, then SIGKILL if
 * it is still there after `graceMs`. Only the one pid: this app did not start
 * it and knows nothing about its process group. Returns whether it is gone.
 */
export async function stopExternalProcess(pid: number, options: StopExternalOptions = {}): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Refusing to stop pid ${String(pid)}`);
  const graceMs = options.graceMs ?? 5000;
  const kill = options.kill ?? process.kill.bind(process);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = () => {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      return (error as { code?: string }).code === 'EPERM';
    }
  };
  if (!alive()) return true;
  kill(pid, 'SIGTERM');
  for (let waited = 0; waited < graceMs; waited += 100) {
    await sleep(100);
    if (!alive()) return true;
  }
  if (options.stillTarget && !(await options.stillTarget())) return !alive();
  kill(pid, 'SIGKILL');
  await sleep(200);
  return !alive();
}
