/**
 * OllamaUsageService - Tracks Ollama Cloud usage
 *
 * Ollama Cloud's account-usage API is real and undocumented as of this
 * writing (docs.ollama.com/api/usage only covers per-response metrics; this
 * endpoint doesn't appear there). Verified live 2026-07-30 against Yogev's
 * own account, matching the numbers shown on ollama.com/settings ("Cloud
 * usage"):
 *
 *   GET https://ollama.com/api/usage
 *   Authorization: <OLLAMA_API_KEY>        (raw key, NOT "Bearer <key>")
 *
 *   {
 *     "activity": {
 *       "cost": "0.00000",
 *       "period": { "type": "last_4_weeks", "starting_at": "...", "ending_at": "..." },
 *       "models": []
 *     },
 *     "limits": {
 *       "session": { "usage": 0,     "models": [{ "name": "gpt-oss:120b", "request_count": 1 }] },
 *       "weekly":  { "usage": 0.051, "models": [{ "name": "glm-5.2", "request_count": 253 }, ...] }
 *     }
 *   }
 *
 * `limits.session.usage` / `limits.weekly.usage` are 0-1 fractions (0.051 ==
 * the dashboard's "5.1% used"); no reset timestamp is included in the
 * payload even though the dashboard shows a countdown, so `resetsAt` stays
 * null here rather than guessing a window length. Because this is
 * undocumented, treat the exact shape as best-effort: unknown/missing fields
 * degrade to `limitsAvailable: false` with the raw HTTP status/error surfaced
 * rather than throwing.
 *
 * Unlike the local LiteLLM brain-swap proxy (which deliberately never sees
 * OLLAMA_API_KEY -- see the proxy-health section below), THIS call is a
 * direct, read-only GET to Ollama's own account API and genuinely needs the
 * real key, the same way ClaudeUsageService needs the real Claude OAuth
 * token to poll /api/oauth/usage. Resolved the same way ClaudeUsageService
 * resolves its env (process env layered with the captured login-shell env)
 * so a GUI-launched Electron on macOS/Linux still sees a shell-exported key.
 *
 * Also reports local LiteLLM brain-swap proxy health (reachability +
 * configured aliases) as a secondary, always-available signal: the proxy is
 * an optional, manually-started dev process, not something Nimbalyst
 * launches, so "not running" is a normal idle state, not an error -- same
 * spirit as GeminiUsageService's `notStarted` branch. See
 * tools/Ollala/nimbalyst-brainswap/litellm-ollama.yaml in the workspace and
 * the in-app Claude Code "ollama" backend profiles for what it fronts.
 */

import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { getShellEnvironment } from './CLIManager';

type OllamaEnv = Record<string, string | undefined>;

export interface OllamaUsageModelBreakdown {
  name: string;
  requestCount: number;
}

export interface OllamaUsageWindow {
  utilization: number; // 0-100 percentage
  resetsAt: string | null; // not present in the API payload today
  models: OllamaUsageModelBreakdown[];
}

export interface OllamaUsagePlanTier {
  tier: string;
  concurrentCloudModels: number;
  weeklyGpuQuota: string;
}

export interface OllamaUsageData {
  limitsAvailable: boolean;
  session?: OllamaUsageWindow;
  weekly?: OllamaUsageWindow;
  costUSD?: number;
  costPeriod?: { type: string; startingAt: string; endingAt: string };
  /** Local LiteLLM brain-swap proxy reachability (independent of the account API above). */
  proxyReachable: boolean;
  /** Claude-shaped aliases currently registered on the proxy (model_name from /model/info). */
  configuredAliases: string[];
  /** Static reference data from ollama.com/pricing, not a live reading. */
  planTiers: OllamaUsagePlanTier[];
  lastUpdated: number; // Unix timestamp
  /** Set when limitsAvailable is false: why (missing key, HTTP error, etc). */
  error?: string;
}

const USAGE_API_URL = 'https://ollama.com/api/usage';
const USAGE_API_TIMEOUT_MS = 5_000;

