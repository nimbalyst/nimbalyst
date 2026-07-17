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

export interface CodexUsageWindow {
  slot: 'primary' | 'secondary';
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
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
    resetsAt: string;
  } | null;
  rateLimitReachedType: string | null;
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

class CodexUsageServiceImpl {
  private cachedUsage: CodexUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;
  private unsubscribeRateLimits: (() => void) | null = null;

  initialize(): void {
    this.unsubscribeRateLimits ??= codexAuthService.onRateLimitsUpdated(() => {
      void this.refresh().catch((error) => {
        logger.main.warn('[CodexUsageService] Failed to refresh after rate-limit update:', error);
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

  async refresh(): Promise<CodexUsageData> {
    try {
      try {
        const accountRateLimits = await codexAuthService.getRateLimits();
        if (hasAccountRateLimits(accountRateLimits)) {
          const usageData = convertAccountRateLimitsResponse(accountRateLimits);
          this.cachedUsage = usageData;
          this.broadcastUpdate();
          return usageData;
        }
      } catch (error) {
        logger.main.debug(
          '[CodexUsageService] account/rateLimits/read unavailable; falling back to session files:',
          error
        );
      }

      const snapshot = await this.findLatestUsageSnapshot();
      logger.main.debug(
        '[CodexUsageService] findLatestUsageSnapshot result:',
        snapshot.rateLimits ? 'rate limits' : snapshot.tokenUsage ? 'token usage' : 'null'
      );
      if (!snapshot.rateLimits && !snapshot.tokenUsage) {
        const noData: CodexUsageData = {
          limits: [],
          lastUpdated: Date.now(),
          error: 'No Codex usage data found. Use Codex CLI with a ChatGPT subscription to see usage.',
        };
        this.cachedUsage = noData;
        this.broadcastUpdate();
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
        this.cachedUsage = usageData;
        this.broadcastUpdate();
        return usageData;
      }

      const usageData = this.convertRateLimits(snapshot.rateLimits as CodexRateLimits);
      usageData.limitsAvailable = true;
      usageData.source = 'session';
      if (snapshot.tokenUsage) {
        usageData.tokenUsage = snapshot.tokenUsage;
      }
      this.cachedUsage = usageData;
      this.broadcastUpdate();
      return usageData;
    } catch (error) {
      logger.main.error('[CodexUsageService] Error refreshing usage:', error);
      const errorData: CodexUsageData = {
        limits: [],
        lastUpdated: Date.now(),
        error: error instanceof Error ? error.message : 'Unknown error reading Codex session files',
      };
      this.cachedUsage = errorData;
      this.broadcastUpdate();
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
  private async findLatestUsageSnapshot(): Promise<CodexUsageSnapshot> {
    if (!existsSync(CODEX_SESSIONS_DIR)) {
      logger.main.debug('[CodexUsageService] Sessions directory does not exist:', CODEX_SESSIONS_DIR);
      return { rateLimits: null, tokenUsage: null };
    }

    const recentFiles = await this.getRecentSessionFiles();
    logger.main.debug('[CodexUsageService] Found session files:', recentFiles.length);
    if (recentFiles.length === 0) {
      return { rateLimits: null, tokenUsage: null };
    }

    let fallbackTokenUsage: CodexTokenUsage | null = null;

    // Check files from most recent to oldest
    for (const filePath of recentFiles.slice(0, MAX_FILES_TO_CHECK)) {
      logger.main.debug('[CodexUsageService] Checking file:', filePath);
      const snapshot = await this.extractUsageSnapshotFromFile(filePath);
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
  private async getRecentSessionFiles(): Promise<string[]> {
    const files: Array<{ path: string; mtime: number }> = [];

    try {
      // Walk year/month/day directory structure
      const years = await this.getSortedSubdirs(CODEX_SESSIONS_DIR);
      // Check most recent years first (reversed)
      for (const year of years.reverse().slice(0, 2)) {
        const yearPath = join(CODEX_SESSIONS_DIR, year);
        const months = await this.getSortedSubdirs(yearPath);
        for (const month of months.reverse().slice(0, 2)) {
          const monthPath = join(yearPath, month);
          const days = await this.getSortedSubdirs(monthPath);
          for (const day of days.reverse().slice(0, 3)) {
            const dayPath = join(monthPath, day);
            const entries = await readdir(dayPath);
            const jsonlFiles = entries.filter((f: string) => f.endsWith('.jsonl') && f.startsWith('rollout-'));

            for (const file of jsonlFiles) {
              const filePath = join(dayPath, file);
              try {
                const fileStat = await stat(filePath);
                files.push({ path: filePath, mtime: fileStat.mtimeMs });
              } catch {
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
      logger.main.debug('[CodexUsageService] Error walking session directory:', error);
    }

    // Sort by modification time, newest first
    files.sort((a, b) => b.mtime - a.mtime);
    return files.map((f: { path: string; mtime: number }) => f.path);
  }

  private async getSortedSubdirs(dirPath: string): Promise<string[]> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Extract the latest token usage and rate_limits with at least one active window from a JSONL file.
   * Reads the entire file and scans for token_count events.
   */
  private async extractUsageSnapshotFromFile(filePath: string): Promise<CodexUsageSnapshot> {
    let tokenUsage: CodexTokenUsage | null = null;
    let rateLimits: CodexRateLimits | null = null;

    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n');

      // Scan from the end for the latest token_count event and rate limits
      for (let i = lines.length - 1; i >= 0; i--) {
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
      logger.main.debug(`[CodexUsageService] Error reading file ${filePath}:`, error);
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
    const windows: CodexUsageWindow[] = [];
    if (rateLimits.primary) {
      windows.push(convertLegacyWindow('primary', rateLimits.primary));
    }
    if (rateLimits.secondary) {
      windows.push(convertLegacyWindow('secondary', rateLimits.secondary));
    }

    const data: CodexUsageData = {
      limits: [{
        id: rateLimits.limit_id ?? 'codex',
        name: null,
        planType: null,
        windows,
        credits: rateLimits.credits ? {
          hasCredits: rateLimits.credits.has_credits,
          unlimited: rateLimits.credits.unlimited,
          balance: rateLimits.credits.balance === null ? null : String(rateLimits.credits.balance),
        } : null,
        individualLimit: null,
        rateLimitReachedType: null,
      }],
      lastUpdated: Date.now(),
    };
    return data;
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

function hasAccountRateLimits(response: AccountRateLimitsReadResponse): boolean {
  return response.rateLimits !== null
    || Object.keys(response.rateLimitsByLimitId ?? {}).length > 0
    || (response.rateLimitResetCredits?.availableCount ?? 0) > 0;
}

function convertAccountWindow(
  slot: CodexUsageWindow['slot'],
  window: NonNullable<AccountRateLimitSnapshot['primary']>
): CodexUsageWindow {
  return {
    slot,
    usedPercent: window.usedPercent,
    windowDurationMins: window.windowDurationMins,
    resetsAt: typeof window.resetsAt === 'number'
      ? new Date(window.resetsAt * 1000).toISOString()
      : null,
  };
}

function convertAccountLimit(
  snapshot: AccountRateLimitSnapshot,
  fallbackId: string
): CodexUsageLimit {
  const windows: CodexUsageWindow[] = [];
  if (snapshot.primary) windows.push(convertAccountWindow('primary', snapshot.primary));
  if (snapshot.secondary) windows.push(convertAccountWindow('secondary', snapshot.secondary));

  return {
    id: snapshot.limitId ?? fallbackId,
    name: snapshot.limitName ?? null,
    planType: snapshot.planType ?? null,
    windows,
    credits: snapshot.credits,
    individualLimit: snapshot.individualLimit ? {
      limit: snapshot.individualLimit.limit,
      used: snapshot.individualLimit.used,
      remainingPercent: snapshot.individualLimit.remainingPercent,
      resetsAt: new Date(snapshot.individualLimit.resetsAt * 1000).toISOString(),
    } : null,
    rateLimitReachedType: snapshot.rateLimitReachedType ?? null,
  };
}

export function convertAccountRateLimitsResponse(
  response: AccountRateLimitsReadResponse
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
        expiresAt: typeof credit.expiresAt === 'number'
          ? new Date(credit.expiresAt * 1000).toISOString()
          : null,
      })) ?? null,
    } : null,
    limitsAvailable: limits.some((limit) => limit.windows.length > 0),
    source: 'account',
    lastUpdated: Date.now(),
  };
}

function convertLegacyWindow(
  slot: CodexUsageWindow['slot'],
  window: NonNullable<CodexRateLimits['primary']>
): CodexUsageWindow {
  return {
    slot,
    usedPercent: window.used_percent,
    windowDurationMins: window.window_minutes,
    resetsAt: window.resets_at
      ? new Date(window.resets_at * 1000).toISOString()
      : null,
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
