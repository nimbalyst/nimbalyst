/**
 * GeminiUsageService - Tracks Gemini (Antigravity) usage limits
 *
 * This service:
 * - Reads account credits + per-model quota from the Antigravity language
 *   server, via `AntigravityUsageMeter`
 * - Implements activity-aware polling (active when using Gemini, sleeps when idle)
 * - Broadcasts usage updates to renderer via IPC
 *
 * The poll is strictly read-only and NEVER spawns the language server. That
 * constraint is what shapes the whole file: a background poll that could start
 * a ~120MB process would make merely *displaying* a usage chip an expensive
 * side effect. With no cached endpoint the poll may attach to an already-running
 * Antigravity hub (`findRunningEndpoint()`, discovery only); if none is found it
 * shows a muted "--" chip with the reason in the tooltip, exactly like Codex's
 * unavailable branch, and the first real turn brings it to life.
 *
 * Mirrors CodexUsageService 1:1 in structure: same poll cadence, idle sleep,
 * cached snapshot, broadcast pattern. The difference is the data source (a
 * local RPC instead of a file scan) and the channel name ('gemini-usage:update').
 */

import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { AntigravityServerManager } from '@nimbalyst/runtime/ai/server/providers/geminiAntigravity/AntigravityServerManager';
import { AntigravityUsageMeter } from '@nimbalyst/runtime/ai/server/providers/geminiAntigravity/AntigravityUsageMeter';

// Friendly chip/popover text for the normal pre-first-request state, where the
// language server has not been started yet.
const GEMINI_NOT_STARTED_MESSAGE = 'Gemini usage will appear after your first request.';

// Errors that mean nothing is listening on the cached port any more, as when an
// attached hub restarts on a new port. A timeout is not one of them: the server
// may just be busy.
function isEndpointGoneError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ECONNREFUSED') return true;
  return error instanceof Error && error.message.includes('ECONNREFUSED');
}

export interface GeminiQuotaWindow {
  utilization: number; // 0-100 percentage
  resetsAt: string | null; // ISO timestamp
}

export interface GeminiQuotaGroup {
  displayName: string;
  description: string | null;
  fiveHour: GeminiQuotaWindow;
  sevenDay: GeminiQuotaWindow;
  hasFiveHour: boolean;
  hasSevenDay: boolean;
}

export interface GeminiUsageAccount {
  email: string | null;
  name: string | null;
  planName: string | null;
  tier: string | null;
}

export interface GeminiUsageData {
  fiveHour: GeminiQuotaWindow;
  sevenDay: GeminiQuotaWindow;
  /** Primary quota group driving fiveHour/sevenDay and the gutter ring (prefers Gemini Models). */
  primaryGroupName?: string;
  /** All active quota groups reported by Antigravity (e.g. Gemini Models, Claude and GPT models). */
  quotaGroups?: GeminiQuotaGroup[];
  account?: GeminiUsageAccount;
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
  available?: boolean;
  /** 'summary' when backed by RetrieveUserQuotaSummary 5h/weekly pools; 'models' for per-model fallback. */
  windowSource?: 'summary' | 'models';
  /** Present when windowSource === 'summary': whether the primary group reports a 5-hour session bucket. */
  hasFiveHour?: boolean;
  /** Present when windowSource === 'summary': whether the primary group reports a 7-day weekly bucket. */
  hasSevenDay?: boolean;
  lastUpdated: number; // Unix timestamp
  error?: string;
  /** True when the backend module has not started yet (benign idle state, not an error). */
  notStarted?: boolean;
}

/**
 * Locally-declared mirror of the meter's snapshot shape, kept so the chip's
 * conversion below reads against an explicit contract.
 */
interface AntigravityModelQuota {
  model: string;
  label?: string;
  remainingFraction?: number; // 0..1
  resetTime?: string; // ISO8601 UTC
}

interface AntigravityQuotaBucket {
  bucketId: string;
  displayName?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
  disabled?: boolean;
}

interface AntigravityQuotaGroup {
  displayName: string;
  description?: string;
  buckets: AntigravityQuotaBucket[];
}

interface AntigravityQuotaSummary {
  description?: string;
  groups: AntigravityQuotaGroup[];
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
  quotaSummary?: AntigravityQuotaSummary;
  warn: boolean;
}

type GeminiUsageSnapshotResult =
  | { available: true; snapshot: AntigravityUsageSnapshot }
  | { available: false; error: string; notStarted?: boolean };

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes before going to sleep

class GeminiUsageServiceImpl {
  private cachedUsage: GeminiUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;

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