const PROXY_BASE_URL = 'http://127.0.0.1:4002';
// Fixed, non-secret local-proxy placeholder token. Matches
// tools/Ollala/nimbalyst-brainswap/litellm-ollama.yaml's general_settings.master_key
// and the in-app Ollama Claude Code backend profiles -- 127.0.0.1-only, never the
// real OLLAMA_API_KEY.
const PROXY_AUTH_TOKEN = 'sk-nim-local-proxy';
const PROXY_TIMEOUT_MS = 3_000;

const CACHE_TTL_MS = 5 * 60 * 1000; // Cache floor for on-demand callers (e.g. the MCP tool) between poll ticks.
const POLL_INTERVAL_MS = 30 * 60 * 1000; // Matches Claude/Codex/Gemini.
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // Matches Claude/Codex/Gemini.

const PLAN_TIERS: readonly OllamaUsagePlanTier[] = [
  { tier: 'Free', concurrentCloudModels: 1, weeklyGpuQuota: 'baseline' },
  { tier: 'Pro', concurrentCloudModels: 3, weeklyGpuQuota: '50x Free' },
  { tier: 'Max', concurrentCloudModels: 10, weeklyGpuQuota: '5x Pro' },
];

interface RawOllamaUsageWindow {
  usage?: unknown;
  models?: Array<{ name?: unknown; request_count?: unknown }>;
}
interface RawOllamaUsageResponse {
  activity?: {
    cost?: unknown;
    period?: { type?: unknown; starting_at?: unknown; ending_at?: unknown };
  };
  limits?: {
    session?: RawOllamaUsageWindow;
    weekly?: RawOllamaUsageWindow;
  };
}

interface LiteLLMModelInfoEntry {
  model_name?: unknown;
}
interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfoEntry[];
}

function parseWindow(raw: RawOllamaUsageWindow | undefined): OllamaUsageWindow | undefined {
  if (!raw || typeof raw.usage !== 'number') return undefined;
  const models = (raw.models ?? [])
    .filter((m): m is { name: string; request_count: number } =>
      typeof m?.name === 'string' && typeof m?.request_count === 'number'
    )
    .map((m) => ({ name: m.name, requestCount: m.request_count }));
  return {
    utilization: Math.round(raw.usage * 1000) / 10, // 0-1 fraction -> 0-100%, 1 decimal
    resetsAt: null,
    models,
  };
}

class OllamaUsageServiceImpl {
  private cachedUsage: OllamaUsageData | null = null;
  private lastFetchTime = 0;
  private inflightRefresh: Promise<OllamaUsageData> | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime = 0;
  private isPolling = false;
  private isSleeping = true;

  /**
   * Initialize the service. Does not start polling until activity is
   * detected -- matches ClaudeUsageService/CodexUsageService/GeminiUsageService.
   */
  initialize(): void {
    logger.main.info('[OllamaUsageService] Initialized (sleeping until activity detected)');
  }

