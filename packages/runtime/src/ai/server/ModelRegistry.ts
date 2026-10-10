/**
 * Registry of available AI models with dynamic fetching
 */

import {
  AIModel,
  AIProviderType,
  AI_PROVIDER_TYPES,
  ModelIdentifier,
  assertExhaustiveProvider,
  isClaudeCodeFamily,
} from './types';

interface ModelCatalogCacheEntry {
  provider: AIProviderType;
  apiKey: string | undefined;
  models: AIModel[];
  refreshedAt: number;
}

interface ModelCatalogRefresh {
  apiKey: string | undefined;
  promise: Promise<AIModel[]>;
}

/**
 * Which `apiKeys` entry (if any) a provider's catalog fetch needs.
 *
 * `null` means the provider authenticates through its own CLI or vendor app
 * login and Nimbalyst holds no key for it — which is most agent providers, and
 * is deliberate: reading a key from anywhere but explicit settings is the
 * standing no-env-fallback rule.
 *
 * Exhaustive on purpose. This table is what makes `getAllModels` total.
 */
const PROVIDER_API_KEY_SOURCE: Readonly<Record<AIProviderType, string | null>> = Object.freeze({
  claude: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai',
  'openai-codex-acp': 'openai',

  // Its base URL travels separately, as the fourth argument.
  lmstudio: null,

  'claude-code': null,
  'claude-code-cli': null,
  opencode: null,
  'copilot-cli': null,
  'grok-build': null,
  'cursor-agent': null,
  'antigravity-gemini-agent': null,
});

export class ModelRegistry {
  /** Latest successful catalog by provider, for synchronous display-name reads. */
  private static cachedModels: Map<AIProviderType, AIModel[]> = new Map();
  /** Request-scoped catalogs. OpenCode varies by workspace; LM Studio by URL. */
  private static catalogCache: Map<string, ModelCatalogCacheEntry> = new Map();
  private static inFlightRefreshes: Map<string, ModelCatalogRefresh> = new Map();
  private static latestRequestIds: Map<string, number> = new Map();
  private static nextRequestId = 0;
  private static readonly CACHE_DURATION = 60 * 60 * 1000;

  /**
   * Get models for a specific provider (with caching).
   *
   * `workspacePath` is required but accepts `undefined`: OpenCode resolves its
   * provider set from project config, so omitting the workspace silently
   * downgrades that lane to hardcoded presets. Making it a required positional
   * turns "I forgot" into a compile error and leaves "I genuinely have no
   * project here" as something a caller has to write down (#1382).
   */
  static async getModelsForProvider(
    provider: AIProviderType,
    workspacePath: string | undefined,
    apiKey?: string,
    baseUrl?: string
  ): Promise<AIModel[]> {
    const cacheScope = this.getCacheScope(provider, workspacePath, baseUrl);
    const cached = this.catalogCache.get(cacheScope);
    // Claude catalogs are a static list plus the user's Claude settings
    // `modelPicker`; re-reading those small files on every request is what lets
    // an edit show up without a restart or a file watcher.
    const cacheMatchesRequest = cached?.apiKey === apiKey && !isClaudeCodeFamily(provider);

    if (cached && cacheMatchesRequest) {
      if (Date.now() - cached.refreshedAt >= this.CACHE_DURATION) {
        // Stale-while-revalidate: the picker gets a complete known-good catalog
        // now, while one shared refresh updates the next read in the background.
        void this.refreshModelsForProvider(
          cacheScope,
          provider,
          workspacePath,
          apiKey,
          baseUrl,
          cached.models,
        );
      }
      return cached.models;
    }

    // A changed credential is not allowed to read the previous credential's
    // catalog as stale. The first request for the new identity is a cold read.
    return this.refreshModelsForProvider(
      cacheScope,
      provider,
      workspacePath,
      apiKey,
      baseUrl,
      undefined,
    );
  }

