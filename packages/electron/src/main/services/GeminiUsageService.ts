/**
 * GeminiUsageService - Tracks Gemini (Antigravity) usage limits
 *
 * This service:
 * - Reads usage/quota from the gemini-antigravity backend module's
 *   getUsageSnapshot() RPC (account credits + per-model quota)
 * - Implements activity-aware polling (active when using Gemini, sleeps when idle)
 * - Broadcasts usage updates to renderer via IPC
 *
 * Unlike CodexUsageService (which reads CLI session files), the data source
 * here is the privileged extension host. The poll is strictly read-only and
 * NEVER spawns the language server: if the server isn't running yet, the
 * backend's getUsageSnapshot returns { available:false } and we render a muted
 * "--" chip with the reason in the tooltip, exactly like Codex's unavailable
 * branch.
 *
 * Mirrors CodexUsageService 1:1 in structure: same poll cadence, idle sleep,
 * cached snapshot, broadcast pattern. The only differences are the data source
 * (RPC instead of file scan) and the channel name ('gemini-usage:update').
 */

import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { getPrivilegedExtensionHost } from '../extensions/PrivilegedExtensionHost';
import { windowStates, resolveActiveWorkspacePath } from '../window/windowState';
import {
  aggregateCapacityState,
  applicableCapacityWindows,
  capacityError,
  normalizeCapacityModelId,
  normalizedTimestamp,
  stateFromRemainingRatio,
  validatedRatio,
  type CapacityObservationError,
  type CapacityWindow,
  type ProviderCapacityObservation,
} from './provider-capacity-types';

const GEMINI_EXTENSION_ID = 'gemini-antigravity';
const GEMINI_BACKEND_MODULE_ID = 'antigravity-server';

// Friendly chip/popover text for the normal pre-first-request state, where
// the backend module has not started yet. Shown instead of the raw host
// "[PrivilegedExtensionHost] module not running" string.
const GEMINI_NOT_STARTED_MESSAGE = 'Gemini usage will appear after your first request.';

export interface GeminiUsageData {
  fiveHour: {
    utilization: number; // 0-100 percentage
    resetsAt: string | null; // ISO timestamp
  };
  sevenDay: {
    utilization: number;
    resetsAt: string | null;
  };
  credits?: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: number | null;
  };
  tokenUsage?: {
    totalTokens: number;
    lastTokens: number | null;
  };
  modelQuotas?: Array<{
    model: string;
    remainingFraction: number | null;
    remainingFractionReported?: boolean;
    remainingFractionMalformed?: boolean;
    resetTime: string | null;
    resetMalformed?: boolean;
  }>;
  limitsAvailable?: boolean;
  available?: boolean;
  lastUpdated: number; // Unix timestamp
  error?: string;
  /** True when the backend module has not started yet (benign idle state, not an error). */
  notStarted?: boolean;
}

/**
 * Shape returned by the backend module's getUsageSnapshot RPC. Kept loose here
 * so the main package doesn't depend on the extension's build output. Mirrors
 * UsageSnapshotResult / AntigravityUsageSnapshot.
 */
export interface AntigravityModelQuota {
  model: string;
  label?: string;
  remainingFraction?: number; // 0..1
  resetTime?: string; // ISO8601 UTC
}

interface AntigravityAccountUsage {
  name?: string;
  email?: string;
  tier?: string;
  planName?: string;
  monthlyPromptCredits?: number;
  monthlyFlowCredits?: number;
  availablePromptCredits?: number;
  availableFlowCredits?: number;
}

interface AntigravityUsageSnapshot {
  account: AntigravityAccountUsage;
  models: Record<string, AntigravityModelQuota>;
  warn: boolean;
}

type GeminiUsageSnapshotResult =
  | { available: true; snapshot: AntigravityUsageSnapshot }
  | { available: false; error: string; notStarted?: boolean };

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes before going to sleep

export class GeminiUsageServiceImpl {
  private cachedUsage: GeminiUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;
  private refreshGeneration = 0;

