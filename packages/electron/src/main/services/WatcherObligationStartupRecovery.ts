/**
 * WatcherObligationStartupRecovery (NIM-364)
 *
 * At each stable app boot, give an operator-configured watcher-obligation
 * controller a chance to re-establish its own deadline processes after a
 * host/app restart. The controller itself (its script, its state, its
 * retry/versioning logic) lives entirely outside this product -- this hook
 * only spawns whatever argv-only adapter the operator has configured and
 * reports whether it reported recovery.
 *
 * Unconfigured is the default, expected state for the overwhelming majority
 * of installs: no `NIMBALYST_WATCHER_OBLIGATION_RECOVERY_ARGV` -> a silent
 * no-op, never an error. This hook never hardcodes any specific script path;
 * the argv is read from configuration only.
 */

import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../utils/logger';
import { redactPathsWithUuids } from '../../../../cli/src/utils/redactPathsWithUuids';

export { redactPathsWithUuids } from '../../../../cli/src/utils/redactPathsWithUuids';

const ARGV_ENV_VAR = 'NIMBALYST_WATCHER_OBLIGATION_RECOVERY_ARGV';
const CWD_ENV_VAR = 'NIMBALYST_WATCHER_OBLIGATION_RECOVERY_CWD';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4096;

export interface WatcherObligationRecoveryResult {
  recovered: boolean;
  reason: string;
  nonce: string;
}

export type RecoveryEnvSource = { [key: string]: string | undefined };

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean; stdio: ['ignore', 'pipe', 'pipe'] }
) => ChildProcess;

export interface RunWatcherObligationStartupRecoveryOptions {
  /** Stable, immutable-for-this-launch boot id; reused as the recovery nonce. */
  hostBootId: string;
  /** Defaults to process.env; overridable for tests. */
  env?: RecoveryEnvSource;
  /** Hard ceiling before the child is killed and treated as not recovered. */
  timeoutMs?: number;
  /** Injected for tests only; defaults to node's child_process.spawn. */
  spawnFn?: SpawnFn;
}

function parseArgv(raw: string | undefined): string[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((entry) => typeof entry === 'string' && entry.length > 0)) return null;
  return parsed as string[];
}

// Same-boot dedupe: a duplicate in-process call with the same nonce (e.g. a
// caller bug re-invoking the boot hook) must not spawn a second recovery
// child. This is in addition to -- not a substitute for -- the recovery
// command's own nonce-keyed idempotency on its side of the contract.
const recoveryAttemptsByNonce = new Map<string, Promise<WatcherObligationRecoveryResult>>();

function runConfiguredRecovery(params: {
  command: string;
  fullArgs: string[];
  cwd: string;
  hostBootId: string;
  timeoutMs: number;
  spawnFn: SpawnFn;
}): Promise<WatcherObligationRecoveryResult> {
  const { command, fullArgs, cwd, hostBootId, timeoutMs, spawnFn } = params;

  return new Promise<WatcherObligationRecoveryResult>((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      result: WatcherObligationRecoveryResult,
      beforeResolve?: () => void
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      beforeResolve?.();
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnFn(command, fullArgs, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish({
        recovered: false,
        reason: `spawn failed: ${redactPathsWithUuids(message)}`,
        nonce: hostBootId,
      });
      return;
    }

    const rejectOversizedOutput = () => {
      finish(
        {
          recovered: false,
          reason: 'output exceeded size limit',
          nonce: hostBootId,
        },
        () => {
          try {
            child.kill();
          } catch {
            // best-effort; the recovery attempt is already settled
          }
        }
      );
    };

    timer = setTimeout(() => {
      finish(
        { recovered: false, reason: 'timeout', nonce: hostBootId },
        () => {
          try {
            child.kill();
          } catch {
            // best-effort; the recovery attempt is already settled
          }
        }
      );
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
      if (stdoutBytes > MAX_OUTPUT_BYTES) rejectOversizedOutput();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
      if (stderrBytes > MAX_OUTPUT_BYTES) rejectOversizedOutput();
    });

    child.on('error', (err: Error) => {
      finish({
        recovered: false,
        reason: `spawn error: ${redactPathsWithUuids(err.message)}`,
        nonce: hostBootId,
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        const tail = redactPathsWithUuids((stderr || stdout).slice(0, 500));
        finish({
          recovered: false,
          reason: `recovery command exited ${code}${tail ? `: ${tail}` : ''}`,
          nonce: hostBootId,
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        finish({ recovered: false, reason: 'malformed recovery output', nonce: hostBootId });
        return;
      }
      const status = (parsed as { status?: unknown } | null)?.status;
      if (!parsed || typeof parsed !== 'object' || status !== 'recovered') {
        finish({ recovered: false, reason: 'unexpected recovery schema', nonce: hostBootId });
        return;
      }
      finish({ recovered: true, reason: 'recovery command reported recovered', nonce: hostBootId });
    });
  });
}

export async function runWatcherObligationStartupRecovery(
  options: RunWatcherObligationStartupRecoveryOptions
): Promise<WatcherObligationRecoveryResult> {
  const {
    hostBootId,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnFn = spawn as unknown as SpawnFn,
  } = options;

  if (!hostBootId) {
    return { recovered: false, reason: 'missing hostBootId', nonce: '' };
  }

  const priorAttempt = recoveryAttemptsByNonce.get(hostBootId);
  if (priorAttempt) {
    return priorAttempt;
  }

  const argv = parseArgv(env[ARGV_ENV_VAR]);
  if (!argv) {
    return {
      recovered: false,
      reason: 'not configured',
      nonce: hostBootId,
    };
  }

  const cwd = env[CWD_ENV_VAR] || process.cwd();
  const [command, ...leadingArgs] = argv;
  const fullArgs = [...leadingArgs, 'recover', '--nonce', hostBootId];

  // Defer the actual spawn to a microtask so the promise is cached
  // synchronously before any child process can be created.
  const recoveryPromise = Promise.resolve().then(() =>
    runConfiguredRecovery({ command, fullArgs, cwd, hostBootId, timeoutMs, spawnFn })
  );
  recoveryAttemptsByNonce.set(hostBootId, recoveryPromise);

  const result = await recoveryPromise;

  if (result.recovered) {
    logger.main.info(`[WatcherObligationStartupRecovery] recovered (nonce=${result.nonce})`);
  } else if (result.reason !== 'not configured') {
    logger.main.warn(`[WatcherObligationStartupRecovery] not recovered: ${result.reason}`);
  }

  return result;
}

/** Test-only: reset the same-boot dedupe cache between tests. */
export function __resetWatcherObligationRecoveryForTests(): void {
  recoveryAttemptsByNonce.clear();
}
