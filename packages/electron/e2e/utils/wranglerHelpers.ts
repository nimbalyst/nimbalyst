/**
 * Wrangler dev lifecycle helpers for E2E tests.
 *
 * Starts a local collabv3 Cloudflare Worker with TEST_AUTH_BYPASS enabled,
 * allowing E2E tests to test full WebSocket sync without real authentication.
 *
 * Based on packages/collabv3/test/helpers.ts but adapted for Playwright E2E.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const READY_TIMEOUT = 20_000;

/**
 * Path to the collabv3 server package the helper should `wrangler dev` against.
 *
 * The collab server lives in a separate sibling repo (`nimbalyst-collab`).
 * The default assumes both repos are checked out as siblings:
 * `~/sources/stravu-editor` and `~/sources/nimbalyst-collab`.
 *
 * Override with `COLLAB_SERVER_PATH=/abs/or/relative/path/to/collabv3` when
 * running the gated `RUN_COLLAB_TESTS=1` specs from a different checkout.
 * The path is resolved relative to the public repo root.
 */
function resolveCollabDir(): string {
  // __dirname = packages/electron/e2e/utils  ->  4 levels up = repo root
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const override = process.env.COLLAB_SERVER_PATH;
  const target = override
    ? path.resolve(repoRoot, override)
    : path.resolve(repoRoot, '..', 'nimbalyst-collab', 'packages', 'collabv3');

  if (!fs.existsSync(path.join(target, 'wrangler.toml'))) {
    throw new Error(
      `[wranglerHelpers] Collab server not found at ${target}.\n` +
        `Set COLLAB_SERVER_PATH to point at your nimbalyst-collab/packages/collabv3 checkout, ` +
        `or skip these tests by unsetting RUN_COLLAB_TESTS.`,
    );
  }
  return target;
}

let wranglerProcess: ChildProcess | null = null;
let activePort: number | null = null;

/**
 * The worker's stdout/stderr for the current run. Server-side evidence (room
 * hibernation restores, 4003 revokes, access lookups) is only in this output,
 * so it is kept on disk instead of being dropped once "Ready on" appears.
 * Written synchronously so a test timeout that kills the runner loses nothing.
 */
let logFd: number | null = null;
let logPath: string | null = null;

function openWranglerLog(port: number): void {
  const dir = path.resolve(__dirname, '..', '..', '..', '..', 'e2e_test_output', 'wrangler');
  fs.mkdirSync(dir, { recursive: true });
  logPath = path.join(dir, `wrangler-${port}-${process.pid}-${Date.now()}.log`);
  logFd = fs.openSync(logPath, 'a');
  console.log(`[wranglerHelpers] Worker output for port ${port}: ${logPath}`);
}

function writeWranglerLog(text: string): void {
  if (logFd === null) return;
  try { fs.writeSync(logFd, text); } catch { /* diagnostics only */ }
}

function closeWranglerLog(): void {
  if (logFd === null) return;
  try { fs.closeSync(logFd); } catch { /* already closed */ }
  logFd = null;
}

/** Where the current (or last) run's worker output is written, or null. */
export function getWranglerLogPath(): string | null {
  return logPath;
}

/**
 * Signal wrangler's whole process group. `npx` starts `node wrangler`, which
 * starts `workerd`; signalling only the `npx` pid left `workerd` serving the
 * port after a timed-out or failed run.
 */
function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // Group already gone.
  }
}

