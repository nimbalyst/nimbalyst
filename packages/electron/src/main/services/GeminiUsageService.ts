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
 * side effect. So `currentEndpoint()` is the gate — no live endpoint means a
 * muted "--" chip with the reason in the tooltip, exactly like Codex's
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
  limitsAvailable?: boolean;
  available?: boolean;
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
   * already-running Antigravity hub (`findRunningEndpoint()`). On an RPC error
   * (for example if the hub restarted on a new port), clears the stale endpoint
   * and retries hub discovery once before reporting unavailable.
   */
  private async fetchSnapshot(): Promise<GeminiUsageSnapshotResult> {
    const server = AntigravityServerManager.shared();
    if (server.currentEndpoint() === null) {
      const hub = await server.findRunningEndpoint().catch(() => null);
      if (!hub) {
        return { available: false, notStarted: true, error: GEMINI_NOT_STARTED_MESSAGE };
      }
    }
    try {
      const snapshot = await new AntigravityUsageMeter(server).getSnapshot();
      return { available: true, snapshot };
    } catch (error) {
      server.clearEndpoint();
      const retryHub = await server.findRunningEndpoint().catch(() => null);
      if (retryHub) {
        try {
          const snapshot = await new AntigravityUsageMeter(server).getSnapshot();
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
   * The Codex chip drives its ring off `fiveHour.utilization` (0-100). Gemini's
   * snapshot exposes per-model `remainingFraction` (0..1) and a `resetTime`, so
   * we pick the model with the LOWEST remaining quota (most-constrained window)
   * for the primary ring -- utilization = (1 - remainingFraction) * 100 -- and
   * the next-most-constrained for the secondary ring. Account credits map onto
   * the optional `credits` block.
   */
  private convertSnapshot(snapshot: AntigravityUsageSnapshot): GeminiUsageData {
    const quotas = Object.values(snapshot?.models ?? {}).filter(
      (q): q is AntigravityModelQuota =>
        !!q && typeof q.remainingFraction === 'number',
    );

    // Lowest remaining first = highest utilization first.
    quotas.sort(
      (a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1),
    );

    const primary = quotas[0];
    const secondary = quotas[1];

    const toUtilization = (q?: AntigravityModelQuota): number => {
      if (!q || typeof q.remainingFraction !== 'number') return 0;
      const util = (1 - q.remainingFraction) * 100;
      return Math.max(0, Math.min(100, util));
    };

    const data: GeminiUsageData = {
      fiveHour: {
        utilization: toUtilization(primary),
        resetsAt: primary?.resetTime ?? null,
      },
      sevenDay: {
        utilization: toUtilization(secondary),
        resetsAt: secondary?.resetTime ?? null,
      },
      limitsAvailable: quotas.length > 0,
      available: true,
      lastUpdated: Date.now(),
    };

    const account = snapshot?.account;
    if (account) {
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