  initialize(): void {
    logger.main.info('[GeminiUsageService] Initialized (sleeping until activity detected)');
  }

  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      this.isSleeping = false;
      this.startPolling();
      await this.refresh();
    }
  }

  getCachedUsage(): GeminiUsageData | null {
    return this.cachedUsage;
  }

  async getCapacityObservation(
    requestedModel?: string,
    signal?: AbortSignal,
  ): Promise<ProviderCapacityObservation> {
    return toGeminiCapacityObservation(await this.collectUsage(signal), requestedModel);
  }

  async refresh(): Promise<GeminiUsageData> {
    const generation = ++this.refreshGeneration;
    const usageData = await this.collectUsage();
    if (generation === this.refreshGeneration) {
      this.cachedUsage = usageData;
      this.broadcastUpdate();
    }
    return usageData;
  }

  private async collectUsage(signal?: AbortSignal): Promise<GeminiUsageData> {
    try {
      throwIfAborted(signal);
      const result = await this.fetchSnapshot(signal);
      throwIfAborted(signal);

      if (!result || result.available === false) {
        return this.makeUnavailable(
          result?.error ?? 'Gemini usage data unavailable',
          result?.notStarted ?? false,
        );
      }

      return this.convertSnapshot(result.snapshot);
    } catch (error) {
      throwIfAborted(signal);
      logger.main.error('[GeminiUsageService] Usage refresh failed');
      return this.makeUnavailable(
        error instanceof Error ? error.message : '',
      );
    }
  }

  stop(): void {
    this.stopPolling();
    logger.main.info('[GeminiUsageService] Stopped');
  }

  private startPolling(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  private async pollTick(): Promise<void> {
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > IDLE_TIMEOUT_MS) {
      logger.main.info('[GeminiUsageService] Going to sleep due to inactivity');
      this.isSleeping = true;
      this.stopPolling();
      return;
    }

    await this.refresh();
  }

  /**
   * Resolve the active workspace the same way installExtensionAgentBridge does:
   * focused BrowserWindow -> its workspacePath, falling back to any window with
   * one open. Returns null if no window has a workspace.
   */
  private resolveActiveWorkspace(): string | null {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      const state = windowStates.get(focused.id);
      const path = resolveActiveWorkspacePath(state);
      if (path) return path;
    }
    for (const state of windowStates.values()) {
      const path = resolveActiveWorkspacePath(state);
      if (path) return path;
    }
    return null;
  }

  /**
   * Ask the gemini-antigravity backend module for a usage snapshot. Never
   * throws and never spawns: any failure (module not running, no workspace,
   * server not started, rpc error) resolves to an unavailable result so the
   * caller renders the muted chip.
   */
  private async fetchSnapshot(signal?: AbortSignal): Promise<GeminiUsageSnapshotResult> {
    throwIfAborted(signal);
    const workspacePath = this.resolveActiveWorkspace();
    if (!workspacePath) {
      return { available: false, notStarted: true, error: 'Open a workspace to see Gemini usage.' };
    }

    try {
      const result = await awaitWithAbort(
        getPrivilegedExtensionHost().request<GeminiUsageSnapshotResult>({
          extensionId: GEMINI_EXTENSION_ID,
          moduleId: GEMINI_BACKEND_MODULE_ID,
          workspacePath,
          method: 'getUsageSnapshot',
          params: {},
          requiredPermission: null,
        }),
        signal,
      );
      if (!result || typeof result !== 'object') {
        return { available: false, error: 'Gemini usage snapshot unavailable' };
      }
      return result;
    } catch (error) {
      throwIfAborted(signal);
      // The backend module starts on first use, so "module not running" and
      // similar pre-start states are the normal idle case, not an error. Map
      // them to a friendly notStarted state so the chip never surfaces the raw
      // "[PrivilegedExtensionHost] module not running" host string. Genuine RPC
      // errors still surface as an error.
      const raw = error instanceof Error ? error.message : '';
      const idle = raw === '' || /module not running|not started|server not started/i.test(raw);
      return idle
        ? { available: false, notStarted: true, error: GEMINI_NOT_STARTED_MESSAGE }
        : { available: false, error: raw };
    }
  }

  private makeUnavailable(error: string, notStarted = false): GeminiUsageData {
    return {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      limitsAvailable: false,
      available: false,
      lastUpdated: Date.now(),
      error: sanitizedGeminiUsageError(error, notStarted),
      notStarted,
    };
  }

  /**
   * Map an AntigravityUsageSnapshot into the chip's GeminiUsageData shape.
   *
   * The Codex chip drives its ring off `fiveHour.utilization` (0-100). Gemini's
   * snapshot exposes per-model `remainingFraction` (0..1) and a `resetTime`, so
   * we pick the model with the LOWEST remaining quota (most-constrained window)
   * for the primary ring -- utilization = (1 - remainingFraction) * 100 -- and
   * the next-most-constrained for the secondary ring. Account credits map onto
   * the optional `credits` block.
   */
  private convertSnapshot(snapshot: AntigravityUsageSnapshot): GeminiUsageData {
    return convertGeminiUsageSnapshot(snapshot, Date.now());
  }

  private broadcastUpdate(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('gemini-usage:update', this.cachedUsage);
      }
    }
  }
}

