/** Shared backend for the Ollama meter and read-only usage tools. */
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { getWindowIdForWindow, resolveActiveWorkspacePathForWindowId } from '../window/windowState';
import { getOllamaDashboardBinding, ollamaDashboardScraper } from './OllamaDashboardScraper';
import type { OllamaDashboardModel, OllamaDashboardWindow, OllamaDashboardResult } from '../../shared/ollamaDashboardUsage';
import type { OllamaDurationSource, OllamaResetTimeStatus } from '../../shared/ollamaResetWindows';
import type { OllamaRequestUsage } from '../../shared/ollamaUsage';

export type OllamaUsageModelBreakdown = OllamaDashboardModel;
export interface OllamaUsageWindow extends OllamaDashboardWindow {
  windowStart?: string | null;
  windowEnd?: string | null;
  durationSource?: OllamaDurationSource;
}
export interface OllamaUsageData {
  limitsAvailable: boolean;
  source?: 'ollama-dashboard';
  authStatus?: 'connected' | 'sign-in-required' | 'error';
  creditBalanceUSD?: number;
  plan?: string;
  modelCountsPeriod?: 'this-week';
  session?: OllamaUsageWindow;
  weekly?: OllamaUsageWindow;
  lastUpdated: number;
  error?: string;
  limitsUnavailableReason?: string;
  // Optional fields retained for clients holding a previous snapshot.
  requestUsage?: OllamaRequestUsage;
  costUSD?: number;
  costPeriod?: { type: string; startingAt: string; endingAt: string };
  cookieExpired?: boolean;
  resetTimeStatus?: OllamaResetTimeStatus;
  resetTimeRetryAt?: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5 * 60_000;
const IDLE_TIMEOUT_MS = 60 * 60_000;
interface WorkspaceUsageState {
  binding: string;
  revision: number;
  cachedUsage: OllamaUsageData | null;
  lastFetchTime: number;
  lastActivityTime: number;
  inflightRefresh: Promise<OllamaUsageData> | null;
}

function normalizeDashboardResult(result: OllamaDashboardResult): OllamaUsageData {
  if (result.status === 'ok') {
    const limitsAvailable = Boolean(result.snapshot.session || result.snapshot.weekly);
    return {
      ...result.snapshot, source: 'ollama-dashboard', authStatus: 'connected', limitsAvailable,
      limitsUnavailableReason: limitsAvailable ? undefined : 'Plan allowance limits are not shown by the signed-in Ollama usage page.',
      lastUpdated: Date.now(),
    };
  }
  return {
    source: 'ollama-dashboard', limitsAvailable: false, authStatus: result.status,
    error: result.status === 'sign-in-required'
      ? 'Sign in to Ollama usage to read credits, plan limits and model calls.'
      : 'Ollama dashboard usage could not be read. Refresh or reconnect the dashboard.',
    lastUpdated: Date.now(),
  };
}

class OllamaUsageServiceImpl {
  private readonly workspaces = new Map<string, WorkspaceUsageState>();
  private pollTimer: NodeJS.Timeout | null = null;

  private state(workspacePath: string): WorkspaceUsageState {
    const binding = getOllamaDashboardBinding(workspacePath);
    let state = this.workspaces.get(workspacePath);
    if (!state) {
      state = { binding, revision: 0, cachedUsage: null, lastFetchTime: 0, lastActivityTime: 0, inflightRefresh: null };
      this.workspaces.set(workspacePath, state);
    } else if (state.binding !== binding) {
      state.binding = binding; state.revision++;
      state.cachedUsage = null; state.lastFetchTime = 0; state.inflightRefresh = null;
    }
    return state;
  }

  private canPublish(workspacePath: string, state: WorkspaceUsageState, revision: number): boolean {
    if (this.workspaces.get(workspacePath) !== state) return false;
    // Reconcile the binding before considering a prior cached result as fallback.
    this.state(workspacePath);
    return state.revision === revision;
  }

  private supersedingUsage(workspacePath: string, state: WorkspaceUsageState): OllamaUsageData {
    return (this.workspaces.get(workspacePath) === state ? state.cachedUsage : null)
      ?? normalizeDashboardResult({ status: 'sign-in-required' });
  }

