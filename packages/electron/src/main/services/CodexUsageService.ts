/**
 * CodexUsageService - Tracks OpenAI Codex usage limits
 *
 * This service:
 * - Reads Codex CLI session files from ~/.codex/sessions/
 * - Extracts rate_limits data from token_count events in JSONL files
 * - Implements activity-aware polling (active when using Codex, sleeps when idle)
 * - Broadcasts usage updates to renderer via IPC
 *
 * Subscription users provide rate_limits. If rate_limits are missing
 * (common for API key sessions), we fall back to token usage so the
 * indicator still appears with limits unavailable.
 */

import { open, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

export interface CodexUsageData {
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
  limitsAvailable?: boolean;
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
const POLL_INTERVAL_MS = 60 * 1000; // Active Codex turns can update limits quickly.
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes before going to sleep
const CACHE_TTL_MS = 60 * 1000;
const ACTIVITY_REFRESH_DEBOUNCE_MS = 1_000;
const MAX_FILES_TO_CHECK = 64; // Check recent files by mtime, not path date.
const MAX_JSONL_TAIL_BYTES = 4 * 1024 * 1024;

class CodexUsageServiceImpl {
  private cachedUsage: CodexUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private activityRefreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<CodexUsageData> | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;

  initialize(): void {
    logger.main.info('[CodexUsageService] Initialized (sleeping until activity detected)');
  }

  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      // logger.main.info('[CodexUsageService] Waking up due to activity');
      this.isSleeping = false;
      this.startPolling();
    }

    this.scheduleActivityRefresh();
  }

  getCachedUsage(): CodexUsageData | null {
    return this.cachedUsage;
  }

  async getUsage(maxAgeMs: number = CACHE_TTL_MS): Promise<CodexUsageData> {
    const cached = this.cachedUsage;
    if (cached && Date.now() - cached.lastUpdated <= maxAgeMs) {
      return cached;
    }
    return this.refresh();
  }

  async refresh(): Promise<CodexUsageData> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshImpl().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async refreshImpl(): Promise<CodexUsageData> {
    try {
      const snapshot = await this.findLatestUsageSnapshot();
      logger.main.debug(
        '[CodexUsageService] findLatestUsageSnapshot result:',
        snapshot.rateLimits ? 'rate limits' : snapshot.tokenUsage ? 'token usage' : 'null'
      );
      if (!snapshot.rateLimits && !snapshot.tokenUsage) {
        const noData: CodexUsageData = {
          fiveHour: { utilization: 0, resetsAt: null },
          sevenDay: { utilization: 0, resetsAt: null },
          lastUpdated: Date.now(),
          error: 'No Codex usage data found. Use Codex CLI with a ChatGPT subscription to see usage.',
        };
        this.cachedUsage = noData;
        this.broadcastUpdate();
        return noData;
      }

      if (!snapshot.rateLimits && snapshot.tokenUsage) {
        const usageData: CodexUsageData = {
          fiveHour: { utilization: 0, resetsAt: null },
          sevenDay: { utilization: 0, resetsAt: null },
          tokenUsage: snapshot.tokenUsage,
          limitsAvailable: false,
          lastUpdated: Date.now(),
        };
        this.cachedUsage = usageData;
        this.broadcastUpdate();
        return usageData;
      }

      const usageData = this.convertRateLimits(snapshot.rateLimits as CodexRateLimits);
      usageData.limitsAvailable = true;
      if (snapshot.tokenUsage) {
        usageData.tokenUsage = snapshot.tokenUsage;
      }
      this.cachedUsage = usageData;
      this.broadcastUpdate();
      return usageData;
    } catch (error) {
      logger.main.error('[CodexUsageService] Error refreshing usage:', error);
      const errorData: CodexUsageData = {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: 0, resetsAt: null },
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
    if (this.activityRefreshTimer) {
      clearTimeout(this.activityRefreshTimer);
      this.activityRefreshTimer = null;
    }
    logger.main.info('[CodexUsageService] Stopped');
  }

  private scheduleActivityRefresh(): void {
    if (this.activityRefreshTimer) return;

    this.activityRefreshTimer = setTimeout(() => {
      this.activityRefreshTimer = null;
      void this.refresh();
    }, ACTIVITY_REFRESH_DEBOUNCE_MS);
  }

  private startPolling(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);

    // logger.main.info('[CodexUsageService] Started active polling');
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
   *
   * Codex keeps appending to a rollout file that lives under the date the
   * session was created. Long-running sessions can therefore update files in
   * older calendar folders. Walk all session folders and sort by mtime rather
   * than assuming the newest path date has the newest usage event.
   */
  private async getRecentSessionFiles(): Promise<string[]> {
    const files: Array<{ path: string; mtime: number }> = [];

    try {
      await this.collectSessionFiles(CODEX_SESSIONS_DIR, files, 0);
    } catch (error) {
      logger.main.debug('[CodexUsageService] Error walking session directory:', error);
    }

    // Sort by modification time, newest first
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, MAX_FILES_TO_CHECK).map((f: { path: string; mtime: number }) => f.path);
  }

  private async collectSessionFiles(
    dirPath: string,
    files: Array<{ path: string; mtime: number }>,
    depth: number,
  ): Promise<void> {
    if (depth > 4) return;

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await this.collectSessionFiles(entryPath, files, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        try {
          const fileStat = await stat(entryPath);
          files.push({ path: entryPath, mtime: fileStat.mtimeMs });
        } catch {
          // Skip files we can't stat.
        }
      }
    } catch {
      // Ignore unreadable directories; other session folders may still work.
    }
  }

  /**
   * Extract the latest token usage and rate_limits with non-null primary from a JSONL file.
   * Reads the entire file and scans for token_count events.
   */
  private async extractUsageSnapshotFromFile(filePath: string): Promise<CodexUsageSnapshot> {
    let tokenUsage: CodexTokenUsage | null = null;
    let rateLimits: CodexRateLimits | null = null;

    try {
      const content = await this.readRecentJsonl(filePath);
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

  private async readRecentJsonl(filePath: string): Promise<string> {
    const file = await open(filePath, 'r');
    try {
      const fileStat = await file.stat();
      const length = Math.min(fileStat.size, MAX_JSONL_TAIL_BYTES);
      const start = Math.max(0, fileStat.size - length);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, start);
      let content = buffer.toString('utf8');
      if (start > 0) {
        const firstNewline = content.indexOf('\n');
        content = firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
      }
      return content;
    } finally {
      await file.close();
    }
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
   * with active limit data. Delegates to the pure `filterRateLimitsByExpiry`
   * helper below so the expiry logic stays unit-testable. See #120.
   */
  private extractRateLimitsFromEvent(event: Record<string, unknown>): CodexRateLimits | null {
    const tokenCountPayload = this.getTokenCountPayload(event);
    if (!tokenCountPayload) return null;

    const rateLimits = tokenCountPayload.rate_limits as CodexRateLimits | undefined;
    if (!rateLimits?.primary && !rateLimits?.secondary) return null;

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
    const data: CodexUsageData = {
      fiveHour: {
        utilization: this.normalizeUtilization(rateLimits.primary?.used_percent),
        resetsAt: rateLimits.primary?.resets_at
          ? new Date(rateLimits.primary.resets_at * 1000).toISOString()
          : null,
      },
      sevenDay: {
        utilization: this.normalizeUtilization(rateLimits.secondary?.used_percent),
        resetsAt: rateLimits.secondary?.resets_at
          ? new Date(rateLimits.secondary.resets_at * 1000).toISOString()
          : null,
      },
      lastUpdated: Date.now(),
    };

    if (rateLimits.credits) {
      data.credits = {
        hasCredits: rateLimits.credits.has_credits,
        unlimited: rateLimits.credits.unlimited,
        balance: rateLimits.credits.balance,
      };
    }

    return data;
  }

  private normalizeUtilization(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(100, numeric));
  }

  private broadcastUpdate(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('codex-usage:update', this.cachedUsage);
      }
    }
    if (this.cachedUsage) {
      for (const listener of codexUsageUpdateListeners) {
        try {
          listener(this.cachedUsage);
        } catch {
          // Listener errors must not break the window broadcast path.
        }
      }
    }
  }

  getCached(): CodexUsageData | null {
    return this.cachedUsage;
  }
}

// Out-of-window subscribers (e.g. mobile settings sync) that want refreshed
// usage without an IPC round trip.
const codexUsageUpdateListeners = new Set<(usage: CodexUsageData) => void>();
export function onCodexUsageUpdate(listener: (usage: CodexUsageData) => void): () => void {
  codexUsageUpdateListeners.add(listener);
  return () => codexUsageUpdateListeners.delete(listener);
}

// Singleton instance
export const codexUsageService = new CodexUsageServiceImpl();

/**
 * Drop expired buckets from a CodexRateLimits block.
 *
 * Each window (primary 5h, secondary 7d) carries its own `resets_at` Unix-seconds
 * timestamp. After that moment the window resets and the historical `used_percent`
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