  private static refreshModelsForProvider(
    cacheScope: string,
    provider: AIProviderType,
    workspacePath: string | undefined,
    apiKey: string | undefined,
    baseUrl: string | undefined,
    staleModels: AIModel[] | undefined,
  ): Promise<AIModel[]> {
    const inFlight = this.inFlightRefreshes.get(cacheScope);
    if (inFlight && inFlight.apiKey === apiKey) {
      return inFlight.promise;
    }

    const requestId = ++this.nextRequestId;
    this.latestRequestIds.set(cacheScope, requestId);

    let promise: Promise<AIModel[]>;
    promise = this.fetchFreshModels(provider, workspacePath, apiKey, baseUrl)
      .then((models) => {
        // A settings change or explicit clear may supersede this refresh while
        // the network/CLI request is in flight. Never let the old answer win.
        if (this.latestRequestIds.get(cacheScope) === requestId) {
          this.catalogCache.set(cacheScope, {
            provider,
            apiKey,
            models,
            refreshedAt: Date.now(),
          });
          this.cachedModels.set(provider, models);
        }
        return models;
      })
      .catch((error) => {
        console.error(`Failed to fetch models for ${provider}:`, error);
        return staleModels ?? [];
      })
      .finally(() => {
        if (this.inFlightRefreshes.get(cacheScope)?.promise === promise) {
          this.inFlightRefreshes.delete(cacheScope);
        }
      });

    this.inFlightRefreshes.set(cacheScope, { apiKey, promise });
    return promise;
  }

  private static async fetchFreshModels(
    provider: AIProviderType,
    workspacePath: string | undefined,
    apiKey: string | undefined,
    baseUrl: string | undefined,
  ): Promise<AIModel[]> {
    // Extension-contributed agent providers supply their models via the
    // AgentProviderRegistry (surfaced in AIService.ai:getModels), not this
    // built-in registry. Short-circuit so the exhaustive switch below does not
    // log a spurious "Unhandled provider" error for them.
    if (ModelIdentifier.isExtensionProvider(provider)) {
      return [];
    }

    switch (provider) {
      case 'claude':
        const { ClaudeProvider } = await import('./providers/ClaudeProvider');
        return this.filterLatestClaudeModels(ClaudeProvider.getModels());
      case 'claude-code':
        const { ClaudeCodeProvider } = await import('./providers/ClaudeCodeProvider');
        return ClaudeCodeProvider.getModels(workspacePath);
      case 'claude-code-cli':
        const { ClaudeCodeCliProvider } = await import('./providers/ClaudeCodeCliProvider');
        return ClaudeCodeCliProvider.getModels(workspacePath);
      case 'openai':
        const { OpenAIProvider } = await import('./providers/OpenAIProvider');
        return OpenAIProvider.getModels(apiKey);
      case 'openai-codex':
        const { OpenAICodexProvider } = await import('./providers/OpenAICodexProvider');
        return OpenAICodexProvider.getModels(apiKey);
      case 'openai-codex-acp':
        const { OpenAICodexACPProvider } = await import('./providers/OpenAICodexACPProvider');
        return OpenAICodexACPProvider.getModels(apiKey);
      case 'opencode':
        const { OpenCodeProvider } = await import('./providers/OpenCodeProvider');
        return OpenCodeProvider.getModels(workspacePath);
      case 'lmstudio':
        const { LMStudioProvider } = await import('./providers/LMStudioProvider');
        return LMStudioProvider.getModels(baseUrl || 'http://127.0.0.1:1234');
      case 'copilot-cli':
        const { CopilotCLIProvider } = await import('./providers/CopilotCLIProvider');
        return CopilotCLIProvider.getModels();
      case 'grok-build':
        const { GrokBuildProvider } = await import('./providers/GrokBuildProvider');
        return GrokBuildProvider.getModels();
      case 'cursor-agent':
        const { CursorAgentProvider } = await import('./providers/CursorAgentProvider');
        return CursorAgentProvider.getModels();
      case 'antigravity-gemini-agent':
        const { GeminiAntigravityProvider } = await import('./providers/GeminiAntigravityProvider');
        return GeminiAntigravityProvider.getModels();
      default:
        return assertExhaustiveProvider(provider);
    }
  }