  initialize(): void { logger.main.info('[OllamaUsageService] Dashboard reader initialized'); }
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const state of this.workspaces.values()) state.revision++;
    this.workspaces.clear();
    ollamaDashboardScraper.stop();
  }

  async recordActivity(workspacePath: string): Promise<void> { await this.getUsage(workspacePath); }
  async getUsage(workspacePath: string, forceRefresh = false): Promise<OllamaUsageData> {
    const state = this.state(workspacePath);
    state.lastActivityTime = Date.now(); this.startPolling();
    if (!forceRefresh && state.cachedUsage && Date.now() - state.lastFetchTime < CACHE_TTL_MS) return state.cachedUsage;
    return this.refresh(workspacePath);
  }
  getCachedUsage(workspacePath: string): OllamaUsageData | null { return this.state(workspacePath).cachedUsage; }

  async refresh(workspacePath: string): Promise<OllamaUsageData> {
    const state = this.state(workspacePath);
    if (state.inflightRefresh) return state.inflightRefresh;
    const revision = state.revision;
    const request = (async () => {
      let result: OllamaDashboardResult;
      try { result = await ollamaDashboardScraper.read(workspacePath); }
      catch { result = { status: 'error', error: 'Ollama dashboard usage could not be read.' }; }
      // Forget/key changes invalidate responses already in flight.
      if (!this.canPublish(workspacePath, state, revision)) return this.supersedingUsage(workspacePath, state);
      const usage = normalizeDashboardResult(result);
      state.cachedUsage = usage; state.lastFetchTime = Date.now();
      this.broadcastUpdate(workspacePath, usage);
      return usage;
    })();
    state.inflightRefresh = request;
    try { return await request; }
    finally { if (state.inflightRefresh === request) state.inflightRefresh = null; }
  }

  async connect(workspacePath: string, parent?: BrowserWindow): Promise<OllamaUsageData> {
    const state = this.state(workspacePath);
    // A shared browser login can change dashboard account without changing the
    // configured key. Retire every snapshot/read owned by that login before await.
    this.invalidateBinding(state.binding);
    const revision = state.revision;
    let result: OllamaDashboardResult;
    try { result = await ollamaDashboardScraper.connect(workspacePath, parent); }
    catch { result = { status: 'error', error: 'Ollama dashboard sign-in could not be opened.' }; }
    if (!this.canPublish(workspacePath, state, revision)) return this.supersedingUsage(workspacePath, state);
    const usage = normalizeDashboardResult(result);
    state.cachedUsage = usage; state.lastFetchTime = Date.now(); state.lastActivityTime = Date.now();
    this.startPolling(); this.broadcastUpdate(workspacePath, usage);
    return usage;
  }

  async disconnect(workspacePath: string): Promise<void> {
    this.invalidateBinding(this.state(workspacePath).binding);
    await ollamaDashboardScraper.forget(workspacePath);
  }

  private invalidateBinding(binding: string): void {
    for (const [activePath, state] of this.workspaces) {
      if (state.binding !== binding) continue;
      state.revision++; state.inflightRefresh = null;
      state.cachedUsage = normalizeDashboardResult({ status: 'sign-in-required' });
      state.lastFetchTime = Date.now();
      this.broadcastUpdate(activePath, state.cachedUsage);
    }
  }

  /** Previous IPC callers now use the same complete snapshot, not another scraper. */
  async getResetUsage(workspacePath: string, forceRefresh = false): Promise<OllamaUsageData> {
    return this.getUsage(workspacePath, forceRefresh);
  }
  private startPolling(): void {
    if (!this.pollTimer) this.pollTimer = setInterval(() => { void this.pollTick(); }, POLL_INTERVAL_MS);
  }
  private async pollTick(): Promise<void> {
    const activePaths = [...this.workspaces].filter(([, s]) => Date.now() - s.lastActivityTime <= IDLE_TIMEOUT_MS).map(([p]) => p);
    if (!activePaths.length) { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null; return; }
    await Promise.allSettled(activePaths.map(p => this.refresh(p)));
  }
  private broadcastUpdate(workspacePath: string, usage: OllamaUsageData): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && resolveActiveWorkspacePathForWindowId(getWindowIdForWindow(window)) === workspacePath) {
        window.webContents.send('ollama-usage:update', { workspacePath, usage });
      }
    }
  }
}
export const ollamaUsageService = new OllamaUsageServiceImpl();