function abortError(): Error {
  const error = new Error('The capacity observation was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortError()));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Allowlisted conversion at the raw privileged-extension snapshot boundary. */
export function convertGeminiUsageSnapshot(
  value: unknown,
  lastUpdated = Date.now(),
): GeminiUsageData {
  const snapshot = isRecord(value) ? value : {};
  const rawModels = isRecord(snapshot.models) ? snapshot.models : {};
  const modelQuotas: NonNullable<GeminiUsageData['modelQuotas']> = [];

  for (const [fallbackModel, value] of Object.entries(rawModels)) {
    if (!isRecord(value)) continue;
    const hasRemaining = Object.prototype.hasOwnProperty.call(value, 'remainingFraction');
    const remainingFraction = typeof value.remainingFraction === 'number'
      && Number.isFinite(value.remainingFraction)
      ? value.remainingFraction
      : null;
    const hasReset = Object.prototype.hasOwnProperty.call(value, 'resetTime');
    modelQuotas.push({
      model: typeof value.model === 'string' && value.model.trim() ? value.model : fallbackModel,
      remainingFraction,
      remainingFractionReported: remainingFraction !== null,
      remainingFractionMalformed: hasRemaining && remainingFraction === null,
      resetTime: typeof value.resetTime === 'string' ? value.resetTime : null,
      resetMalformed: hasReset && value.resetTime !== null && typeof value.resetTime !== 'string',
    });
  }

  const validQuotas = modelQuotas
    .filter((quota) => quota.remainingFraction !== null)
    .sort((a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1));
  const toUtilization = (quota?: typeof validQuotas[number]): number => {
    if (quota?.remainingFraction === null || quota?.remainingFraction === undefined) return 0;
    return Math.max(0, Math.min(100, (1 - quota.remainingFraction) * 100));
  };

  const data: GeminiUsageData = {
    fiveHour: {
      utilization: toUtilization(validQuotas[0]),
      resetsAt: validQuotas[0]?.resetTime ?? null,
    },
    sevenDay: {
      utilization: toUtilization(validQuotas[1]),
      resetsAt: validQuotas[1]?.resetTime ?? null,
    },
    limitsAvailable: modelQuotas.length > 0,
    available: true,
    lastUpdated,
    modelQuotas,
  };

  const account = isRecord(snapshot.account) ? snapshot.account : null;
  if (account) {
    const balance = typeof account.availablePromptCredits === 'number'
      && Number.isFinite(account.availablePromptCredits)
      ? account.availablePromptCredits
      : null;
    const monthly = typeof account.monthlyPromptCredits === 'number'
      && Number.isFinite(account.monthlyPromptCredits)
      ? account.monthlyPromptCredits
      : null;
    data.credits = {
      hasCredits: balance !== null && balance > 0,
      unlimited: monthly !== null && monthly <= 0,
      balance,
    };
  }

  return data;
}

function timestampFromMillis(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function geminiErrorCode(message: string): CapacityObservationError['code'] {
  if (/unsupported|not supported/i.test(message)) return 'unsupported';
  if (/credential|authentication|login|unauthori[sz]ed|forbidden/i.test(message)) {
    return 'auth-required';
  }
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/rate limit|429/i.test(message)) return 'rate-limited';
  if (/unreachable|ECONN|ENOTFOUND|network|RPC/i.test(message)) return 'provider-unreachable';
  return 'unknown';
}

function sanitizedGeminiUsageError(error: string, notStarted: boolean): string {
  if (notStarted) {
    return error === 'Open a workspace to see Gemini usage.'
      ? error
      : GEMINI_NOT_STARTED_MESSAGE;
  }
  const code = geminiErrorCode(error);
  switch (code) {
    case 'auth-required':
      return 'Gemini authentication is required.';
    case 'rate-limited':
      return 'Gemini usage capacity is temporarily rate limited.';
    case 'timeout':
      return 'Gemini usage capacity request timed out.';
    case 'provider-unreachable':
      return 'Gemini usage capacity is unreachable.';
    case 'unsupported':
      return 'Gemini usage capacity is unsupported.';
    default:
      return 'Gemini usage capacity request failed.';
  }
}

function safeModelId(value: string, ordinal: number): string {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? `model:${value}` : `model:${ordinal + 1}`;
}

function geminiModelWindow(
  quota: NonNullable<GeminiUsageData['modelQuotas']>[number],
  ordinal: number,
): { window: CapacityWindow; malformedRatio: boolean; malformedReset: boolean } {
  const reportedRemaining = quota.remainingFractionReported === false
    ? null
    : quota.remainingFraction;
  const remainingRatio = validatedRatio(reportedRemaining);
  const resetAt = normalizedTimestamp(quota.resetTime);
  const malformedRatio = quota.remainingFractionMalformed === true
    || (reportedRemaining !== null && remainingRatio === null);
  return {
    window: {
      id: safeModelId(quota.model, ordinal),
      scope: 'model',
      model: normalizeCapacityModelId('gemini-cli', quota.model),
      state: stateFromRemainingRatio(remainingRatio),
      usedRatio: remainingRatio === null ? null : 1 - remainingRatio,
      remainingRatio,
      usedUnits: remainingRatio === null ? null : (1 - remainingRatio) * 100,
      remainingUnits: remainingRatio === null ? null : remainingRatio * 100,
      unit: 'percent',
      resetAt,
      resetConfidence: resetAt ? 'provider-reported' : 'unknown',
      ...(malformedRatio ? { evidenceError: 'parse-error' as const } : {}),
    },
    malformedRatio,
    malformedReset: quota.resetMalformed === true
      || (quota.resetTime !== null && resetAt === null),
  };
}

/** Convert the extension result into an account-identity-free allowlist. */
export function toGeminiCapacityObservation(
  usage: GeminiUsageData | null,
  requestedModel?: string,
): ProviderCapacityObservation {
  const model = normalizeCapacityModelId('gemini-cli', requestedModel);
  if (!usage) {
    return {
      provider: 'gemini-cli',
      ...(model ? { model } : {}),
      observationState: 'unavailable',
      capacityState: 'unknown',
      observedAt: null,
      source: {
        kind: 'provider-response',
        confidence: 'none',
        collector: 'GeminiUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError('collector-unavailable', true),
    };
  }

  if (usage.error || usage.available === false) {
    const code = usage.notStarted
      ? 'collector-unavailable'
      : geminiErrorCode(usage.error ?? '');
    return {
      provider: 'gemini-cli',
      ...(model ? { model } : {}),
      observationState: code === 'unsupported'
        ? 'unsupported'
        : code === 'auth-required' || code === 'collector-unavailable'
          ? 'unavailable'
          : 'error',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: code === 'unsupported' ? 'unsupported' : 'provider-response',
        confidence: 'none',
        collector: 'GeminiUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError(code, code !== 'auth-required' && code !== 'unsupported'),
    };
  }

  if (!usage.modelQuotas || usage.modelQuotas.length === 0 || usage.limitsAvailable === false) {
    return {
      provider: 'gemini-cli',
      ...(model ? { model } : {}),
      observationState: 'unsupported',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: 'unsupported',
        confidence: 'none',
        collector: 'GeminiUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError('unsupported', false),
    };
  }

  const mapped = usage.modelQuotas.map(geminiModelWindow);
  const windows = applicableCapacityWindows(mapped.map(({ window }) => window), model);
  const applicableIds = new Set(windows.map((window) => window.id));
  const applicableMapped = mapped.filter((item) => applicableIds.has(item.window.id));
  const malformedRatio = applicableMapped.some((item) => item.malformedRatio);
  const malformedReset = applicableMapped.some((item) => item.malformedReset);
  if (malformedRatio) {
    return {
      provider: 'gemini-cli',
      ...(model ? { model } : {}),
      observationState: 'error',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: 'provider-response',
        confidence: 'low',
        collector: 'GeminiUsageService',
        providerReported: true,
      },
      windows,
      error: capacityError('parse-error', true),
    };
  }

  return {
    provider: 'gemini-cli',
    ...(model ? { model } : {}),
    observationState: 'ok',
    capacityState: aggregateCapacityState(windows),
    observedAt: timestampFromMillis(usage.lastUpdated),
    source: {
      kind: 'provider-response',
      confidence: malformedReset ? 'medium' : 'high',
      collector: 'GeminiUsageService',
      providerReported: true,
    },
    windows,
    error: null,
  };
}

// Singleton instance
export const geminiUsageService = new GeminiUsageServiceImpl();
