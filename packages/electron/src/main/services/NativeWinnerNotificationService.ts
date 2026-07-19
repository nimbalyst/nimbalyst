import { spawn, type ChildProcess } from 'child_process';
import { redactPathsWithUuids } from '../../../../cli/src/utils/redactPathsWithUuids';
import type {
  HostControlReceiptsStore,
  NativeWinnerOutboxRow,
} from './HostControlReceiptsStore';

const ARGV_ENV_VAR = 'NIMBALYST_NATIVE_WINNER_COMPANION_ARGV';
const CWD_ENV_VAR = 'NIMBALYST_NATIVE_WINNER_COMPANION_CWD';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 4096;

export type NativeWinnerSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean; stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess;

export type NativeWinnerEnv = Record<string, string | undefined>;

export interface NativeWinnerNotificationService {
  notify(input: {
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
  }): Promise<{ configured: boolean; sent: boolean }>;
  retryPending(): Promise<number>;
}

function parseArgv(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed)
      || parsed.length === 0
      || !parsed.every((value) => typeof value === 'string' && value.length > 0)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function boundExternalError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const redacted = redactPathsWithUuids(raw);
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function invokeCompanion(input: {
  row: NativeWinnerOutboxRow;
  command: string;
  leadingArgs: string[];
  cwd: string;
  timeoutMs: number;
  spawnFn: NativeWinnerSpawnFn;
}): Promise<{ sent: boolean; errorClass?: string; error?: string }> {
  const { row, command, leadingArgs, cwd, timeoutMs, spawnFn } = input;
  const args = [
    ...leadingArgs,
    'native-winner',
    '--session-id',
    row.sessionId,
    '--event-identity',
    row.eventIdentity,
    ...(row.attentionGeneration
      ? ['--attention-generation', row.attentionGeneration]
      : []),
  ];

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (
      result: { sent: boolean; errorClass?: string; error?: string },
      beforeResolve?: () => void,
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      beforeResolve?.();
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnFn(command, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ sent: false, errorClass: 'spawn_failed', error: boundExternalError(error) });
      return;
    }

    const oversized = () => finish(
      { sent: false, errorClass: 'output_too_large' },
      () => {
        try { child.kill(); } catch { /* best effort */ }
      },
    );

    timer = setTimeout(() => finish(
      { sent: false, errorClass: 'timeout' },
      () => {
        try { child.kill(); } catch { /* best effort */ }
      },
    ), timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
      if (stdoutBytes > MAX_OUTPUT_BYTES) oversized();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_OUTPUT_BYTES);
      if (stderrBytes > MAX_OUTPUT_BYTES) oversized();
    });
    child.on('error', (error: Error) => finish({
      sent: false,
      errorClass: 'spawn_error',
      error: boundExternalError(error),
    }));
    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code !== 0) {
        finish({
          sent: false,
          errorClass: 'nonzero_exit',
          error: boundExternalError((stderr || stdout).slice(0, 500)),
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim()) as { status?: unknown };
        if (parsed?.status !== 'recorded' && parsed?.status !== 'already_resolved') {
          finish({ sent: false, errorClass: 'unexpected_output' });
          return;
        }
        finish({ sent: true });
      } catch {
        finish({ sent: false, errorClass: 'malformed_output' });
      }
    });
  });
}

export function createNativeWinnerNotificationService(options: {
  store: Pick<
    HostControlReceiptsStore,
    'reserveNativeWinner' | 'listPendingNativeWinners' | 'recordNativeWinnerAttempt'
  >;
  env?: NativeWinnerEnv;
  timeoutMs?: number;
  spawnFn?: NativeWinnerSpawnFn;
  now?: () => Date;
}): NativeWinnerNotificationService {
  const {
    store,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawnFn = spawn as unknown as NativeWinnerSpawnFn,
    now = () => new Date(),
  } = options;
  const attempts = new Map<string, Promise<boolean>>();

  const getConfig = () => {
    const argv = parseArgv(env[ARGV_ENV_VAR]);
    if (!argv) return null;
    const [command, ...leadingArgs] = argv;
    return { command, leadingArgs, cwd: env[CWD_ENV_VAR] || process.cwd() };
  };

  const attempt = async (
    row: NativeWinnerOutboxRow,
    config: NonNullable<ReturnType<typeof getConfig>>,
  ): Promise<boolean> => {
    if (row.state === 'sent') return true;
    const existing = attempts.get(row.id);
    if (existing) return existing;

    const promise = (async () => {
      const attemptedAt = now().toISOString();
      const result = await invokeCompanion({
        row,
        ...config,
        timeoutMs,
        spawnFn,
      });
      const resultAt = now().toISOString();
      await store.recordNativeWinnerAttempt({
        id: row.id,
        sent: result.sent,
        receipt: {
          method: 'argv_companion',
          attemptedAt,
          resultAt,
          outcome: result.sent ? 'sent' : 'failed',
          ...(result.errorClass ? { errorClass: result.errorClass } : {}),
          ...(result.error ? { error: result.error } : {}),
        },
      });
      return result.sent;
    })().finally(() => attempts.delete(row.id));
    attempts.set(row.id, promise);
    return promise;
  };

  return {
    async notify(input) {
      const config = getConfig();
      if (!config) return { configured: false, sent: false };
      const generation = input.attentionGeneration || 'none';
      const reservationKey = [
        'native-winner',
        input.sessionId,
        input.eventIdentity,
        generation,
      ].join(':');
      const reserved = await store.reserveNativeWinner({
        reservationKey,
        sessionId: input.sessionId,
        eventIdentity: input.eventIdentity,
        attentionGeneration: input.attentionGeneration,
      });
      return { configured: true, sent: await attempt(reserved.row, config) };
    },

    async retryPending() {
      const config = getConfig();
      if (!config) return 0;
      const pending = await store.listPendingNativeWinners(20);
      let sent = 0;
      for (const row of pending) {
        if (await attempt(row, config)) sent += 1;
      }
      return sent;
    },
  };
}

