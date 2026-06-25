/**
 * FuguUsageService - Tracks Sakana Fugu usage limits and request tokens.
 *
 * Sakana exposes OpenAI-compatible response usage, but the account-limit
 * endpoint is not documented in the public API docs. This service prefers a
 * configured/account endpoint when available and falls back to persisted Fugu
 * token usage so the indicator can still show useful data.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { database } from '../database/PGLiteDatabaseWorker';

export interface FuguUsageData {
  fiveHour: {
    utilization: number;
    resetsAt: string | null;
  };
  sevenDay: {
    utilization: number;
    resetsAt: string | null;
  };
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    sessionCount: number;
    lastSessionUpdatedAt: number | null;
  };
  limitsAvailable?: boolean;
  accountUsageConfigured?: boolean;
  accountUsageError?: string | null;
  lastUpdated: number;
  error?: string;
}

interface FuguCredentials {
  apiKey: string | null;
  accountToken: string | null;
  baseUrl: string;
  usageLimitUrl: string | null;
}

interface FuguUsageWindow {
  utilization: number;
  resetsAt: string | null;
}

interface FuguTokenUsageAggregate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  sessionCount: number;
  lastSessionUpdatedAt: number | null;
}

const FUGU_ENV_PATH = join(homedir(), '.config', 'nimbalyst-secrets', 'sakana-fugu.env');
const DEFAULT_BASE_URL = 'https://api.sakana.ai/v1';
const POLL_INTERVAL_MS = 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const ACTIVITY_REFRESH_DEBOUNCE_MS = 1_000;
const ACCOUNT_ENDPOINT_RETRY_MS = 60 * 60 * 1000;

class FuguUsageServiceImpl {
  private cachedUsage: FuguUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private activityRefreshTimer: NodeJS.Timeout | null = null;
  private refreshInFlight: Promise<FuguUsageData> | null = null;
  private lastActivityTime = 0;
  private isPolling = false;
  private isSleeping = true;
  private accountEndpointUnsupportedUntil = 0;
  private accountUsageError: string | null = null;

  initialize(): void {
    logger.main.info('[FuguUsageService] Initialized (sleeping until activity detected)');
  }

  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      this.isSleeping = false;
      this.startPolling();
    }

    this.scheduleActivityRefresh();
  }

  getCachedUsage(): FuguUsageData | null {
    return this.cachedUsage;
  }

  getCached(): FuguUsageData | null {
    return this.cachedUsage;
  }

  async getUsage(maxAgeMs: number = CACHE_TTL_MS): Promise<FuguUsageData> {
    const cached = this.cachedUsage;
    if (cached && Date.now() - cached.lastUpdated <= maxAgeMs) {
      return cached;
    }
    return this.refresh();
  }

  async refresh(): Promise<FuguUsageData> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshImpl().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  stop(): void {
    this.stopPolling();
    if (this.activityRefreshTimer) {
      clearTimeout(this.activityRefreshTimer);
      this.activityRefreshTimer = null;
    }
    logger.main.info('[FuguUsageService] Stopped');
  }

  private async refreshImpl(): Promise<FuguUsageData> {
    const credentials = this.getCredentials();
    const [limits, tokenUsage] = await Promise.all([
      this.fetchAccountUsageLimits(credentials),
      this.getFuguTokenUsage(),
    ]);

    let usage: FuguUsageData;

    if (limits) {
      usage = {
        fiveHour: limits.fiveHour,
        sevenDay: limits.sevenDay,
        ...(tokenUsage ? { tokenUsage } : {}),
        limitsAvailable: true,
        accountUsageConfigured: Boolean(credentials.usageLimitUrl),
        accountUsageError: null,
        lastUpdated: Date.now(),
      };
    } else if (tokenUsage) {
      usage = {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: 0, resetsAt: null },
        tokenUsage,
        limitsAvailable: false,
        accountUsageConfigured: Boolean(credentials.usageLimitUrl),
        accountUsageError: this.accountUsageError,
        lastUpdated: Date.now(),
      };
    } else {
      usage = {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: 0, resetsAt: null },
        limitsAvailable: false,
        accountUsageConfigured: Boolean(credentials.usageLimitUrl),
        accountUsageError: this.accountUsageError,
        lastUpdated: Date.now(),
        error: credentials.apiKey || credentials.accountToken
          ? credentials.usageLimitUrl && this.accountUsageError
            ? `Fugu account usage endpoint unavailable: ${this.accountUsageError}`
            : 'No Fugu usage data found yet. Send a Fugu prompt to populate token usage; account limits require Sakana usage endpoint access.'
          : 'No Sakana Fugu key found. Configure FUGU_API_KEY or SAKANA_API_KEY to fetch usage.',
      };
    }

    this.cachedUsage = usage;
    this.broadcastUpdate();
    return usage;
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
      void this.pollTick();
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
      logger.main.info('[FuguUsageService] Going to sleep due to inactivity');
      this.isSleeping = true;
      this.stopPolling();
      return;
    }

    await this.refresh();
  }

  private getCredentials(): FuguCredentials {
    const fileEnv = readEnvFile(FUGU_ENV_PATH);
    const env = { ...fileEnv, ...process.env } as Record<string, string | undefined>;
    return {
      apiKey: env.SAKANA_API_KEY || env.FUGU_API_KEY || null,
      accountToken: env.SAKANA_ACCOUNT_TOKEN || env.FUGU_ACCOUNT_TOKEN || null,
      baseUrl: (env.FUGU_BASE_URL || env.SAKANA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
      usageLimitUrl:
        env.SAKANA_ACCOUNT_USAGE_URL ||
        env.FUGU_ACCOUNT_USAGE_URL ||
        env.SAKANA_USAGE_LIMIT_URL ||
        env.FUGU_USAGE_LIMIT_URL ||
        null,
    };
  }

  private async fetchAccountUsageLimits(
    credentials: FuguCredentials,
  ): Promise<{ fiveHour: FuguUsageWindow; sevenDay: FuguUsageWindow } | null> {
    this.accountUsageError = null;
    const bearerToken = credentials.accountToken || credentials.apiKey;
    if (!bearerToken) return null;

    const explicitUrl = credentials.usageLimitUrl;
    if (!explicitUrl && Date.now() < this.accountEndpointUnsupportedUntil) {
      return null;
    }

    const urls = this.getAccountUsageUrls(credentials);
    let sawUnsupportedDefaultEndpoint = false;

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${bearerToken}`,
            Accept: 'application/json',
          },
        });

        if (response.status === 404 || response.status === 405) {
          if (!explicitUrl) sawUnsupportedDefaultEndpoint = true;
          if (explicitUrl) {
            this.accountUsageError = `${response.status} ${response.statusText}`;
          }
          continue;
        }

        if (!response.ok) {
          const body = await readLimitedResponseBody(response);
          if (explicitUrl) {
            this.accountUsageError = `${response.status} ${response.statusText}${body ? `: ${body}` : ''}`;
          }
          logger.main.debug(
            `[FuguUsageService] Account usage endpoint failed: ${response.status} ${response.statusText}` +
            (body ? ` body=${body}` : '')
          );
          continue;
        }

        const payload = await response.json();
        const limits = extractUsageWindows(payload);
        if (limits) return limits;
        if (explicitUrl) {
          this.accountUsageError = 'response did not contain parseable 5-hour or 7-day usage windows';
        }
      } catch (error) {
        if (explicitUrl) {
          this.accountUsageError = error instanceof Error ? error.message : String(error);
        }
        logger.main.debug('[FuguUsageService] Account usage endpoint probe failed:', error);
      }
    }

    if (!explicitUrl && sawUnsupportedDefaultEndpoint) {
      this.accountEndpointUnsupportedUntil = Date.now() + ACCOUNT_ENDPOINT_RETRY_MS;
    }

    return null;
  }

  private getAccountUsageUrls(credentials: FuguCredentials): string[] {
    if (credentials.usageLimitUrl) {
      return [credentials.usageLimitUrl];
    }

    const base = credentials.baseUrl.replace(/\/+$/, '');
    let origin = 'https://api.sakana.ai';
    try {
      origin = new URL(base).origin;
    } catch {
      // Keep default origin.
    }

    return uniqueStrings([
      `${base}/account/usage`,
      `${base}/account/limits`,
      `${base}/usage`,
      `${base}/usage-limit`,
      `${base}/usage-limits`,
      `${base}/limits`,
      `${base}/quota`,
      `${origin}/api/account/usage`,
      `${origin}/api/account/limits`,
      `${origin}/api/usage`,
      `${origin}/api/usage-limit`,
      `${origin}/api/usage-limits`,
      `${origin}/api/limits`,
      `${origin}/api/quota`,
    ]);
  }

  private async getFuguTokenUsage(): Promise<FuguTokenUsageAggregate | null> {
    try {
      const isSQLite = database.getEngine?.() === 'sqlite';
      const result = isSQLite
        ? await database.query<{
            input_tokens: string | number | null;
            output_tokens: string | number | null;
            total_tokens: string | number | null;
            session_count: string | number | null;
            last_session_updated_at: string | Date | number | null;
          }>(
            `SELECT
              COALESCE(SUM(CAST(json_extract(metadata, '$.tokenUsage.inputTokens') AS INTEGER)), 0) AS input_tokens,
              COALESCE(SUM(CAST(json_extract(metadata, '$.tokenUsage.outputTokens') AS INTEGER)), 0) AS output_tokens,
              COALESCE(SUM(CAST(json_extract(metadata, '$.tokenUsage.totalTokens') AS INTEGER)), 0) AS total_tokens,
              COUNT(*) AS session_count,
              MAX(updated_at) AS last_session_updated_at
            FROM ai_sessions
            WHERE provider = 'opencode'
              AND (
                LOWER(COALESCE(model, '')) LIKE '%fugu%'
                OR LOWER(COALESCE(model, '')) LIKE '%sakana%'
              )
              AND json_extract(metadata, '$.tokenUsage') IS NOT NULL`,
            []
          )
        : await database.query<{
            input_tokens: string | number | null;
            output_tokens: string | number | null;
            total_tokens: string | number | null;
            session_count: string | number | null;
            last_session_updated_at: string | Date | number | null;
          }>(
            `SELECT
              COALESCE(SUM((metadata->'tokenUsage'->>'inputTokens')::bigint), 0) AS input_tokens,
              COALESCE(SUM((metadata->'tokenUsage'->>'outputTokens')::bigint), 0) AS output_tokens,
              COALESCE(SUM((metadata->'tokenUsage'->>'totalTokens')::bigint), 0) AS total_tokens,
              COUNT(*) AS session_count,
              MAX(updated_at) AS last_session_updated_at
            FROM ai_sessions
            WHERE provider = 'opencode'
              AND (
                LOWER(COALESCE(model, '')) LIKE '%fugu%'
                OR LOWER(COALESCE(model, '')) LIKE '%sakana%'
              )
              AND metadata->'tokenUsage' IS NOT NULL`,
            []
          );

      const row = result.rows[0];
      if (!row) return null;

      const totalTokens = toInteger(row.total_tokens);
      const sessionCount = toInteger(row.session_count);
      if (totalTokens <= 0 || sessionCount <= 0) return null;

      return {
        inputTokens: toInteger(row.input_tokens),
        outputTokens: toInteger(row.output_tokens),
        totalTokens,
        sessionCount,
        lastSessionUpdatedAt: toEpochMs(row.last_session_updated_at),
      };
    } catch (error) {
      logger.main.debug('[FuguUsageService] Failed to read persisted Fugu token usage:', error);
      return null;
    }
  }

  private broadcastUpdate(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('fugu-usage:update', this.cachedUsage);
      }
    }
    if (this.cachedUsage) {
      for (const listener of fuguUsageUpdateListeners) {
        try {
          listener(this.cachedUsage);
        } catch {
          // Listener errors must not break the window broadcast path.
        }
      }
    }
  }
}

const fuguUsageUpdateListeners = new Set<(usage: FuguUsageData) => void>();
export function onFuguUsageUpdate(listener: (usage: FuguUsageData) => void): () => void {
  fuguUsageUpdateListeners.add(listener);
  return () => fuguUsageUpdateListeners.delete(listener);
}

export const fuguUsageService = new FuguUsageServiceImpl();

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};

  try {
    const env: Record<string, string> = {};
    const content = readFileSync(filePath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      value = value.replace(/^['"]|['"]$/g, '');
      env[key] = value;
    }
    return env;
  } catch (error) {
    logger.main.debug('[FuguUsageService] Failed to read Fugu env file:', error);
    return {};
  }
}

export function extractUsageWindows(payload: unknown): { fiveHour: FuguUsageWindow; sevenDay: FuguUsageWindow } | null {
  const objects = collectObjects(payload, 4);
  let fiveHour: FuguUsageWindow | null = null;
  let sevenDay: FuguUsageWindow | null = null;

  for (const obj of objects) {
    if (!fiveHour) {
      fiveHour =
        normalizeUsageWindow(readByKeys(obj, ['five_hour', 'fiveHour', 'five-hour', '5h', 'fiveHourWindow', 'primary'])) ||
        windowByDuration(obj, 5 * 60) ||
        windowByLabel(obj, ['5h', '5-hour', 'five_hour', 'five-hour', 'five hour', 'primary', 'session']);
    }
    if (!sevenDay) {
      sevenDay =
        normalizeUsageWindow(readByKeys(obj, ['seven_day', 'sevenDay', 'seven-day', '7d', 'weekly', 'week', 'secondary'])) ||
        windowByDuration(obj, 7 * 24 * 60) ||
        windowByLabel(obj, ['7d', '7-day', 'seven_day', 'seven-day', 'seven day', 'weekly', 'week', 'secondary']);
    }
    if (fiveHour && sevenDay) break;
  }

  if (!fiveHour && !sevenDay) return null;

  return {
    fiveHour: fiveHour ?? { utilization: 0, resetsAt: null },
    sevenDay: sevenDay ?? { utilization: 0, resetsAt: null },
  };
}

function normalizeUsageWindow(value: unknown): FuguUsageWindow | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const utilization =
    readNumber(obj, ['utilization', 'used_percent', 'usedPercent', 'percent', 'percentage', 'used_percentage', 'usedPercentage']) ??
    calculatePercent(obj);
  if (utilization === null) return null;

  const reset = readValue(obj, ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'reset', 'ends_at', 'endsAt']);
  return {
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt: normalizeTimestamp(reset),
  };
}

function windowByDuration(obj: Record<string, unknown>, minutes: number): FuguUsageWindow | null {
  const windowMinutes = readNumber(obj, ['window_minutes', 'windowMinutes', 'duration_minutes', 'durationMinutes', 'period_minutes', 'periodMinutes']);
  if (windowMinutes !== minutes) return null;
  return normalizeUsageWindow(obj);
}

function windowByLabel(obj: Record<string, unknown>, labels: string[]): FuguUsageWindow | null {
  const label = readString(obj, ['window', 'period', 'duration', 'label', 'name', 'id', 'limit_id', 'bucket']);
  if (!label) return null;
  const normalized = label.toLowerCase().replace(/[_\s]+/g, '-');
  if (!labels.some((candidate) => normalized.includes(candidate.toLowerCase().replace(/[_\s]+/g, '-')))) return null;
  return normalizeUsageWindow(obj);
}

function calculatePercent(obj: Record<string, unknown>): number | null {
  const used = readNumber(obj, ['used', 'usage', 'current', 'consumed']);
  const limit = readNumber(obj, ['limit', 'total', 'maximum', 'max', 'cap', 'allowance']);
  if (used !== null && limit !== null && limit > 0) {
    return (used / limit) * 100;
  }

  const remaining = readNumber(obj, ['remaining', 'remainingQuota', 'remaining_quota', 'available']);
  if (remaining === null || limit === null || limit <= 0) return null;
  return ((limit - remaining) / limit) * 100;
}

function collectObjects(value: unknown, depth: number): Array<Record<string, unknown>> {
  if (depth < 0 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectObjects(item, depth - 1));
  }
  const obj = value as Record<string, unknown>;
  return [
    obj,
    ...Object.values(obj).flatMap((child) => collectObjects(child, depth - 1)),
  ];
}

function readByKeys(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) return obj[key];
  }
  return undefined;
}

function readValue(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function readNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  const value = readValue(obj, keys);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readString(obj: Record<string, unknown>, keys: string[]): string | null {
  const value = readValue(obj, keys);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

function toInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function readLimitedResponseBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    return text.length > 600 ? `${text.slice(0, 600)}...` : text;
  } catch {
    return '';
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
