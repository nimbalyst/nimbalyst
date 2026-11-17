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

/** First pid in `lsof -t` output. */
export function parseLsofPids(output: string): number | undefined {
  for (const line of output.split('\n')) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 1) return pid;
  }
  return undefined;
}

/** Pid of the LISTENING row for `port` in `netstat -ano -p tcp` output. */
export function parseNetstatPid(output: string, port: number): number | undefined {
  for (const line of output.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[3] !== 'LISTENING') continue;
    if (!columns[1].endsWith(`:${port}`)) continue;
    const pid = Number.parseInt(columns[4], 10);
    if (Number.isInteger(pid) && pid > 1) return pid;
  }
  return undefined;
}

/** The process listening on a TCP port, if one can be found. */
export async function findListenerPid(
  port: number,
  platform: NodeJS.Platform = process.platform
): Promise<number | undefined> {
  if (platform === 'win32') {
    return parseNetstatPid(await run('netstat', ['-ano', '-p', 'tcp']), port);
  }
  return parseLsofPids(await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
}

/**
 * Stop a process that was started outside Nimbalyst: SIGTERM, then SIGKILL if
 * it is still there after `graceMs`. Only the one pid: this app did not start
 * it and knows nothing about its process group. Returns whether it is gone.
 */
export async function stopExternalProcess(
  pid: number,
  graceMs = 5000,
  kill: (pid: number, signal: NodeJS.Signals | 0) => unknown = process.kill.bind(process),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`Refusing to stop pid ${String(pid)}`);
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
  kill(pid, 'SIGKILL');
  await sleep(200);
  return !alive();
}
