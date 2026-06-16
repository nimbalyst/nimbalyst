/**
 * Diagnostics for early native-binary startup crashes (GitHub issue #614).
 *
 * The bundled `claude` CLI is a Bun-compiled binary. When Bun's native startup
 * layer hits a syscall failure it prints a single generic stderr line --
 * `error: An unknown error occurred (Unexpected)` (sometimes with "possibly
 * due to low max file descriptors") -- and exits 1 before any stream-json
 * output or JS-level debug logging. In the #614 report the exact argv, env,
 * cwd, and SDK stdin protocol all succeeded when replayed outside the app, so
 * the suspects are process attributes inherited from Electron that argv/env
 * replication cannot reproduce: rlimits (Chromium mutates RLIMIT_NOFILE) and
 * the app's launch context. When we see this signature we log exactly those
 * attributes and arm the Agent SDK's debug mode for subsequent attempts in
 * this app run (the SDK then passes `--debug-file` to the CLI, giving us a
 * full CLI-side log of the crash if it gets far enough to write one).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Stderr signature of a Bun-runtime startup failure (not Claude Code app code). */
const BUN_CRASH_SIGNATURE = 'An unknown error occurred';

/**
 * True when a sendMessage failure looks like the Bun-runtime startup crash
 * from #614: the subprocess exited non-zero and stderr (or the enriched error
 * message) carries Bun's generic unknown-error line.
 */
export function isBunRuntimeSpawnCrash(
  errorMessage: string | undefined,
  stderrLines: readonly string[],
): boolean {
  const message = errorMessage ?? '';
  if (!/exited with code [1-9]/.test(message)) return false;
  const combined = stderrLines.join('\n') + '\n' + message;
  return combined.includes(BUN_CRASH_SIGNATURE);
}

export interface SpawnCrashContext {
  binaryPath?: string;
  cwd?: string;
}

/**
 * Collect the process attributes a child inherits from Electron that the #614
 * reporter could not replicate externally. Never includes env values.
 */
export function collectSpawnCrashDiagnostics(ctx: SpawnCrashContext): Record<string, unknown> {
  const diag: Record<string, unknown> = {
    binaryPath: ctx.binaryPath ?? null,
    cwd: ctx.cwd ?? null,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? null,
    debugAlreadyArmed: !!process.env.DEBUG_CLAUDE_AGENT_SDK,
  };

  if (ctx.binaryPath) {
    try {
      const stat = fs.statSync(ctx.binaryPath);
      diag.binaryExists = true;
      diag.binarySizeBytes = stat.size;
      fs.accessSync(ctx.binaryPath, fs.constants.X_OK);
      diag.binaryExecutable = true;
    } catch (error: any) {
      if (diag.binaryExists === undefined) diag.binaryExists = false;
      diag.binaryExecutable = false;
      diag.binaryAccessError = error?.code ?? String(error);
    }
  }
  if (ctx.cwd) {
    diag.cwdExists = fs.existsSync(ctx.cwd);
  }

  // Inherited resource limits -- the prime suspect for Bun's
  // "low max file descriptors" message family. process.report includes the
  // main process's userLimits, which children inherit verbatim.
  try {
    const report: any = (process as any).report?.getReport?.();
    const limits = report?.userLimits;
    if (limits) {
      diag.openFilesLimit = limits.open_files ?? null;
      diag.maxUserProcesses = limits.max_user_processes ?? null;
      diag.stackSizeBytes = limits.stack_size_bytes ?? null;
    }
  } catch {
    diag.userLimits = 'unavailable';
  }

  return diag;
}

/**
 * Arm the Agent SDK's debug mode for the rest of this app run. With
 * DEBUG_CLAUDE_AGENT_SDK set in the host process env, the SDK writes its own
 * debug log to `<claude config dir>/debug/sdk-<ts>.txt` AND passes that path
 * to the CLI as `--debug-file`, so the next failing spawn leaves a full
 * CLI-side debug log we can read back.
 *
 * Returns true when newly armed, false when it was already set.
 */
export function armAgentSdkDebugLogging(): boolean {
  if (process.env.DEBUG_CLAUDE_AGENT_SDK) return false;
  process.env.DEBUG_CLAUDE_AGENT_SDK = '1';
  return true;
}

/** Mirrors the SDK's config-dir resolution for its debug log location. */
function sdkDebugLogDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'debug');
}

/**
 * Read the tail of the most recent SDK/CLI debug log (written when debug mode
 * is armed). Returns null when no log exists yet.
 */
export async function readLatestSdkDebugLogTail(
  maxBytes = 16384,
): Promise<{ path: string; tail: string } | null> {
  const dir = sdkDebugLogDir();
  let newest: { filePath: string; mtimeMs: number } | null = null;
  try {
    for (const name of await fs.promises.readdir(dir)) {
      if (!/^sdk-.*\.txt$/.test(name)) continue;
      const filePath = path.join(dir, name);
      const stat = await fs.promises.stat(filePath);
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { filePath, mtimeMs: stat.mtimeMs };
      }
    }
  } catch {
    return null;
  }
  if (!newest) return null;

  try {
    const stat = await fs.promises.stat(newest.filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = await fs.promises.open(newest.filePath, 'r');
    try {
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return { path: newest.filePath, tail: buffer.toString('utf8') };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
