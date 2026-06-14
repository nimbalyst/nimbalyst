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
  private async fetchSnapshot(): Promise<GeminiUsageSnapshotResult> {
    const workspacePath = this.resolveActiveWorkspace();
    if (!workspacePath) {
      return { available: false, notStarted: true, error: 'Open a workspace to see Gemini usage.' };
    }

    try {
      const result = await getPrivilegedExtensionHost().request<GeminiUsageSnapshotResult>({
        extensionId: GEMINI_EXTENSION_ID,
        moduleId: GEMINI_BACKEND_MODULE_ID,
        workspacePath,
        method: 'getUsageSnapshot',
        params: {},
        requiredPermission: null,
      });
      if (!result || typeof result !== 'object') {
        return { available: false, error: 'Gemini usage snapshot unavailable' };
      }
      return result;
    } catch (error) {
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
