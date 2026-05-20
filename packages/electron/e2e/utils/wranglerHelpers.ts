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
 * Start wrangler dev --local on the given port.
 * Applies D1 migrations first, then starts the dev server.
 * Resolves when the server prints "Ready on" to stderr.
 */
export async function startWrangler(port: number): Promise<void> {
  if (wranglerProcess) return;

  const collabDir = resolveCollabDir();

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
      }
    );

    wranglerProcess = proc;
    activePort = port;

    let output = '';
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Wrangler did not start within ${READY_TIMEOUT}ms.\nOutput: ${output}`));
    }, READY_TIMEOUT);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (text.includes('Ready on')) {
        clearTimeout(timeout);
        setTimeout(resolve, 500);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Wrangler exited with code ${code}.\nOutput: ${output}`));
      }
    });
  });
}

/**
 * Stop the wrangler dev process.
 */
export async function stopWrangler(): Promise<void> {
  if (!wranglerProcess) return;

  const proc = wranglerProcess;
  wranglerProcess = null;
  activePort = null;

  return new Promise<void>((resolve) => {
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 3000);
  });
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
