/**
 * CodexUsageService - Tracks OpenAI Codex usage limits
 *
 * This service:
 * - Reads current limits through the Codex app-server account API
 * - Falls back to Codex CLI session files for older binaries
 * - Implements activity-aware polling (active when using Codex, sleeps when idle)
 * - Broadcasts usage updates to renderer via IPC
 *
 * Subscription users provide rate limits. If limits are missing (common for
 * API key sessions), we fall back to token usage so the indicator still
 * appears with limits unavailable.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BrowserWindow } from 'electron';
import type {
  AccountRateLimitSnapshot,
  AccountRateLimitsReadResponse,
} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/types';
import { logger } from '../utils/logger';
import { codexAuthService } from './CodexAuthService';
import {
  aggregateCapacityState,
  capacityModelMatches,
  capacityError,
  normalizeCapacityModelId,
  normalizedTimestamp,
  ratioFromPercent,
  stateFromRemainingRatio,
  stateFromUsedRatio,
  type CapacityObservationError,
  type CapacityWindow,
  type ProviderCapacityObservation,
} from './provider-capacity-types';

export interface CodexUsageWindow {
  slot: 'primary' | 'secondary';
  usedPercent: number;
  usedPercentReported?: boolean;
  usedPercentMalformed?: boolean;
  windowDurationMins: number | null;
  resetsAt: string | null;
  resetMalformed?: boolean;
}

export interface CodexUsageLimit {
  id: string;
  name: string | null;
  planType: string | null;
  windows: CodexUsageWindow[];
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    remainingPercentReported?: boolean;
    remainingPercentMalformed?: boolean;
    resetsAt: string | null;
    resetMalformed?: boolean;
  } | null;
  rateLimitReachedType: string | null;
  spendControlReached?: boolean | null;
}

export interface CodexUsageData {
  limits: CodexUsageLimit[];
  rateLimitResetCredits?: {
    availableCount: number;
    credits: Array<{
      id: string;
      title: string | null;
      description: string | null;
      expiresAt: string | null;
    }> | null;
  } | null;
  tokenUsage?: {
    totalTokens: number;
    lastTokens: number | null;
  };
  limitsAvailable?: boolean;
  source?: 'account' | 'session';
  lastUpdated: number; // Unix timestamp
  error?: string;
  errorCode?: CapacityObservationError['code'];
}

interface CodexRateLimits {
  limit_id?: string;
  primary?: {
    used_percent: number;
    window_minutes: number;
    resets_at: number; // Unix seconds
  } | null;
  secondary?: {
    used_percent: number;
    window_minutes: number;
    resets_at: number; // Unix seconds
  } | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance: number | null;
  } | null;
}

interface CodexTokenUsage {
  totalTokens: number;
  lastTokens: number | null;
}

interface CodexUsageSnapshot {
  rateLimits: CodexRateLimits | null;
  tokenUsage: CodexTokenUsage | null;
}

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes before going to sleep
const MAX_FILES_TO_CHECK = 5; // Check up to N recent session files for rate_limits

export class CodexUsageServiceImpl {
  private cachedUsage: CodexUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;
  private unsubscribeRateLimits: (() => void) | null = null;
  private refreshGeneration = 0;

  initialize(): void {
    this.unsubscribeRateLimits ??= codexAuthService.onRateLimitsUpdated(() => {
      void this.refresh().catch((error) => {
        logger.main.warn('[CodexUsageService] Failed to refresh after rate-limit update');
      });
    });
    logger.main.info('[CodexUsageService] Initialized (sleeping until activity detected)');
  }

  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      // logger.main.info('[CodexUsageService] Waking up due to activity');
      this.isSleeping = false;
      this.startPolling();
    }

    // ai:sendMessage resolves after the turn finishes, so refresh the canonical
    // account snapshot now rather than waiting for the background poll.
    await this.refresh();
  }

  getCachedUsage(): CodexUsageData | null {
    return this.cachedUsage;
  }

  async getCapacityObservation(
    requestedModel?: string,
    signal?: AbortSignal,
  ): Promise<ProviderCapacityObservation> {
    return toCodexCapacityObservation(await this.collectUsage(signal), requestedModel);
  }

  async refresh(): Promise<CodexUsageData> {
    const generation = ++this.refreshGeneration;
    const usageData = await this.collectUsage();
    if (generation === this.refreshGeneration) {
      this.cachedUsage = usageData;
      this.broadcastUpdate();
    }
    return usageData;
  }

  private async collectUsage(signal?: AbortSignal): Promise<CodexUsageData> {
    let accountReadFailure: CapacityObservationError['code'] | null = null;
    try {
      throwIfAborted(signal);
      try {
        const accountRateLimits = await codexAuthService.getRateLimits();
        throwIfAborted(signal);
        if (hasAccountRateLimits(accountRateLimits)) {
          return convertAccountRateLimitsResponse(accountRateLimits);
        }
      } catch (error) {
        throwIfAborted(signal);
        accountReadFailure = codexErrorCode(error instanceof Error ? error.message : '');
        logger.main.debug(
          '[CodexUsageService] account/rateLimits/read unavailable; falling back to session files'
        );
      }

      const snapshot = await this.findLatestUsageSnapshot(signal);
      throwIfAborted(signal);
      logger.main.debug(
        '[CodexUsageService] findLatestUsageSnapshot result:',
        snapshot.rateLimits ? 'rate limits' : snapshot.tokenUsage ? 'token usage' : 'null'
      );
      if (!snapshot.rateLimits && !snapshot.tokenUsage) {
        const errorCode = accountReadFailure ?? 'unsupported';
        const noData: CodexUsageData = {
          limits: [],
          lastUpdated: Date.now(),
          error: accountReadFailure
            ? codexUsageErrorMessage(errorCode)
            : 'No Codex usage data found. Use Codex CLI with a ChatGPT subscription to see usage.',
          errorCode,
        };
        return noData;
      }

      if (!snapshot.rateLimits && snapshot.tokenUsage) {
        const usageData: CodexUsageData = {
          limits: [],
          tokenUsage: snapshot.tokenUsage,
          limitsAvailable: false,
          source: 'session',
          lastUpdated: Date.now(),
        };
        return usageData;
      }

      const usageData = this.convertRateLimits(snapshot.rateLimits as CodexRateLimits);
      usageData.limitsAvailable = true;
      usageData.source = 'session';
      if (snapshot.tokenUsage) {
        usageData.tokenUsage = snapshot.tokenUsage;
      }
      return usageData;
    } catch (error) {
      throwIfAborted(signal);
      logger.main.error('[CodexUsageService] Usage refresh failed');
      const errorCode = codexErrorCode(error instanceof Error ? error.message : '');
      const errorData: CodexUsageData = {
        limits: [],
        lastUpdated: Date.now(),
        error: codexUsageErrorMessage(errorCode),
        errorCode,
      };
      return errorData;
    }
  }

  stop(): void {
    this.stopPolling();
    this.unsubscribeRateLimits?.();
    this.unsubscribeRateLimits = null;
    logger.main.info('[CodexUsageService] Stopped');
  }

  private startPolling(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);

    // logger.main.info('[CodexUsageService] Started polling (every 5 minutes)');
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
      logger.main.info('[CodexUsageService] Going to sleep due to inactivity');
      this.isSleeping = true;
      this.stopPolling();
      return;
    }

    await this.refresh();
  }

  /**
   * Find the latest usage data from recent Codex session files.
   * Walks the session directory tree to find the most recent files,
   * then reads them to extract rate_limits or token usage from token_count events.
   */
  private async findLatestUsageSnapshot(signal?: AbortSignal): Promise<CodexUsageSnapshot> {
    throwIfAborted(signal);
    if (!existsSync(CODEX_SESSIONS_DIR)) {
      logger.main.debug('[CodexUsageService] Sessions directory does not exist');
      return { rateLimits: null, tokenUsage: null };
    }

    const recentFiles = await this.getRecentSessionFiles(signal);
    throwIfAborted(signal);
    logger.main.debug('[CodexUsageService] Found session files:', recentFiles.length);
    if (recentFiles.length === 0) {
      return { rateLimits: null, tokenUsage: null };
    }

    let fallbackTokenUsage: CodexTokenUsage | null = null;

    // Check files from most recent to oldest
    for (const filePath of recentFiles.slice(0, MAX_FILES_TO_CHECK)) {
      throwIfAborted(signal);
      logger.main.debug('[CodexUsageService] Checking recent session usage file');
      const snapshot = await this.extractUsageSnapshotFromFile(filePath, signal);
      if (snapshot.tokenUsage && !fallbackTokenUsage) {
        fallbackTokenUsage = snapshot.tokenUsage;
      }
      if (snapshot.rateLimits) {
        logger.main.debug('[CodexUsageService] Found rate_limits in file');
        return { rateLimits: snapshot.rateLimits, tokenUsage: snapshot.tokenUsage ?? fallbackTokenUsage };
      }
    }

    return { rateLimits: null, tokenUsage: fallbackTokenUsage };
  }

  /**
   * Get recent session files sorted by modification time (newest first).
   */
  private async getRecentSessionFiles(signal?: AbortSignal): Promise<string[]> {
    const files: Array<{ path: string; mtime: number }> = [];

    try {
      throwIfAborted(signal);
      // Walk year/month/day directory structure
      const years = await this.getSortedSubdirs(CODEX_SESSIONS_DIR, signal);
      // Check most recent years first (reversed)
      for (const year of years.reverse().slice(0, 2)) {
        throwIfAborted(signal);
        const yearPath = join(CODEX_SESSIONS_DIR, year);
        const months = await this.getSortedSubdirs(yearPath, signal);
        for (const month of months.reverse().slice(0, 2)) {
          throwIfAborted(signal);
          const monthPath = join(yearPath, month);
          const days = await this.getSortedSubdirs(monthPath, signal);
          for (const day of days.reverse().slice(0, 3)) {
            throwIfAborted(signal);
            const dayPath = join(monthPath, day);
            const entries = await readdir(dayPath);
            const jsonlFiles = entries.filter((f: string) => f.endsWith('.jsonl') && f.startsWith('rollout-'));

            for (const file of jsonlFiles) {
              throwIfAborted(signal);
              const filePath = join(dayPath, file);
              try {
                const fileStat = await stat(filePath);
                files.push({ path: filePath, mtime: fileStat.mtimeMs });
              } catch {
                throwIfAborted(signal);
                // Skip files we can't stat
              }
            }
          }
          // If we have enough files, stop searching
          if (files.length >= MAX_FILES_TO_CHECK) break;
        }
        if (files.length >= MAX_FILES_TO_CHECK) break;
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.main.debug('[CodexUsageService] Error walking session directory');
    }

    // Sort by modification time, newest first
    files.sort((a, b) => b.mtime - a.mtime);
    return files.map((f: { path: string; mtime: number }) => f.path);
  }

  private async getSortedSubdirs(dirPath: string, signal?: AbortSignal): Promise<string[]> {
    try {
      throwIfAborted(signal);
      const entries = await readdir(dirPath, { withFileTypes: true });
      throwIfAborted(signal);
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      throwIfAborted(signal);
      return [];
    }
  }

  /**
   * Extract the latest token usage and rate_limits with at least one active window from a JSONL file.
   * Reads the entire file and scans for token_count events.
   */
  private async extractUsageSnapshotFromFile(
    filePath: string,
    signal?: AbortSignal,
  ): Promise<CodexUsageSnapshot> {
    let tokenUsage: CodexTokenUsage | null = null;
    let rateLimits: CodexRateLimits | null = null;

    try {
      throwIfAborted(signal);
      const content = await readFile(filePath, { encoding: 'utf8', signal });
      throwIfAborted(signal);
      const lines = content.split('\n');

      // Scan from the end for the latest token_count event and rate limits
      for (let i = lines.length - 1; i >= 0; i--) {
        throwIfAborted(signal);
        const line = lines[i].trim();
        if (!line) continue;

        try {
          const event = JSON.parse(line);
          if (!tokenUsage) {
            tokenUsage = this.extractTokenUsageFromEvent(event);
          }
          if (!rateLimits) {
            const candidate = this.extractRateLimitsFromEvent(event);
            if (candidate) {
              rateLimits = candidate;
              break;
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch (error) {
      throwIfAborted(signal);
      logger.main.debug('[CodexUsageService] Error reading recent session usage file');
    }

    return { rateLimits, tokenUsage };
  }

  private getTokenCountPayload(event: Record<string, unknown>): Record<string, unknown> | null {
    if (event.type === 'event_msg') {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload?.type === 'token_count') {
        return payload;
      }
      return null;
    }

    if (event.type === 'token_count') {
      return event;
    }

    return null;
  }

  /**
   * Extract rate_limits from a single JSONL event if it's a token_count event
   * with primary or secondary window data. Delegates to the pure `filterRateLimitsByExpiry`
   * helper below so the expiry logic stays unit-testable. See #120.
   */
  private extractRateLimitsFromEvent(event: Record<string, unknown>): CodexRateLimits | null {
    const tokenCountPayload = this.getTokenCountPayload(event);
    if (!tokenCountPayload) return null;

    const rateLimits = tokenCountPayload.rate_limits as CodexRateLimits | undefined;
    if (!rateLimits || (!rateLimits.primary && !rateLimits.secondary)) return null;

    return filterRateLimitsByExpiry(rateLimits, Date.now() / 1000);
  }

  private extractTokenUsageFromEvent(event: Record<string, unknown>): CodexTokenUsage | null {
    const tokenCountPayload = this.getTokenCountPayload(event);
    if (!tokenCountPayload) return null;

    const info = tokenCountPayload.info as
      | {
          total_token_usage?: { total_tokens?: number };
          last_token_usage?: { total_tokens?: number };
        }
      | undefined;
    const totalTokens = info?.total_token_usage?.total_tokens;
    if (typeof totalTokens !== 'number') return null;
    const lastTokens = typeof info?.last_token_usage?.total_tokens === 'number'
      ? info?.last_token_usage?.total_tokens
      : null;
    return { totalTokens, lastTokens };
  }

  private convertRateLimits(rateLimits: CodexRateLimits): CodexUsageData {
    return convertCodexSessionRateLimits(rateLimits, Date.now());
  }

  private broadcastUpdate(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('codex-usage:update', this.cachedUsage);
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

function hasAccountRateLimits(response: AccountRateLimitsReadResponse): boolean {
  return response.rateLimits !== null
    || Object.keys(response.rateLimitsByLimitId ?? {}).length > 0
    || (response.rateLimitResetCredits?.availableCount ?? 0) > 0;
}

function convertAccountWindow(
  slot: CodexUsageWindow['slot'],
  window: NonNullable<AccountRateLimitSnapshot['primary']>
): CodexUsageWindow {
  const usedPercent = finiteNumberOrNull(window.usedPercent);
  const windowDurationMins = finiteNumberOrNull(window.windowDurationMins);
  const resetsAt = safeIsoFromSeconds(window.resetsAt);
  const usedPercentPresent = Object.prototype.hasOwnProperty.call(window, 'usedPercent');
  const resetMalformed = window.resetsAt !== null
    && window.resetsAt !== undefined
    && resetsAt === null;
  return {
    slot,
    usedPercent: usedPercent ?? 0,
    ...(usedPercent === null ? { usedPercentReported: false } : {}),
    ...(usedPercentPresent && usedPercent === null ? { usedPercentMalformed: true } : {}),
    windowDurationMins,
    resetsAt,
    ...(resetMalformed ? { resetMalformed: true } : {}),
  };
}

function convertAccountLimit(
  snapshot: AccountRateLimitSnapshot,
  fallbackId: string
): CodexUsageLimit {
  const windows: CodexUsageWindow[] = [];
  if (snapshot.primary) windows.push(convertAccountWindow('primary', snapshot.primary));
  if (snapshot.secondary) windows.push(convertAccountWindow('secondary', snapshot.secondary));
  const remainingPercent = snapshot.individualLimit
    ? finiteNumberOrNull(snapshot.individualLimit.remainingPercent)
    : null;
  const individualResetAt = snapshot.individualLimit
    ? safeIsoFromSeconds(snapshot.individualLimit.resetsAt)
    : null;
  const individualResetMalformed = snapshot.individualLimit !== null
    && snapshot.individualLimit.resetsAt !== null
    && snapshot.individualLimit.resetsAt !== undefined
    && individualResetAt === null;

  return {
    id: snapshot.limitId ?? fallbackId,
    name: snapshot.limitName ?? null,
    planType: snapshot.planType ?? null,
    windows,
    credits: snapshot.credits,
    individualLimit: snapshot.individualLimit ? {
      limit: snapshot.individualLimit.limit,
      used: snapshot.individualLimit.used,
      remainingPercent: remainingPercent ?? 0,
      ...(remainingPercent === null
        ? { remainingPercentReported: false, remainingPercentMalformed: true }
        : {}),
      resetsAt: individualResetAt,
      ...(individualResetMalformed ? { resetMalformed: true } : {}),
    } : null,
    rateLimitReachedType: snapshot.rateLimitReachedType ?? null,
    spendControlReached: snapshot.spendControlReached ?? null,
  };
}

export function convertAccountRateLimitsResponse(
  response: AccountRateLimitsReadResponse,
  lastUpdated = Date.now(),
): CodexUsageData {
  const limits: CodexUsageLimit[] = [];
  const seenIds = new Set<string>();

  if (response.rateLimits) {
    const limit = convertAccountLimit(response.rateLimits, 'codex');
    limits.push(limit);
    seenIds.add(limit.id);
  }

  for (const [id, snapshot] of Object.entries(response.rateLimitsByLimitId ?? {})) {
    const effectiveId = snapshot.limitId ?? id;
    if (seenIds.has(effectiveId)) continue;
    limits.push(convertAccountLimit(snapshot, id));
    seenIds.add(effectiveId);
  }

  return {
    limits,
    rateLimitResetCredits: response.rateLimitResetCredits ? {
      availableCount: response.rateLimitResetCredits.availableCount,
      credits: response.rateLimitResetCredits.credits?.map((credit) => ({
        id: credit.id,
        title: credit.title,
        description: credit.description,
        expiresAt: safeIsoFromSeconds(credit.expiresAt),
      })) ?? null,
    } : null,
    limitsAvailable: limits.some((limit) => limit.windows.length > 0),
    source: 'account',
    lastUpdated,
  };
}

function convertLegacyWindow(
  slot: CodexUsageWindow['slot'],
  window: NonNullable<CodexRateLimits['primary']>
): CodexUsageWindow {
  const usedPercent = finiteNumberOrNull(window.used_percent);
  const windowDurationMins = finiteNumberOrNull(window.window_minutes);
  const resetsAt = safeIsoFromSeconds(window.resets_at);
  const usedPercentPresent = Object.prototype.hasOwnProperty.call(window, 'used_percent');
  const resetMalformed = window.resets_at !== null
    && window.resets_at !== undefined
    && resetsAt === null;
  return {
    slot,
    usedPercent: usedPercent ?? 0,
    ...(usedPercent === null ? { usedPercentReported: false } : {}),
    ...(usedPercentPresent && usedPercent === null ? { usedPercentMalformed: true } : {}),
    windowDurationMins,
    resetsAt,
    ...(resetMalformed ? { resetMalformed: true } : {}),
  };
}

/** Allowlisted conversion at the raw Codex JSONL rate-limit boundary. */
export function convertCodexSessionRateLimits(
  rateLimits: CodexRateLimits,
  lastUpdated = Date.now(),
): CodexUsageData {
  const windows: CodexUsageWindow[] = [];
  if (rateLimits.primary && typeof rateLimits.primary === 'object') {
    windows.push(convertLegacyWindow('primary', rateLimits.primary));
  }
  if (rateLimits.secondary && typeof rateLimits.secondary === 'object') {
    windows.push(convertLegacyWindow('secondary', rateLimits.secondary));
  }

  return {
    limits: [{
      id: typeof rateLimits.limit_id === 'string' ? rateLimits.limit_id : 'codex',
      name: null,
      planType: null,
      windows,
      credits: rateLimits.credits && typeof rateLimits.credits === 'object' ? {
        hasCredits: rateLimits.credits.has_credits === true,
        unlimited: rateLimits.credits.unlimited === true,
        balance: rateLimits.credits.balance === null ? null : String(rateLimits.credits.balance),
      } : null,
      individualLimit: null,
      rateLimitReachedType: null,
    }],
    limitsAvailable: windows.length > 0,
    source: 'session',
    lastUpdated,
  };
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeIsoFromSeconds(value: unknown): string | null {
  const seconds = finiteNumberOrNull(value);
  if (seconds === null) return null;
  const millis = seconds * 1_000;
  if (!Number.isFinite(millis)) return null;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function timestampFromMillis(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function codexErrorCode(message: string): CapacityObservationError['code'] {
  if (/unsupported|not supported/i.test(message)) return 'unsupported';
  if (/credential|authentication|login|unauthori[sz]ed|forbidden/i.test(message)) {
    return 'auth-required';
  }
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/rate limit|429/i.test(message)) return 'rate-limited';
  if (/unreachable|ECONN|ENOTFOUND|network/i.test(message)) return 'provider-unreachable';
  return 'unknown';
}

function codexUsageErrorMessage(code: CapacityObservationError['code']): string {
  switch (code) {
    case 'auth-required':
      return 'Codex authentication is required.';
    case 'rate-limited':
      return 'Codex usage capacity is temporarily rate limited.';
    case 'timeout':
      return 'Codex usage capacity request timed out.';
    case 'provider-unreachable':
      return 'Codex usage capacity is unreachable.';
    case 'unsupported':
      return 'Codex usage capacity is unsupported.';
    default:
      return 'Codex usage capacity request failed.';
  }
}

function normalizedWindowBaseId(window: CodexUsageWindow): string {
  if (window.windowDurationMins === 300) return 'five-hour';
  if (window.windowDurationMins === 10_080) return 'weekly';
  return 'provider-window';
}

function toCodexWindow(
  window: CodexUsageWindow,
  id: string,
  scope: CapacityWindow['scope'],
  model?: string,
): { window: CapacityWindow; malformedRatio: boolean; malformedReset: boolean } {
  const reportedUsedPercent = window.usedPercentReported === false ? null : window.usedPercent;
  const usedRatio = ratioFromPercent(reportedUsedPercent);
  const resetAt = normalizedTimestamp(window.resetsAt);
  const malformedRatio = window.usedPercentMalformed === true
    || (reportedUsedPercent !== null && usedRatio === null);
  return {
    window: {
      id,
      label: window.windowDurationMins === 300
        ? '5-hour'
        : window.windowDurationMins === 10_080
          ? 'Weekly'
          : 'Provider window',
      scope,
      ...(model ? { model } : {}),
      state: stateFromUsedRatio(usedRatio),
      usedRatio,
      remainingRatio: usedRatio === null ? null : 1 - usedRatio,
      usedUnits: typeof reportedUsedPercent === 'number' && Number.isFinite(reportedUsedPercent)
        ? reportedUsedPercent
        : null,
      remainingUnits: usedRatio === null ? null : 100 - reportedUsedPercent!,
      unit: 'percent',
      resetAt,
      resetConfidence: resetAt ? 'provider-reported' : 'unknown',
      ...(malformedRatio ? { evidenceError: 'parse-error' as const } : {}),
    },
    malformedRatio,
    malformedReset: window.resetMalformed === true
      || (window.resetsAt !== null && resetAt === null),
  };
}

/** Convert only allowlisted Codex usage fields into a provider observation. */
export function toCodexCapacityObservation(
  usage: CodexUsageData | null,
  requestedModel?: string,
): ProviderCapacityObservation {
  const model = normalizeCapacityModelId('openai-codex', requestedModel);
  if (!usage) {
    return {
      provider: 'openai-codex',
      ...(model ? { model } : {}),
      observationState: 'unavailable',
      capacityState: 'unknown',
      observedAt: null,
      source: {
        kind: 'provider-cli',
        confidence: 'none',
        collector: 'CodexUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError('collector-unavailable', true),
    };
  }

  if (usage.error) {
    const code = usage.errorCode ?? codexErrorCode(usage.error);
    if (code === 'unsupported' && /No Codex usage data found/i.test(usage.error)) {
      return {
        provider: 'openai-codex',
        ...(model ? { model } : {}),
        observationState: 'unsupported',
        capacityState: 'unknown',
        observedAt: timestampFromMillis(usage.lastUpdated),
        source: {
          kind: 'unsupported',
          confidence: 'none',
          collector: 'CodexUsageService',
          providerReported: false,
        },
        windows: [],
        error: capacityError('unsupported', false),
      };
    }
    return {
      provider: 'openai-codex',
      ...(model ? { model } : {}),
      observationState: code === 'unsupported'
        ? 'unsupported'
        : code === 'auth-required'
          ? 'unavailable'
          : 'error',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: code === 'unsupported' ? 'unsupported' : 'provider-cli',
        confidence: 'none',
        collector: 'CodexUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError(code, code !== 'auth-required' && code !== 'unsupported'),
    };
  }

  const hasStructuredLimit = usage.limits.some((limit) =>
    limit.windows.length > 0
    || limit.individualLimit !== null
    || Boolean(limit.rateLimitReachedType)
    || limit.spendControlReached === true);
  if (!hasStructuredLimit) {
    return {
      provider: 'openai-codex',
      ...(model ? { model } : {}),
      observationState: 'unsupported',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: 'unsupported',
        confidence: 'none',
        collector: 'CodexUsageService',
        providerReported: false,
      },
      windows: [],
      error: capacityError('unsupported', false),
    };
  }

  const windowIdCounts = new Map<string, number>();
  let malformedRatio = false;
  let malformedReset = false;
  let structuredHardLimit = false;
  const windows: CapacityWindow[] = [];

  for (const limit of usage.limits) {
    const scope: CapacityWindow['scope'] = limit.name ? 'model' : 'account';
    const limitModel = scope === 'model'
      ? normalizeCapacityModelId('openai-codex', limit.name)
      : undefined;
    if (
      scope === 'model'
      && model
      && !capacityModelMatches({
        id: 'model-applicability',
        scope: 'model',
        model: limitModel,
        state: 'unknown',
        usedRatio: null,
        remainingRatio: null,
        usedUnits: null,
        remainingUnits: null,
        unit: 'unknown',
        resetAt: null,
        resetConfidence: 'unknown',
      }, model)
    ) {
      continue;
    }
    for (const sourceWindow of limit.windows) {
      const baseId = normalizedWindowBaseId(sourceWindow);
      const occurrence = windowIdCounts.get(baseId) ?? 0;
      windowIdCounts.set(baseId, occurrence + 1);
      const id = occurrence === 0 ? baseId : `${baseId}-${occurrence + 1}`;
      const mapped = toCodexWindow(sourceWindow, id, scope, limitModel);
      windows.push(mapped.window);
      malformedRatio ||= mapped.malformedRatio;
      malformedReset ||= mapped.malformedReset;
    }

    if (limit.individualLimit) {
      const reportedRemainingPercent = limit.individualLimit.remainingPercentReported === false
        ? null
        : limit.individualLimit.remainingPercent;
      const remainingRatio = ratioFromPercent(reportedRemainingPercent);
      const resetAt = normalizedTimestamp(limit.individualLimit.resetsAt);
      const individualMalformedRatio = limit.individualLimit.remainingPercentMalformed === true
        || (reportedRemainingPercent !== null && remainingRatio === null);
      windows.push({
        id: 'individual-limit',
        label: 'Individual limit',
        scope: 'account',
        state: stateFromRemainingRatio(remainingRatio),
        usedRatio: remainingRatio === null ? null : 1 - remainingRatio,
        remainingRatio,
        usedUnits: null,
        remainingUnits: typeof reportedRemainingPercent === 'number'
          && Number.isFinite(reportedRemainingPercent)
          ? reportedRemainingPercent
          : null,
        unit: 'percent',
        resetAt,
        resetConfidence: resetAt ? 'provider-reported' : 'unknown',
        ...(individualMalformedRatio ? { evidenceError: 'parse-error' as const } : {}),
      });
      if (limit.spendControlReached === true) {
        windows[windows.length - 1].state = 'exhausted';
      }
      malformedRatio ||= individualMalformedRatio;
      malformedReset ||= limit.individualLimit.resetMalformed === true
        || (limit.individualLimit.resetsAt !== null && resetAt === null);
    }

    const reachedType = limit.rateLimitReachedType?.toLowerCase() ?? '';
    if (reachedType === 'primary' || reachedType === 'secondary') {
      const reachedSlot = limit.windows.findIndex((candidate) => candidate.slot === reachedType);
      if (reachedSlot >= 0) {
        const baseIndex = windows.length - limit.windows.length - (limit.individualLimit ? 1 : 0);
        const reachedWindow = windows[baseIndex + reachedSlot];
        if (reachedWindow) reachedWindow.state = 'exhausted';
      }
    }
    structuredHardLimit ||= Boolean(limit.rateLimitReachedType) || limit.spendControlReached === true;
  }

  if (structuredHardLimit && !windows.some((window) => window.state === 'exhausted')) {
    windows.push({
      id: 'provider-hard-limit',
      label: 'Provider hard limit',
      scope: 'provider',
      state: 'exhausted',
      usedRatio: null,
      remainingRatio: null,
      usedUnits: null,
      remainingUnits: null,
      unit: 'unknown',
      resetAt: null,
      resetConfidence: 'unknown',
    });
  }

  if (malformedRatio && !structuredHardLimit) {
    return {
      provider: 'openai-codex',
      ...(model ? { model } : {}),
      observationState: 'error',
      capacityState: 'unknown',
      observedAt: timestampFromMillis(usage.lastUpdated),
      source: {
        kind: 'provider-cli',
        confidence: 'low',
        collector: 'CodexUsageService',
        providerReported: true,
      },
      windows,
      error: capacityError('parse-error', true),
    };
  }

  return {
    provider: 'openai-codex',
    ...(model ? { model } : {}),
    observationState: 'ok',
    capacityState: structuredHardLimit ? 'exhausted' : aggregateCapacityState(windows),
    observedAt: timestampFromMillis(usage.lastUpdated),
    source: {
      kind: structuredHardLimit ? 'provider-error' : 'provider-cli',
      confidence: malformedRatio ? 'low' : malformedReset ? 'medium' : 'high',
      collector: 'CodexUsageService',
      providerReported: true,
    },
    windows,
    error: null,
  };
}

// Singleton instance
export const codexUsageService = new CodexUsageServiceImpl();

/**
 * Drop expired buckets from a CodexRateLimits block.
 *
   * Each primary/secondary slot carries its own `resets_at` Unix-seconds timestamp.
   * Slot position does not identify its duration. After the reset moment the historical `used_percent`
 * no longer matches reality - but the JSONL session file that produced the line is
 * never rewritten, so the same stale value keeps coming back from the
 * scan-backward loop in `extractUsageSnapshotFromFile`. That is the bug behind
 * #120: indicator sat at 91% indefinitely after the 5-hour window reset and the
 * user's real usage was 0%.
 *
 * Returns null when both windows are absent or expired so the caller can keep
 * scanning older lines for a still-active block. If nothing is active anywhere,
 * the higher-level snapshot falls through to `limitsAvailable: false` and the
 * renderer shows `--` rather than a stale percentage.
 *
 * Exported for unit-testing. Production callers pass `Date.now() / 1000`.
 */
export function filterRateLimitsByExpiry(
  rateLimits: CodexRateLimits,
  nowSeconds: number
): CodexRateLimits | null {
  const primary = rateLimits.primary ?? null;
  const secondary = rateLimits.secondary ?? null;

  const primaryActive =
    primary !== null &&
    (typeof primary.resets_at !== 'number' || primary.resets_at > nowSeconds);
  const secondaryActive =
    secondary !== null &&
    (typeof secondary.resets_at !== 'number' || secondary.resets_at > nowSeconds);

  if (!primaryActive && !secondaryActive) return null;

  return {
    ...rateLimits,
    primary: primaryActive ? primary : null,
    secondary: secondaryActive ? secondary : null,
  };
}

// Exported only for tests. Do not consume from production code.
export type { CodexRateLimits };