  async refresh(): Promise<GeminiUsageData> {
    try {
      const result = await this.fetchSnapshot();

      if (!result || result.available === false) {
        const muted = this.makeUnavailable(
          result?.error ?? 'Gemini usage data unavailable',
          result?.notStarted ?? false,
        );
        this.cachedUsage = muted;
        this.broadcastUpdate();
        return muted;
      }

      const usageData = this.convertSnapshot(result.snapshot);
      this.cachedUsage = usageData;
      this.broadcastUpdate();
      return usageData;
    } catch (error) {
      logger.main.error('[GeminiUsageService] Error refreshing usage:', error);
      const muted = this.makeUnavailable(
        error instanceof Error ? error.message : 'Unknown error reading Gemini usage',
      );
      this.cachedUsage = muted;
      this.broadcastUpdate();
      return muted;
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
   * Ask the language server for a usage snapshot. Never throws and never
   * spawns: if no endpoint is cached yet, tries a read-only attachment to an
   * already-running Antigravity hub (`findRunningEndpoint()`). If an attached
   * hub refuses the connection (it restarted on a new port), clears the stale
   * endpoint and retries hub discovery once before reporting unavailable.
   * An owned endpoint, or any other error such as a timeout on a busy server,
   * is left in place: clearing a live owned server's endpoint would make the
   * next turn spawn a second language server and orphan the first.
   */
  private async fetchSnapshot(): Promise<GeminiUsageSnapshotResult> {
    const server = AntigravityServerManager.shared();
    // Read from this endpoint explicitly: without one, the meter goes through
    // ensureRunning(), which spawns a server if the hub has since gone away.
    const endpoint = server.currentEndpoint()
      ?? await server.findRunningEndpoint().catch(() => null);
    if (!endpoint) {
      return { available: false, notStarted: true, error: GEMINI_NOT_STARTED_MESSAGE };
    }
    try {
      const snapshot = await new AntigravityUsageMeter(server).getSnapshot(endpoint);
      return { available: true, snapshot };
    } catch (error) {
      if (endpoint.owned || !isEndpointGoneError(error)) {
        return {
          available: false,
          error: error instanceof Error ? error.message : 'Unknown error reading Gemini usage',
        };
      }
      server.clearEndpoint();
      const retryHub = await server.findRunningEndpoint().catch(() => null);
      if (retryHub) {
        try {
          const snapshot = await new AntigravityUsageMeter(server).getSnapshot(retryHub);
          return { available: true, snapshot };
        } catch {
          /* fall through to report the original error */
        }
      }
      return {
        available: false,
        error: error instanceof Error ? error.message : 'Unknown error reading Gemini usage',
      };
    }
  }

  private makeUnavailable(error: string, notStarted = false): GeminiUsageData {
    return {
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      limitsAvailable: false,
      available: false,
      lastUpdated: Date.now(),
      error,
      notStarted,
    };
  }

  /**
   * Map an AntigravityUsageSnapshot into the chip's GeminiUsageData shape.
   *
   * Prefers the explicit 5-hour and weekly quota pools from
   * `RetrieveUserQuotaSummary` across all quota groups (e.g. "Gemini Models"
   * and "Claude and GPT models"). Always drives the primary `fiveHour` /
   * `sevenDay` fields (and therefore the sidebar ring) from the Gemini Models
   * group so an exhausted secondary pool (such as Claude/GPT at 100%) never
   * masks remaining Gemini session quota. Falls back to per-model quotas from
   * `GetUserStatus` on older Antigravity servers that do not expose the
   * summary RPC.
   */
  private convertSnapshot(snapshot: AntigravityUsageSnapshot): GeminiUsageData {
    const toUtilization = (q?: { remainingFraction?: number }): number => {
      if (!q || typeof q.remainingFraction !== 'number') return 0;
      const util = (1 - q.remainingFraction) * 100;
      return Math.max(0, Math.min(100, util));
    };

    const summaryGroups = this.extractSummaryGroups(snapshot?.quotaSummary, toUtilization);

    let data: GeminiUsageData;
    if (summaryGroups.length > 0) {
      const primaryGroup = summaryGroups[0];
      data = {
        fiveHour: primaryGroup.fiveHour,
        sevenDay: primaryGroup.sevenDay,
        primaryGroupName: primaryGroup.displayName,
        quotaGroups: summaryGroups,
        windowSource: 'summary',
        hasFiveHour: primaryGroup.hasFiveHour,
        hasSevenDay: primaryGroup.hasSevenDay,
        limitsAvailable: true,
        available: true,
        lastUpdated: Date.now(),
      };
    } else {
      const quotas = Object.values(snapshot?.models ?? {}).filter(
        (q): q is AntigravityModelQuota =>
          !!q && typeof q.remainingFraction === 'number',
      );

      // Lowest remaining first = highest utilization first.
      quotas.sort(
        (a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1),
      );

      const geminiQuotas = quotas.filter((q) =>
        /gemini|orchestrator/i.test(String(q.label || q.model || '')),
      );
      const primaryPool = geminiQuotas.length > 0 ? geminiQuotas : quotas;
      const primary = primaryPool[0];
      const secondary = primaryPool[1];

      const familyMap = new Map<string, AntigravityModelQuota>();
      for (const q of quotas) {
        const lbl = String(q.label || q.model || '');
        const fam = /claude/i.test(lbl)
          ? 'Claude Models'
          : /gpt|oss/i.test(lbl)
            ? 'GPT-OSS Models'
            : /gemini|orchestrator/i.test(lbl)
              ? 'Gemini Models'
              : 'Other Models';
        const prev = familyMap.get(fam);
        if (!prev || (q.remainingFraction ?? 1) < (prev.remainingFraction ?? 1)) {
          familyMap.set(fam, q);
        }
      }
      const fallbackGroups: GeminiQuotaGroup[] =
        familyMap.size > 1
          ? [...familyMap.entries()]
              .sort(([a], [b]) => (/gemini/i.test(b) ? 1 : 0) - (/gemini/i.test(a) ? 1 : 0))
              .map(([fam, q]) => ({
                displayName: fam,
                description: q.label ?? null,
                fiveHour: { utilization: toUtilization(q), resetsAt: q.resetTime ?? null },
                sevenDay: { utilization: 0, resetsAt: null },
                hasFiveHour: true,
                hasSevenDay: false,
              }))
          : [];

      data = {
        fiveHour: {
          utilization: toUtilization(primary),
          resetsAt: primary?.resetTime ?? null,
        },
        sevenDay: {
          utilization: toUtilization(secondary),
          resetsAt: secondary?.resetTime ?? null,
        },
        ...(fallbackGroups.length > 0 ? { quotaGroups: fallbackGroups } : {}),
        windowSource: 'models',
        limitsAvailable: quotas.length > 0,
        available: true,
        lastUpdated: Date.now(),
      };
    }

    const account = snapshot?.account;
    if (account) {
      const email = typeof account.email === 'string' && account.email.trim() ? account.email.trim() : null;
      const name = typeof account.name === 'string' && account.name.trim() ? account.name.trim() : null;
      const planName = typeof account.planName === 'string' && account.planName.trim() ? account.planName.trim() : null;
      const tier = typeof account.tier === 'string' && account.tier.trim() ? account.tier.trim() : null;
      if (email || name || planName || tier) {
        data.account = { email, name, planName, tier };
      }
      const balance =
        typeof account.availablePromptCredits === 'number'
          ? account.availablePromptCredits
          : null;
      const monthly = account.monthlyPromptCredits;
      const unlimited =
        typeof monthly === 'number' && monthly <= 0;
      data.credits = {
        hasCredits: balance !== null && balance > 0,
        unlimited,
        balance,
      };
    }

    return data;
  }

  private extractSummaryGroups(
    summary: AntigravityQuotaSummary | undefined,
    toUtilization: (q?: { remainingFraction?: number }) => number,
  ): GeminiQuotaGroup[] {
    const groups = summary?.groups ?? [];
    if (groups.length === 0) return [];

    const extracted: Array<{ group: GeminiQuotaGroup; isGemini: boolean }> = [];
    for (const grp of groups) {
      const activeBuckets = grp.buckets.filter(
        (b) => !b.disabled && typeof b.remainingFraction === 'number',
      );
      if (activeBuckets.length === 0) continue;

      const fiveHour = activeBuckets.find(
        (b) =>
          b.window?.toLowerCase() === '5h' ||
          /(?:^|[-_])5h$/i.test(b.bucketId) ||
          /5[- ]?hour|five[- ]?hour/i.test(b.displayName ?? ''),
      );
      const weekly = activeBuckets.find(
        (b) =>
          b.window?.toLowerCase() === 'weekly' ||
          /(?:^|[-_])weekly$/i.test(b.bucketId) ||
          /week/i.test(b.displayName ?? ''),
      );
      if (!fiveHour && !weekly) continue;

      const isGemini =
        /gemini/i.test(grp.displayName) ||
        grp.buckets.some((b) => /^gemini[-_]/i.test(b.bucketId));

      extracted.push({
        isGemini,
        group: {
          displayName: grp.displayName,
          description: grp.description ?? null,
          fiveHour: {
            utilization: toUtilization(fiveHour),
            resetsAt: fiveHour?.resetTime ?? null,
          },
          sevenDay: {
            utilization: toUtilization(weekly),
            resetsAt: weekly?.resetTime ?? null,
          },
          hasFiveHour: Boolean(fiveHour),
          hasSevenDay: Boolean(weekly),
        },
      });
    }

    // Always place the Gemini group first so it drives the primary gutter ring.
    extracted.sort((a, b) => Number(b.isGemini) - Number(a.isGemini));
    return extracted.map((entry) => entry.group);
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

// Singleton instance
export const geminiUsageService = new GeminiUsageServiceImpl();