  /**
   * Called when the user sends a message to an Ollama-routed agent session.
   * Wakes up the service and triggers an immediate refresh.
   */
  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      this.isSleeping = false;
      this.startPolling();
      await this.refresh();
    }
  }

  stop(): void {
    this.stopPolling();
    logger.main.info('[OllamaUsageService] Stopped');
  }

  /** Returns the cached snapshot if fresh, otherwise fetches a new one. */
  async getUsage(forceRefresh = false): Promise<OllamaUsageData> {
    if (!forceRefresh && this.cachedUsage && Date.now() - this.lastFetchTime < CACHE_TTL_MS) {
      return this.cachedUsage;
    }
    return this.refresh();
  }

  getCachedUsage(): OllamaUsageData | null {
    return this.cachedUsage;
  }

  async refresh(): Promise<OllamaUsageData> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }
    this.inflightRefresh = this.doRefresh();
    try {
      return await this.inflightRefresh;
    } finally {
      this.inflightRefresh = null;
    }
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
      logger.main.info('[OllamaUsageService] Going to sleep due to inactivity');
      this.isSleeping = true;
      this.stopPolling();
      return;
    }
    await this.refresh();
  }

  private async doRefresh(): Promise<OllamaUsageData> {
    const [accountUsage, proxyHealth] = await Promise.all([
      this.fetchAccountUsage(),
      this.fetchProxyHealth(),
    ]);

    const usageData: OllamaUsageData = {
      ...accountUsage,
      ...proxyHealth,
      planTiers: [...PLAN_TIERS],
      lastUpdated: Date.now(),
    };
    this.cachedUsage = usageData;
    this.lastFetchTime = Date.now();
    this.broadcastUpdate();
    return usageData;
  }

  private broadcastUpdate(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('ollama-usage:update', this.cachedUsage);
      }
    }
  }

  private async fetchAccountUsage(): Promise<
    Pick<OllamaUsageData, 'limitsAvailable' | 'session' | 'weekly' | 'costUSD' | 'costPeriod' | 'error'>
  > {
    const env = this.resolveEnv();
    const apiKey = env.OLLAMA_API_KEY;
    if (!apiKey) {
      logger.main.debug('[OllamaUsageService] No OLLAMA_API_KEY in environment; account usage unavailable.');
      return { limitsAvailable: false, error: 'OLLAMA_API_KEY not set in environment.' };
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), USAGE_API_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(USAGE_API_URL, {
          method: 'GET',
          headers: { Authorization: apiKey }, // Raw key, not "Bearer <key>" -- verified live 2026-07-30.
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        logger.main.warn(`[OllamaUsageService] ${USAGE_API_URL} returned HTTP ${response.status}`);
        return { limitsAvailable: false, error: `Ollama usage API returned HTTP ${response.status}` };
      }

      const data = (await response.json()) as RawOllamaUsageResponse;
      const session = parseWindow(data.limits?.session);
      const weekly = parseWindow(data.limits?.weekly);
      const costUSD = typeof data.activity?.cost === 'string' ? Number.parseFloat(data.activity.cost) : undefined;
      const period = data.activity?.period;
      const costPeriod =
        typeof period?.type === 'string' && typeof period?.starting_at === 'string' && typeof period?.ending_at === 'string'
          ? { type: period.type, startingAt: period.starting_at, endingAt: period.ending_at }
          : undefined;

      if (!session && !weekly) {
        return { limitsAvailable: false, error: 'Ollama usage API response did not include session/weekly usage.' };
      }

      return {
        limitsAvailable: true,
        session,
        weekly,
        costUSD: Number.isFinite(costUSD) ? costUSD : undefined,
        costPeriod,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.main.warn('[OllamaUsageService] Error fetching account usage:', error);
      return { limitsAvailable: false, error: `Failed to reach Ollama usage API: ${message}` };
    }
  }

  private async fetchProxyHealth(): Promise<Pick<OllamaUsageData, 'proxyReachable' | 'configuredAliases'>> {
    try {
      const readiness = await this.fetchWithTimeout(`${PROXY_BASE_URL}/health/readiness`);
      if (!readiness.ok) {
        throw new Error(`readiness returned HTTP ${readiness.status}`);
      }
      const modelInfo = await this.fetchWithTimeout(`${PROXY_BASE_URL}/model/info`);
      if (!modelInfo.ok) {
        throw new Error(`/model/info returned HTTP ${modelInfo.status}`);
      }
      const payload = (await modelInfo.json()) as LiteLLMModelInfoResponse;
      const configuredAliases = (payload.data ?? [])
        .map((entry) => entry.model_name)
        .filter((name): name is string => typeof name === 'string');
      return { proxyReachable: true, configuredAliases };
    } catch (error) {
      // Not running is the normal idle state for this manually-started dev
      // proxy -- log at debug, not warn/error, to avoid alarm-fatigue.
      logger.main.debug('[OllamaUsageService] Local proxy unreachable (expected if not started):', error);
      return { proxyReachable: false, configuredAliases: [] };
    }
  }

  private resolveEnv(): OllamaEnv {
    let shellEnv: Record<string, string> = {};
    try {
      shellEnv = getShellEnvironment() ?? {};
    } catch (error) {
      logger.main.warn('[OllamaUsageService] Failed to read shell environment:', error);
    }
    return { ...process.env, ...shellEnv };
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${PROXY_AUTH_TOKEN}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// Singleton instance
export const ollamaUsageService = new OllamaUsageServiceImpl();
