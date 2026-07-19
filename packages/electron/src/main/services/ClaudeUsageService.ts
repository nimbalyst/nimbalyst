/**
 * ClaudeUsageService - Tracks Claude Code API usage limits
 *
 * This service:
 * - Reads OAuth credentials from the platform credential store:
 *   - macOS: macOS Keychain (where Claude Code stores them)
 *   - Windows/Linux: ~/.claude/.credentials.json file
 * - Calls Anthropic's usage API to get 5-hour session and 7-day weekly limits
 * - Implements activity-aware polling (active when using Claude, sleeps when idle)
 * - Broadcasts usage updates to renderer via IPC
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import {
  aggregateCapacityState,
  applicableCapacityWindows,
  capacityError,
  normalizeCapacityModelId,
  normalizedTimestamp,
  ratioFromPercent,
  stateFromUsedRatio,
  type CapacityObservationError,
  type CapacityWindow,
  type ProviderCapacityObservation,
} from './provider-capacity-types';

export interface ClaudeUsageData {
  fiveHour: {
    utilization: number; // 0-100 percentage for the legacy renderer
    utilizationReported?: boolean;
    utilizationMalformed?: boolean;
    resetsAt: string | null; // ISO timestamp
    resetMalformed?: boolean;
  };
  sevenDay: {
    utilization: number;
    utilizationReported?: boolean;
    utilizationMalformed?: boolean;
    resetsAt: string | null;
    resetMalformed?: boolean;
  };
  sevenDayOpus?: {
    utilization: number;
    utilizationReported?: boolean;
    utilizationMalformed?: boolean;
    resetsAt: string | null;
    resetMalformed?: boolean;
  };
  lastUpdated: number; // Unix timestamp
  error?: string;
}

interface KeychainCredentials {
  claudeAiOauth?: {
    accessToken?: string;
  };
}

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code']; // Primary and fallback
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes before going to sleep
const KEYCHAIN_RETRY_DELAY_MS = 2000; // Retry delay for keychain errors (post-unlock)
const KEYCHAIN_MAX_RETRIES = 3;
const NETWORK_RETRY_DELAY_MS = 3000; // Retry delay for network errors
const NETWORK_MAX_RETRIES = 3;

export class ClaudeUsageServiceImpl {
  private cachedUsage: ClaudeUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;
  private refreshGeneration = 0;
  private inflightRefresh: Promise<ClaudeUsageData> | null = null;
  private claudeCodeVersion: string | null = null;

  /**
   * Initialize the service. Does not start polling until activity is detected.
   */
  initialize(): void {
    logger.main.info('[ClaudeUsageService] Initialized (sleeping until activity detected)');
  }

  private getClaudeCodeVersion(): string {
    if (this.claudeCodeVersion) return this.claudeCodeVersion;
    try {
      // Read the real Claude Code version from the SDK's manifest.json
      // (package.json has the npm version e.g. 0.2.69, but manifest.json has the actual CLI version e.g. 2.1.69)
      const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
      const manifest = JSON.parse(fs.readFileSync(path.join(sdkDir, 'manifest.json'), 'utf-8'));
      this.claudeCodeVersion = manifest.version || 'unknown';
    } catch {
      this.claudeCodeVersion = 'unknown';
    }
    return this.claudeCodeVersion!;
  }

  /**
   * Called when user sends a message to a Claude agent session.
   * Wakes up the service and triggers an immediate refresh.
   */
  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      // logger.main.info('[ClaudeUsageService] Waking up due to activity');
      this.isSleeping = false;
      this.startPolling();
      // Immediate refresh on wake
      await this.refresh();
    }
  }

  /**
   * Get the current cached usage data. Returns null if no data available.
   */
  getCachedUsage(): ClaudeUsageData | null {
    return this.cachedUsage;
  }

  async getCapacityObservation(
    requestedModel?: string,
    signal?: AbortSignal,
  ): Promise<ProviderCapacityObservation> {
    return toClaudeCapacityObservation(await this.doRefresh(signal), requestedModel);
  }

  /**
   * Force a refresh of usage data from the API.
   * Legacy renderer, polling, and activity callers share one provider read
   * and one cache/broadcast commit while that refresh is in flight.
   */
  async refresh(): Promise<ClaudeUsageData> {
    if (this.inflightRefresh) return this.inflightRefresh;

    const generation = ++this.refreshGeneration;
    const refresh = this.doRefresh().then((usageData) => {
      if (generation === this.refreshGeneration) this.commitUsage(usageData);
      return usageData;
    });
    this.inflightRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.inflightRefresh === refresh) this.inflightRefresh = null;
    }
  }

  private commitUsage(usageData: ClaudeUsageData): void {
    this.cachedUsage = usageData;
    this.broadcastUpdate();
  }

  private async doRefresh(signal?: AbortSignal): Promise<ClaudeUsageData> {
    try {
      throwIfAborted(signal);
      const token = this.getAccessToken();
      if (!token) {
        const source = process.platform === 'darwin' ? 'macOS Keychain' : '~/.claude/.credentials.json';
        logger.main.warn(
          `[ClaudeUsageService] No Claude OAuth token found in ${source}. ` +
          'Claude usage indicator will remain hidden until Claude Code login is restored.'
        );
        const errorData: ClaudeUsageData = {
          fiveHour: { utilization: 0, utilizationReported: false, resetsAt: null },
          sevenDay: { utilization: 0, utilizationReported: false, resetsAt: null },
          lastUpdated: Date.now(),
          error: 'No Claude Code credentials found. Please log in to Claude Code.',
        };
        return errorData;
      }

      return await this.fetchUsageData(token, signal);
    } catch (error) {
      throwIfAborted(signal);
      logger.main.error('[ClaudeUsageService] Usage refresh failed');
      const errorData: ClaudeUsageData = {
        fiveHour: { utilization: 0, utilizationReported: false, resetsAt: null },
        sevenDay: { utilization: 0, utilizationReported: false, resetsAt: null },
        lastUpdated: Date.now(),
        error: sanitizedClaudeUsageError(error),
      };
      return errorData;
    }
  }

  /**
   * Stop the service and clean up timers.
   */
  stop(): void {
    this.stopPolling();
    logger.main.info('[ClaudeUsageService] Stopped');
  }

  private startPolling(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);

    // logger.main.info('[ClaudeUsageService] Started polling (every 30 minutes)');
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  private async pollTick(): Promise<void> {
    // Check if we should go to sleep due to inactivity
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > IDLE_TIMEOUT_MS) {
      logger.main.info('[ClaudeUsageService] Going to sleep due to inactivity');
      this.isSleeping = true;
      this.stopPolling();
      return;
    }

    // Refresh usage data
    await this.refresh();
  }

  private getAccessToken(): string | null {
    if (process.platform === 'darwin') {
      return this.getAccessTokenFromKeychain();
    }
    // Windows and Linux: read from ~/.claude/.credentials.json
    return this.getAccessTokenFromCredentialsFile();
  }

  private getAccessTokenFromKeychain(): string | null {
    // Try each keychain service name (primary and fallback)
    for (const serviceName of KEYCHAIN_SERVICES) {
      const token = this.tryGetTokenFromKeychain(serviceName);
      if (token) {
        return token;
      }
    }

    logger.main.debug('[ClaudeUsageService] Claude Code credentials not found in any keychain entry');
    return null;
  }

  private getAccessTokenFromCredentialsFile(): string | null {
    try {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (!fs.existsSync(credentialsPath)) {
        logger.main.debug('[ClaudeUsageService] Credentials file not found');
        return null;
      }

      const fileContent = fs.readFileSync(credentialsPath, 'utf8');
      const credentials: KeychainCredentials = JSON.parse(fileContent);
      const token = credentials.claudeAiOauth?.accessToken;

      if (!token) {
        logger.main.debug('[ClaudeUsageService] No access token in credentials file');
        return null;
      }

      return token;
    } catch (error) {
      logger.main.warn('[ClaudeUsageService] Error reading credentials file');
      return null;
    }
  }

  private tryGetTokenFromKeychain(serviceName: string): string | null {
    try {
      // Read credentials from macOS Keychain
      const result = execSync(
        `security find-generic-password -s "${serviceName}" -w`,
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      // Parse the JSON credentials
      const credentials: KeychainCredentials = JSON.parse(result);
      const token = credentials.claudeAiOauth?.accessToken;

      if (!token) {
        logger.main.debug(`[ClaudeUsageService] No access token in keychain entry: ${serviceName}`);
        return null;
      }

      return token;
    } catch (error) {
      // Security command returns error if item not found - this is expected
      if (error instanceof Error && error.message.includes('could not be found')) {
        // Silent - will try fallback
        return null;
      }
      // Log other errors but continue to try fallback
      logger.main.warn(`[ClaudeUsageService] Error reading keychain entry ${serviceName}`);
      return null;
    }
  }

  private async fetchUsageData(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<ClaudeUsageData> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < NETWORK_MAX_RETRIES; attempt++) {
      try {
        throwIfAborted(signal);
        const response = await fetch(USAGE_API_URL, {
          method: 'GET',
          signal,
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': `claude-code/${this.getClaudeCodeVersion()}`,
          },
        });

        if (!response.ok) {
          if (response.status === 401) {
            // Non-retryable: auth expired
            logger.main.warn(
              '[ClaudeUsageService] Usage API returned 401 (unauthorized). Claude OAuth token is likely expired; user should re-login.'
            );
            throw new Error('Authentication expired. Please re-login to Claude Code.');
          }

          if (response.status === 403) {
            logger.main.warn(
              '[ClaudeUsageService] Usage API returned 403 (forbidden). ' +
              'User may be authenticated for Claude Code but missing usage API authorization.'
            );
            throw new Error(
              'Usage API access forbidden (403). Your account may not have usage API permissions.'
            );
          }

          if (response.status === 429) {
            // Non-retryable: rate limited. Don't make it worse by retrying.
            logger.main.warn(
              '[ClaudeUsageService] Usage API returned 429 (rate limited). Will retry at next poll interval.'
            );
            throw new Error('Rate limited (429). Will retry later.');
          }

          logger.main.warn(
            `[ClaudeUsageService] Usage API error response: ${response.status}`
          );
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        return convertClaudeUsageResponse(await response.json(), Date.now());
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry auth errors or rate limits
        if (lastError.message.includes('Authentication expired') ||
            lastError.message.includes('Rate limited') ||
            lastError.message.includes('access forbidden')) {
          throw lastError;
        }

        // Retry on network errors
        if (attempt < NETWORK_MAX_RETRIES - 1) {
          logger.main.warn(
            `[ClaudeUsageService] Fetch attempt ${attempt + 1} failed; retry scheduled`
          );
          await this.sleep(NETWORK_RETRY_DELAY_MS, signal);
        }
      }
    }

    throw lastError || new Error('Failed to fetch usage data after retries');
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private broadcastUpdate(): void {
    // Send update to all browser windows
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('claude-usage:update', this.cachedUsage);
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

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function convertClaudeRawWindow(value: unknown): ClaudeUsageData['fiveHour'] {
  const raw = isRecord(value) ? value : {};
  const hasUtilization = Object.prototype.hasOwnProperty.call(raw, 'utilization');
  const utilization = finiteNumberOrNull(raw.utilization);
  const hasReset = Object.prototype.hasOwnProperty.call(raw, 'resets_at');
  const resetsAt = typeof raw.resets_at === 'string' ? raw.resets_at : null;
  return {
    utilization: utilization ?? 0,
    utilizationReported: utilization !== null,
    utilizationMalformed: hasUtilization && utilization === null,
    resetsAt,
    resetMalformed: hasReset && raw.resets_at !== null && typeof raw.resets_at !== 'string',
  };
}

/** Allowlisted conversion at the raw Anthropic usage-response boundary. */
export function convertClaudeUsageResponse(
  value: unknown,
  lastUpdated = Date.now(),
): ClaudeUsageData {
  const raw = isRecord(value) ? value : {};
  return {
    fiveHour: convertClaudeRawWindow(raw.five_hour),
    sevenDay: convertClaudeRawWindow(raw.seven_day),
    ...(isRecord(raw.seven_day_opus)
      ? { sevenDayOpus: convertClaudeRawWindow(raw.seven_day_opus) }
      : {}),
    lastUpdated,
  };
}

function timestampFromMillis(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function claudeErrorCode(message: string): CapacityObservationError['code'] {
  if (/unsupported|not supported/i.test(message)) return 'unsupported';
  if (/credential|authentication|re-login|unauthori[sz]ed|forbidden/i.test(message)) {
    return 'auth-required';
  }
  if (/rate limit|429/i.test(message)) return 'rate-limited';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/network|fetch|unreachable|ECONN|ENOTFOUND/i.test(message)) return 'provider-unreachable';
  return 'unknown';
}

function sanitizedClaudeUsageError(error: unknown): string {
  const code = claudeErrorCode(error instanceof Error ? error.message : '');
  switch (code) {
    case 'auth-required':
      return 'Claude Code authentication is required.';
    case 'rate-limited':
      return 'Claude usage capacity is temporarily rate limited.';
    case 'timeout':
      return 'Claude usage capacity request timed out.';
    case 'provider-unreachable':
      return 'Claude usage capacity is unreachable.';
    case 'unsupported':
      return 'Claude usage capacity is unsupported.';
    default:
      return 'Claude usage capacity request failed.';
  }
}

function claudeWindow(
  id: string,
  label: string,
  scope: CapacityWindow['scope'],
  utilization: number,
  utilizationReported: boolean | undefined,
  utilizationMalformed: boolean | undefined,
  resetsAt: string | null,
  resetMalformed: boolean | undefined,
): { window: CapacityWindow; malformedRatio: boolean; malformedReset: boolean } {
  const reportedUtilization = utilizationReported === false ? null : utilization;
  const usedRatio = ratioFromPercent(reportedUtilization);
  const resetAt = normalizedTimestamp(resetsAt);
  const malformedRatio = utilizationMalformed === true
    || (reportedUtilization !== null && usedRatio === null);
  return {
    window: {
      id,
      label,
      scope,
      state: stateFromUsedRatio(usedRatio),
      usedRatio,
      remainingRatio: usedRatio === null ? null : 1 - usedRatio,
      usedUnits: reportedUtilization,
      remainingUnits: reportedUtilization === null ? null : 100 - reportedUtilization,
      unit: 'percent',
      resetAt,
      resetConfidence: resetAt ? 'provider-reported' : 'unknown',
      ...(malformedRatio ? { evidenceError: 'parse-error' as const } : {}),
    },
    malformedRatio,
    malformedReset: resetMalformed === true || (resetsAt !== null && resetAt === null),
  };
}

/** Convert the legacy indicator payload into the normalized allowlist. */
export function toClaudeCapacityObservation(
  usage: ClaudeUsageData | null,
  requestedModel?: string,
): ProviderCapacityObservation {
  const model = normalizeCapacityModelId('claude-code', requestedModel);
  if (!usage) {
    return {
      provider: 'claude-code',
      ...(model ? { model } : {}),
      observationState: 'unavailable',
      capacityState: 'unknown',
      observedAt: null,
      source: {
        kind: 'provider-response',
        confidence: 'none',
        collector: 'ClaudeUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError('collector-unavailable', true),
    };
  }

  if (usage.error) {
    const code = claudeErrorCode(usage.error);
    return {
      provider: 'claude-code',
      ...(model ? { model } : {}),
      observationState: code === 'unsupported'
        ? 'unsupported'
        : code === 'auth-required'
          ? 'unavailable'
          : 'error',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: code === 'unsupported' ? 'unsupported' : 'provider-response',
        confidence: 'none',
        collector: 'ClaudeUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError(code, code !== 'auth-required' && code !== 'unsupported'),
    };
  }

  const mapped = [
    claudeWindow(
      'five-hour',
      '5-hour',
      'account',
      usage.fiveHour.utilization,
      usage.fiveHour.utilizationReported,
      usage.fiveHour.utilizationMalformed,
      usage.fiveHour.resetsAt,
      usage.fiveHour.resetMalformed,
    ),
    claudeWindow(
      'weekly',
      'Weekly',
      'account',
      usage.sevenDay.utilization,
      usage.sevenDay.utilizationReported,
      usage.sevenDay.utilizationMalformed,
      usage.sevenDay.resetsAt,
      usage.sevenDay.resetMalformed,
    ),
    ...(usage.sevenDayOpus
      ? [claudeWindow(
        'weekly-opus',
        'Opus weekly',
        'model',
        usage.sevenDayOpus.utilization,
        usage.sevenDayOpus.utilizationReported,
        usage.sevenDayOpus.utilizationMalformed,
        usage.sevenDayOpus.resetsAt,
        usage.sevenDayOpus.resetMalformed,
      )]
      : []),
  ];
  const opus = mapped.find((item) => item.window.id === 'weekly-opus');
  if (opus) {
    opus.window.model = normalizeCapacityModelId('claude-code', 'opus');
    opus.window.modelMatch = 'family';
  }
  const windows = applicableCapacityWindows(mapped.map(({ window }) => window), model);
  const applicableIds = new Set(windows.map((window) => window.id));
  const applicableMapped = mapped.filter((item) => applicableIds.has(item.window.id));
  const malformedRatio = applicableMapped.some((item) => item.malformedRatio);
  const malformedReset = applicableMapped.some((item) => item.malformedReset);

  if (malformedRatio) {
    return {
      provider: 'claude-code',
      ...(model ? { model } : {}),
      observationState: 'error',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: 'provider-response',
        confidence: 'low',
        collector: 'ClaudeUsageService',
        providerReported: true,
      },
      windows,
      error: capacityError('parse-error', true),
    };
  }

  return {
    provider: 'claude-code',
    ...(model ? { model } : {}),
    observationState: 'ok',
    capacityState: aggregateCapacityState(windows),
    observedAt: timestampFromMillis(usage.lastUpdated),
    source: {
      kind: 'provider-response',
      confidence: malformedReset ? 'medium' : 'high',
      collector: 'ClaudeUsageService',
      providerReported: true,
    },
    windows,
    error: null,
  };
}

// Singleton instance
export const claudeUsageService = new ClaudeUsageServiceImpl();