  private static getCacheScope(
    provider: AIProviderType,
    workspacePath: string | undefined,
    baseUrl: string | undefined,
  ): string {
    // Claude providers read project/local `.claude/settings*.json` for custom models.
    if (provider === 'opencode' || isClaudeCodeFamily(provider)) {
      return JSON.stringify([provider, workspacePath ?? null]);
    }
    if (provider === 'lmstudio') {
      return JSON.stringify([provider, baseUrl ?? 'http://127.0.0.1:1234']);
    }
    return JSON.stringify([provider]);
  }

  /**
   * Get all available models across all providers.
   * @param apiKeys - API keys and config (e.g., anthropic, openai, lmstudio_url)
   * @param workspacePath - The project this listing is for, or `undefined` for a
   *   host with no project context. Required positionally; see
   *   getModelsForProvider() for why (#1382).
   * @param enabledProviders - Optional set of enabled provider types. If provided, only these providers are fetched.
   */
  static async getAllModels(
    apiKeys: Record<string, string>,
    workspacePath: string | undefined,
    enabledProviders?: Set<AIProviderType>
  ): Promise<AIModel[]> {
    const allModels: AIModel[] = [];

    // Iterating AI_PROVIDER_TYPES against an exhaustive key table, rather than
    // an if-per-provider list, because the list silently omitted providers.
    // `grok-build` and `cursor-agent` were both missing: enabling either put it
    // in Settings and in `enabledProviders` while its catalog was never
    // fetched, so its models never reached the picker and nothing anywhere
    // reported a problem. `Record<AIProviderType, ...>` makes the next addition
    // a compile error instead.
    const promises = AI_PROVIDER_TYPES
      .filter((provider) => !enabledProviders || enabledProviders.has(provider))
      .map((provider) => {
        const key = PROVIDER_API_KEY_SOURCE[provider];
        return this.getModelsForProvider(
          provider,
          workspacePath,
          key ? apiKeys[key] : undefined,
          provider === 'lmstudio' ? apiKeys['lmstudio_url'] : undefined,
        );
      });

    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allModels.push(...result.value);
      }
    }

    return allModels;
  }

  /**
   * Get the default model for a provider
   */
  static async getDefaultModel(provider: AIProviderType): Promise<string> {
    if (ModelIdentifier.isExtensionProvider(provider)) {
      // Extension providers have no built-in default; the picker uses the
      // provider's own model list from ai:getModels.
      return '';
    }
    switch (provider) {
      case 'claude':
        const { ClaudeProvider } = await import('./providers/ClaudeProvider');
        return ClaudeProvider.getDefaultModel();
      case 'openai':
        const { OpenAIProvider } = await import('./providers/OpenAIProvider');
        return OpenAIProvider.getDefaultModel();
      case 'claude-code':
        const { ClaudeCodeProvider } = await import('./providers/ClaudeCodeProvider');
        return ClaudeCodeProvider.getDefaultModel();
      case 'claude-code-cli':
        const { ClaudeCodeCliProvider } = await import('./providers/ClaudeCodeCliProvider');
        return ClaudeCodeCliProvider.getDefaultModel();
      case 'openai-codex':
        const { OpenAICodexProvider } = await import('./providers/OpenAICodexProvider');
        return OpenAICodexProvider.getDefaultModel();
      case 'openai-codex-acp':
        const { OpenAICodexACPProvider } = await import('./providers/OpenAICodexACPProvider');
        return OpenAICodexACPProvider.getDefaultModel();
      case 'opencode':
        const { OpenCodeProvider: OCP } = await import('./providers/OpenCodeProvider');
        return OCP.DEFAULT_MODEL;
      case 'lmstudio':
        const { LMStudioProvider } = await import('./providers/LMStudioProvider');
        return LMStudioProvider.getDefaultModel();
      case 'copilot-cli':
        const { CopilotCLIProvider: CLP } = await import('./providers/CopilotCLIProvider');
        return CLP.getDefaultModel();
      case 'grok-build':
        const { GrokBuildProvider: GBP } = await import('./providers/GrokBuildProvider');
        return GBP.getDefaultModel();
      case 'cursor-agent':
        const { CursorAgentProvider: CAP } = await import('./providers/CursorAgentProvider');
        return CAP.getDefaultModel();
      case 'antigravity-gemini-agent':
        const { GeminiAntigravityProvider: GAP } = await import('./providers/GeminiAntigravityProvider');
        return GAP.getDefaultModel();
      default:
        assertExhaustiveProvider(provider);
    }
  }

  /**
   * Already-fetched catalog for a provider, or undefined if nothing has been
   * fetched yet.
   *
   * Read-only and synchronous on purpose: callers on a hot path (the per-turn
   * system prompt wants a model's display name) must not trigger a network call
   * or a CLI spawn just to prettify a string. An empty cache means "not known
   * yet", and the caller degrades rather than waits.
   */
  static getCachedModels(provider: AIProviderType): AIModel[] | undefined {
    return this.cachedModels.get(provider);
  }

  /**
   * Clear the cache to force fresh fetch
   */
  static clearCache(provider?: AIProviderType): void {
    if (provider) {
      this.cachedModels.delete(provider);
      this.invalidateScopes(entry => entry.provider === provider);
    } else {
      this.cachedModels.clear();
      this.invalidateScopes(() => true);
    }
  }

  private static invalidateScopes(matches: (entry: ModelCatalogCacheEntry) => boolean): void {
    const scopes = new Set([
      ...this.catalogCache.keys(),
      ...this.inFlightRefreshes.keys(),
    ]);
    for (const scope of scopes) {
      const entry = this.catalogCache.get(scope);
      const provider = entry?.provider ?? this.providerFromCacheScope(scope);
      if (!provider || !matches(entry ?? {
        provider,
        apiKey: undefined,
        models: [],
        refreshedAt: 0,
      })) continue;

      this.catalogCache.delete(scope);
      this.inFlightRefreshes.delete(scope);
      this.latestRequestIds.set(scope, ++this.nextRequestId);
    }
  }

  private static providerFromCacheScope(scope: string): AIProviderType | undefined {
    try {
      const [provider] = JSON.parse(scope) as [AIProviderType];
      return provider;
    } catch {
      return undefined;
    }
  }

  private static filterLatestClaudeModels(models: AIModel[]): AIModel[] {
    const latestByVariant = new Map<string, { model: AIModel; releaseDate: number }>();
    let parseFailed = false;

    for (const model of models) {
      const metadata = this.extractClaudeModelMetadata(model);
      if (!metadata) {
        parseFailed = true;
        break;
      }

      const existing = latestByVariant.get(metadata.variant);
      if (!existing || metadata.releaseDate > existing.releaseDate) {
        latestByVariant.set(metadata.variant, { model, releaseDate: metadata.releaseDate });
      }
    }

    if (parseFailed) {
      console.warn('[ModelRegistry] Failed to parse Claude model metadata - returning full list');
      return models;
    }

    return Array.from(latestByVariant.values()).map(entry => entry.model);
  }

  private static extractClaudeModelMetadata(model: AIModel): { variant: string; releaseDate: number } | null {
    // Extract the model part using ModelIdentifier
    const parsed = ModelIdentifier.tryParse(model.id);
    const idPart = parsed ? parsed.model : model.id;
    const normalized = idPart.toLowerCase();
    const variantMatch = normalized.match(/(opus|sonnet|haiku)/);
    const dateMatch = normalized.match(/(\d{8})$/);

    if (!variantMatch || !dateMatch) {
      return null;
    }

    return {
      variant: variantMatch[1],
      releaseDate: Number.parseInt(dateMatch[1], 10)
    };
  }
}