let configuredStore: HostControlReceiptsStore | null = null;
let configuredService: NativeWinnerNotificationService | null = null;

export function configureNativeWinnerNotificationStore(
  store: HostControlReceiptsStore | null,
): void {
  configuredStore = store;
  configuredService = store ? createNativeWinnerNotificationService({ store }) : null;
}

export async function notifyNativeWinnerResolution(input: {
  sessionId: string;
  eventIdentity: string;
  attentionGeneration?: string;
}): Promise<{ configured: boolean; sent: boolean }> {
  if (!configuredStore || !configuredService) return { configured: false, sent: false };
  return configuredService.notify(input);
}

export async function notifyNativeWinnerAfterAttentionTransition(
  service: Pick<NativeWinnerNotificationService, 'notify'>,
  input: {
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
    respondedBy: 'desktop' | 'mobile' | 'telegram';
    cancelReason: 'answered' | 'cancelled';
    attentionCancelledCount: number;
  },
): Promise<{ configured: boolean; sent: boolean }> {
  if (
    input.respondedBy === 'telegram'
    || input.cancelReason !== 'answered'
    || input.attentionCancelledCount <= 0
  ) {
    return { configured: false, sent: false };
  }
  return service.notify({
    sessionId: input.sessionId,
    eventIdentity: input.eventIdentity,
    attentionGeneration: input.attentionGeneration,
  });
}

export async function settleInteractiveAttentionAfterResponse(
  deps: {
    cancelInteractivePrompt(
      sessionId: string,
      eventIdentity: string,
      reason: 'answered' | 'cancelled',
      options: { expectedGeneration?: string },
    ): Promise<number>;
    notificationService: Pick<NativeWinnerNotificationService, 'notify'>;
    onNotificationError?: (error: unknown) => void;
  },
  input: {
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
    respondedBy: 'desktop' | 'mobile' | 'telegram';
    cancelReason: 'answered' | 'cancelled';
  },
): Promise<number> {
  const attentionCancelledCount = await deps.cancelInteractivePrompt(
    input.sessionId,
    input.eventIdentity,
    input.cancelReason,
    { expectedGeneration: input.attentionGeneration },
  );
  try {
    await notifyNativeWinnerAfterAttentionTransition(deps.notificationService, {
      ...input,
      attentionCancelledCount,
    });
  } catch (error) {
    deps.onNotificationError?.(error);
  }
  return attentionCancelledCount;
}

const configuredNotificationFacade: NativeWinnerNotificationService = {
  notify: notifyNativeWinnerResolution,
  retryPending: retryPendingNativeWinnerNotifications,
};

export async function notifyConfiguredNativeWinnerAfterAttentionTransition(input: {
  sessionId: string;
  eventIdentity: string;
  attentionGeneration?: string;
  respondedBy: 'desktop' | 'mobile' | 'telegram';
  cancelReason: 'answered' | 'cancelled';
  attentionCancelledCount: number;
}): Promise<{ configured: boolean; sent: boolean }> {
  return notifyNativeWinnerAfterAttentionTransition(configuredNotificationFacade, input);
}

export async function settleConfiguredInteractiveAttentionAfterResponse(
  cancelInteractivePrompt: (
    sessionId: string,
    eventIdentity: string,
    reason: 'answered' | 'cancelled',
    options: { expectedGeneration?: string },
  ) => Promise<number>,
  input: {
    sessionId: string;
    eventIdentity: string;
    attentionGeneration?: string;
    respondedBy: 'desktop' | 'mobile' | 'telegram';
    cancelReason: 'answered' | 'cancelled';
  },
  onNotificationError?: (error: unknown) => void,
): Promise<number> {
  return settleInteractiveAttentionAfterResponse({
    cancelInteractivePrompt,
    notificationService: configuredNotificationFacade,
    onNotificationError,
  }, input);
}

export async function retryPendingNativeWinnerNotifications(): Promise<number> {
  if (!configuredStore || !configuredService) return 0;
  return configuredService.retryPending();
}

export const NATIVE_WINNER_COMPANION_ARGV_ENV = ARGV_ENV_VAR;
