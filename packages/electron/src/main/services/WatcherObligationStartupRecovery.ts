/**
 * Gives an operator-configured watcher controller one bounded opportunity to
 * re-establish durable attention deadlines after this app process restarts.
 */
import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../utils/logger';

const ARGV_ENV_VAR = 'NIMBALYST_WATCHER_OBLIGATION_RECOVERY_ARGV';
const CWD_ENV_VAR = 'NIMBALYST_WATCHER_OBLIGATION_RECOVERY_CWD';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4096;
const UUID_PATH_SEGMENT = /([\\/])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=([\\/]|$))/gi;

export interface WatcherObligationRecoveryResult {
  recovered: boolean;
  reason: string;
  nonce: string;
}

export type RecoveryEnvSource = Record<string, string | undefined>;
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean; stdio: ['ignore', 'pipe', 'pipe'] }
) => ChildProcess;

export interface RunWatcherObligationStartupRecoveryOptions {
  hostBootId: string;
  env?: RecoveryEnvSource;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}

function redactUuidPathSegments(value: string): string {
  return value.replace(UUID_PATH_SEGMENT, '$1...[redacted]');
}

function parseArgv(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((entry) => typeof entry === 'string' && entry.length > 0)
    ) {
      return null;
    }
    return parsed as string[];
  } catch {
    return null;
  }
}

const attemptsByBootId = new Map<string, Promise<WatcherObligationRecoveryResult>>();

function runConfiguredRecovery(params: {
  command: string;
  args: string[];
  cwd: string;
  hostBootId: string;
  timeoutMs: number;
  spawnFn: SpawnFn;
}): Promise<WatcherObligationRecoveryResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let outputBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      result: WatcherObligationRecoveryResult,
      beforeResolve?: () => void
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      beforeResolve?.();
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = params.spawnFn(params.command, params.args, {
        cwd: params.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finish({
        recovered: false,
        reason: `spawn failed: ${redactUuidPathSegments(message)}`,
        nonce: params.hostBootId,
      });
      return;
    }

    const stopChild = (): void => {
      try {
        child.kill();
      } catch {
        // The bounded attempt is already settled.
      }
    };

    timer = setTimeout(() => {
      finish(
        { recovered: false, reason: 'timeout', nonce: params.hostBootId },
        stopChild
      );
    }, params.timeoutMs);
    timer.unref?.();

    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finish(
          { recovered: false, reason: 'output exceeded size limit', nonce: params.hostBootId },
          stopChild
        );
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      // stderr is deliberately not retained: controller output may contain
      // operator-sensitive details and is not needed for the bounded receipt.
    };
    child.stdout?.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));

    child.on('error', (error: Error) => {
      finish({
        recovered: false,
        reason: `spawn error: ${redactUuidPathSegments(error.message)}`,
        nonce: params.hostBootId,
      });
    });

    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        finish({
          recovered: false,
          reason: `recovery command exited ${code}`,
          nonce: params.hostBootId,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim()) as { status?: unknown };
        if (parsed?.status !== 'recovered') throw new Error('unexpected schema');
      } catch {
        finish({
          recovered: false,
          reason: 'malformed recovery output',
          nonce: params.hostBootId,
        });
        return;
      }

      finish({
        recovered: true,
        reason: 'recovery command reported recovered',
        nonce: params.hostBootId,
      });
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

  const priorAttempt = attemptsByBootId.get(hostBootId);
  if (priorAttempt) return priorAttempt;

  const argv = parseArgv(env[ARGV_ENV_VAR]);
  if (!argv) {
    return { recovered: false, reason: 'not configured', nonce: hostBootId };
  }

  const [command, ...leadingArgs] = argv;
  const recoveryPromise = Promise.resolve().then(() =>
    runConfiguredRecovery({
      command,
      args: [...leadingArgs, 'recover', '--nonce', hostBootId],
      cwd: env[CWD_ENV_VAR] || process.cwd(),
      hostBootId,
      timeoutMs,
      spawnFn,
    })
  );
  attemptsByBootId.set(hostBootId, recoveryPromise);

  const result = await recoveryPromise;
  if (result.recovered) {
    logger.main.info(`[WatcherObligationStartupRecovery] recovered (nonce=${result.nonce})`);
  } else {
    logger.main.warn(`[WatcherObligationStartupRecovery] not recovered: ${result.reason}`);
  }
  return result;
}

export function __resetWatcherObligationRecoveryForTests(): void {
  attemptsByBootId.clear();
}
