/**
 * OllamaUsageService - Reports what's knowable about Ollama Cloud usage
 *
 * Unlike ClaudeUsageService / CodexUsageService, there is no OLLAMA_API_KEY
 * -authenticated usage/quota API to poll: verified against current docs
 * (2026-07-30):
 * - https://docs.ollama.com/api/usage documents only PER-RESPONSE metrics
 *   (prompt_eval_count, eval_count, durations) returned inline with each
 *   /api/generate or /api/chat call. Neither the native nor the OpenAI-
 *   compatible Ollama Cloud API exposes a `GET` endpoint for cumulative
 *   account usage or remaining quota, unlike Anthropic's /api/oauth/usage or
 *   the Codex app-server's account/rateLimits/read.
 * - https://ollama.com/pricing documents tier-based CONCURRENCY limits (Free
 *   = 1 concurrent cloud model, Pro = 3, Max = 10) and weekly GPU-time quotas
 *   (Pro = 50x Free, Max = 5x Pro): plan facts, not a live reading.
 *
 * The live number DOES exist -- ollama.com/settings ("Cloud usage") shows
 * real Session usage / Weekly usage percentages with reset countdowns
 * (confirmed live by Yogev 2026-07-30). That page is backed by ollama.com's
 * own account dashboard, authenticated by the user's BROWSER LOGIN SESSION
 * (OAuth/cookies), not by an OLLAMA_API_KEY Bearer token -- it is not part of
 * the documented developer API surface at docs.ollama.com, and there's no
 * public contract for calling whatever internal endpoint the dashboard uses.
 * Replicating it server-side would mean Nimbalyst driving a real browser
 * through the user's personal Ollama login and holding that session --
 * a materially different, heavier, and more privacy-sensitive integration
 * than an API-key REST call, out of scope here without explicit direction.
 * A caller that needs the exact live number today should check
 * ollama.com/settings directly; this service says so (see `note` below)
 * rather than pretending the number doesn't exist anywhere.
 *
 * So this service does NOT call ollama.com directly, for two reasons: (1)
 * there is no API-key-authenticated endpoint to fetch from, and (2) it
 * shouldn't hold OLLAMA_API_KEY at all. The Nimbalyst<->Ollama Cloud
 * brain-swap route runs every request through a local LiteLLM proxy (see
 * tools/Ollala/nimbalyst-brainswap/litellm-ollama.yaml in the workspace, and
 * the in-app Claude Code "ollama" backend profiles) specifically so the real
 * OLLAMA_API_KEY stays only in the proxy process's environment; Nimbalyst
 * talks to the proxy with a fixed, non-secret local placeholder token.
 * Reading the real key from here would cut across that boundary for no
 * benefit, since the API-key surface has nothing to report even with it.
 *
 * What this service DOES report, by querying the local proxy:
 * - Whether the proxy is reachable right now (it's an optional, manually
 *   started dev process, not something Nimbalyst launches -- "not running"
 *   is a normal idle state, not an error, same spirit as Gemini's
 *   `notStarted` branch).
 * - Which Claude-shaped aliases it currently has configured (from LiteLLM's
 *   own `/model/info`), as a cheap health/config-drift signal.
 * - Static plan-tier reference figures from ollama.com/pricing, clearly
 *   labeled as reference (not live), so a caller isn't left with nothing.
 *
 * Token-level usage aggregation (mirroring Codex's fallback-to-tokens
 * behavior) is a real option once Nimbalyst has a durable, SSOT way to tell
 * "this session's tokens went through Ollama" apart from any other Claude
 * Code session -- that identification does not exist on this branch yet.
 * Wire it up here once it does, rather than guessing at a session-model
 * naming convention that may still change.
 */

import { logger } from '../utils/logger';

export interface OllamaUsagePlanTier {
  tier: string;
  concurrentCloudModels: number;
  weeklyGpuQuota: string;
}

export interface OllamaUsageData {
  /** True once a proxy readiness/model-info round trip has succeeded. */
  proxyReachable: boolean;
  /** Claude-shaped aliases currently registered on the proxy (model_name from /model/info). */
  configuredAliases: string[];
  /** Always false today -- see module doc for why. */
  limitsAvailable: false;
  /** Static reference data from ollama.com/pricing, not a live reading. */
  planTiers: OllamaUsagePlanTier[];
  lastUpdated: number; // Unix timestamp
  /** Human-readable explanation of why limitsAvailable is false, or a proxy error. */
  note: string;
}

const PROXY_BASE_URL = 'http://127.0.0.1:4002';
// Fixed, non-secret local-proxy placeholder token. Matches
// tools/Ollala/nimbalyst-brainswap/litellm-ollama.yaml's general_settings.master_key
// and the in-app Ollama Claude Code backend profiles -- 127.0.0.1-only, never the
// real OLLAMA_API_KEY, which stays inside the proxy process's own environment.
const PROXY_AUTH_TOKEN = 'sk-nim-local-proxy';
const PROXY_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60 * 1000; // Static-ish signal; no need to hammer the local proxy.

const PLAN_TIERS: readonly OllamaUsagePlanTier[] = [
  { tier: 'Free', concurrentCloudModels: 1, weeklyGpuQuota: 'baseline' },
  { tier: 'Pro', concurrentCloudModels: 3, weeklyGpuQuota: '50x Free' },
  { tier: 'Max', concurrentCloudModels: 10, weeklyGpuQuota: '5x Pro' },
];

const NO_ACCOUNT_API_NOTE =
  'Ollama Cloud has no OLLAMA_API_KEY-authenticated usage/quota API (verified docs.ollama.com/api/usage, ' +
  '2026-07-30): only per-response token metrics are available via API key auth, not a cumulative or ' +
  'remaining-quota reading. The real live number DOES exist at https://ollama.com/settings ("Cloud usage" ' +
  '-- Session/Weekly % with reset countdowns), but that page is authenticated by the browser login session, ' +
  'not an API key, so it cannot be polled from here -- check it directly if you need the exact figure. ' +
  'Plan tiers below are static reference figures from ollama.com/pricing, not a live count.';

interface LiteLLMModelInfoEntry {
  model_name?: unknown;
}
interface LiteLLMModelInfoResponse {
  data?: LiteLLMModelInfoEntry[];
}

class OllamaUsageServiceImpl {
  private cachedUsage: OllamaUsageData | null = null;
  private lastFetchTime = 0;
  private inflightRefresh: Promise<OllamaUsageData> | null = null;

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

  private async doRefresh(): Promise<OllamaUsageData> {
    const base = {
      limitsAvailable: false as const,
      planTiers: [...PLAN_TIERS],
      lastUpdated: Date.now(),
    };

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

      const usageData: OllamaUsageData = {
        ...base,
        proxyReachable: true,
        configuredAliases,
        note: NO_ACCOUNT_API_NOTE,
      };
      this.cachedUsage = usageData;
      this.lastFetchTime = Date.now();
      return usageData;
    } catch (error) {
      // Not running is the normal idle state for this manually-started dev
      // proxy -- log at debug, not warn/error, to avoid alarm-fatigue.
      logger.main.debug('[OllamaUsageService] Local proxy unreachable (expected if not started):', error);
      const usageData: OllamaUsageData = {
        ...base,
        proxyReachable: false,
        configuredAliases: [],
        note:
          `Local Ollama brain-swap proxy (${PROXY_BASE_URL}) is not reachable -- this is expected ` +
          'if it has not been started for this session. ' + NO_ACCOUNT_API_NOTE,
      };
      this.cachedUsage = usageData;
      this.lastFetchTime = Date.now();
      return usageData;
    }
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