function groupAlive(proc: ChildProcess): boolean {
  if (!proc.pid) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Who started the server on a port: wrangler's process group and the test
 * process that spawned it. Port reclamation only kills a group recorded here
 * whose owner has exited, never another live run or a developer's own server.
 */
interface WranglerOwnership {
  pgid: number;
  ownerPid: number;
}

function ownershipFile(port: number): string {
  return path.join(os.tmpdir(), `nimbalyst-e2e-wrangler-${port}.json`);
}

function recordOwnership(port: number, proc: ChildProcess): void {
  if (!proc.pid) return;
  const record: WranglerOwnership = { pgid: proc.pid, ownerPid: process.pid };
  fs.writeFileSync(ownershipFile(port), JSON.stringify(record));
}

function clearOwnership(port: number | null): void {
  if (port === null) return;
  try { fs.rmSync(ownershipFile(port), { force: true }); } catch { /* best effort */ }
}

function readOwnership(port: number): WranglerOwnership | null {
  try {
    const record = JSON.parse(fs.readFileSync(ownershipFile(port), 'utf8'));
    return Number.isInteger(record?.pgid) && Number.isInteger(record?.ownerPid) ? record : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function listenerPids(port: number): number[] {
  try {
    return execSync(`lsof -nP -ti tcp:${port} -sTCP:LISTEN`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').map((pid) => Number(pid.trim())).filter((pid) => pid > 0);
  } catch {
    return []; // lsof exits 1 when nothing listens.
  }
}

function processGroupOf(pid: number): number | null {
  try {
    const pgid = Number(execSync(`ps -p ${pid} -o pgid=`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
    return pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

// A test timeout can cut the spec's `finally` short, so `stopWrangler` never
// runs; the worker still exits, and this takes the server down with it.
process.on('exit', () => {
  if (!wranglerProcess) return;
  signalGroup(wranglerProcess, 'SIGKILL');
  clearOwnership(activePort);
  closeWranglerLog();
});

/**
 * Free the port of a server an earlier, now-dead test run started and could
 * not stop. Anything else listening -- another live run, a developer's own
 * `wrangler dev`, an unrelated process -- fails the start instead.
 */
async function reclaimPort(port: number): Promise<void> {
  const pids = listenerPids(port);
  if (pids.length === 0) {
    clearOwnership(port);
    return;
  }
  const record = readOwnership(port);
  const orphaned = record !== null
    && !pidAlive(record.ownerPid)
    && pids.every((pid) => processGroupOf(pid) === record.pgid);
  if (!orphaned) {
    const holders = pids.map((pid) => {
      let command = '';
      try {
        command = execSync(`ps -p ${pid} -o command=`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      } catch { /* exited meanwhile */ }
      return `pid ${pid}${command ? ` (${command})` : ''}`;
    });
    throw new Error(`[wranglerHelpers] Port ${port} is in use by ${holders.join(', ')}. ` +
      'It was not started by a finished E2E run, so it is left alone; stop it or use another port.');
  }
  console.warn(`[wranglerHelpers] Killing server orphaned by exited test run ${record.ownerPid} on port ${port} (group ${record.pgid})`);
  try { process.kill(-record.pgid, 'SIGKILL'); } catch { /* already gone */ }
  const deadline = Date.now() + 3000;
  while (listenerPids(port).length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  clearOwnership(port);
}

/**
 * Start wrangler dev --local on the given port.
 * Applies D1 migrations first, then starts the dev server.
 * Resolves when the server prints "Ready on" to stderr.
 */
export async function startWrangler(port: number): Promise<void> {
  if (wranglerProcess) return;

  const collabDir = resolveCollabDir();
  await reclaimPort(port);

  // Apply D1 migrations before starting the dev server
  execSync('npx wrangler d1 migrations apply nimbalyst-collabv3 --local', {
    cwd: collabDir,
    stdio: 'pipe',
  });

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['wrangler', 'dev', '--local', '--port', String(port), '--inspector-port', '0'],
      {
        cwd: collabDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so teardown can signal npx, wrangler and workerd together.
        detached: true,
      }
    );

    wranglerProcess = proc;
    activePort = port;
    recordOwnership(port, proc);
    closeWranglerLog();
    openWranglerLog(port);

    let output = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signalGroup(proc, 'SIGKILL');
      if (wranglerProcess === proc) {
        wranglerProcess = null;
        activePort = null;
        clearOwnership(port);
        closeWranglerLog();
      }
      reject(error);
    };
    const timeout = setTimeout(() => {
      fail(new Error(`Wrangler did not start within ${READY_TIMEOUT}ms.\nOutput: ${output}`));
    }, READY_TIMEOUT);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      writeWranglerLog(text);
      if (settled) return; // Startup output only; the file keeps the rest.
      output += text;
      if (!settled && text.includes('Ready on')) {
        settled = true;
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (err) => fail(err));

    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        fail(new Error(`Wrangler exited with code ${code}.\nOutput: ${output}`));
      }
    });
  });
}

/**
 * Stop the wrangler dev process group: SIGTERM, then SIGKILL whatever is
 * still running after 3s.
 */
export async function stopWrangler(): Promise<void> {
  if (!wranglerProcess) return;

  const proc = wranglerProcess;
  const port = activePort;
  wranglerProcess = null;
  activePort = null;

  signalGroup(proc, 'SIGTERM');
  const deadline = Date.now() + 3000;
  while (groupAlive(proc) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (groupAlive(proc)) signalGroup(proc, 'SIGKILL');
  clearOwnership(port);
  closeWranglerLog();
  if (logPath) console.log(`[wranglerHelpers] Worker output kept at ${logPath}`);
}

/**
 * Build a test auth bypass WebSocket URL for a TrackerRoom.
 * Uses test_user_id/test_org_id query params which are accepted when
 * TEST_AUTH_BYPASS=true and ENVIRONMENT=development in wrangler.toml.
 */
export function buildTrackerTestUrl(
  port: number,
  projectId: string,
  userId: string,
  orgId: string,
): string {
  const roomId = `org:${orgId}:tracker:${projectId}`;
  return `ws://localhost:${port}/sync/${roomId}?test_user_id=${userId}&test_org_id=${orgId}`;
}

/**
 * Get the active wrangler port (null if not running).
 */
export function getWranglerPort(): number | null {
  return activePort;
}
