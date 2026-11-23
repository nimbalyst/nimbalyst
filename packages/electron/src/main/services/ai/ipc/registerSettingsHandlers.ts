import { SAVED_CREDENTIAL } from '../../../../shared/providerCredentials';
import { getProviderCredentials } from '../../credentials/providerCredentials';
import { safeHandle } from '../../../utils/ipcRegistry';
import { logger } from '../../../utils/logger';
import { getWindowId } from '../../../window/WindowManager';
import { resolveActiveWorkspacePathForWindowId } from '../../../window/windowState';
import { getSettingsService } from '../../SettingsService';
import { formatCodexTestError } from '.././aiServiceUtils';
import { type HeadlessAgentId, getCachedHeadlessAgentAvailability, refreshHeadlessAgentAvailability } from '.././headlessAgentAvailability';
import { scheduleMobileSettingsSync } from '.././mobileSettingsSync';
import { resolveProviderEnabled } from '.././modelEnablementFilter';
import { isExtensionAgentProvider } from '.././providerResolution';
import { type AIServiceContext } from './AIServiceContext';
import { GeminiAntigravityProvider, ModelRegistry, OpenAICodexProvider } from '@nimbalyst/runtime/ai/server';
import { BrowserWindow } from 'electron';

/**
 * Global AI settings read/write and provider connection testing.
 *
 * `ai:saveSettings` must invalidate the memoized normalized-provider-settings
 * snapshot, or a provider toggled off keeps being served as enabled until
 * restart.
 */
export function registerSettingsHandlers(ctx: AIServiceContext): void {
  /**
   * Effective on/off state for the agents whose default is decided by
   * detection rather than a constant.
   *
   * The renderer needs this at hydration: its own default table cannot tell
   * "user turned it off" from "never touched", so without this the settings
   * toggle would render OFF while the model picker showed the provider ON.
   * Awaits any in-flight probe so the answer is deterministic rather than
   * whatever the cache happened to hold.
   */
  safeHandle('ai:getHeadlessAgentAvailability', async () => {
    await refreshHeadlessAgentAvailability();
    const providerSettings = ctx.getNormalizedProviderSettings() as Record<string, any>;
    const agents: HeadlessAgentId[] = ['grok-build', 'cursor-agent', 'antigravity-gemini-agent'];
    const result: Record<string, {
      installed: boolean;
      signedIn: boolean;
      defaultEnabled: boolean;
      effectiveEnabled: boolean;
      /** Resolved binary, so a panel can show WHERE it found the tool. */
      executablePath?: string;
    }> = {};
    for (const agent of agents) {
      const availability = getCachedHeadlessAgentAvailability(agent);
      result[agent] = {
        installed: availability.installed,
        signedIn: availability.signedIn,
        defaultEnabled: availability.installed && availability.signedIn,
        effectiveEnabled: resolveProviderEnabled(agent, providerSettings[agent]),
        executablePath: availability.executablePath,
      };
    }
    return result;
  });

  // Settings handlers
  safeHandle('ai:getSettings', async () => {
    const apiKeys = { ...getProviderCredentials().availableKeys(), lmstudio_url: ctx.getSettingsStore().get('apiKeys.lmstudio_url', '') as string };
    const providerSettings = ctx.getNormalizedProviderSettings();
    const showToolCalls = ctx.getSettingsStore().get('showToolCalls', false) as boolean;
    const chatShowToolCalls = ctx.getSettingsStore().get('chatShowToolCalls', true) as boolean;
    const aiDebugLogging = ctx.getSettingsStore().get('aiDebugLogging', false) as boolean;
    const showPromptAdditions = ctx.getSettingsStore().get('showPromptAdditions', false) as boolean;
    const showUsageIndicator = ctx.getSettingsStore().get('showUsageIndicator', true) as boolean;
    const showCodexUsageIndicator = ctx.getSettingsStore().get('showCodexUsageIndicator', true) as boolean;
    const showGeminiUsageIndicator = ctx.getSettingsStore().get('showGeminiUsageIndicator', true) as boolean;
    const customClaudeCodePath = ctx.getSettingsStore().get('customClaudeCodePath', '') as string;
    const autoCommitEnabled = ctx.getSettingsStore().get('autoCommitEnabled', false) as boolean;
    const trackerAutomation = ctx.getSettingsStore().get('trackerAutomation', {
      enabled: false,
      autoCloseOnCommit: true,
    }) as {
      enabled: boolean;
      autoCloseOnCommit: boolean;
    };
    const diffPeekSize = ctx.getSettingsStore().get('diffPeekSize', null) as
      | { width: number; height: number }
      | null;

    return {
      defaultProvider: ctx.getSettingsStore().get('defaultProvider', 'claude-code'),
      apiKeys: ctx.maskApiKeys(apiKeys),
      providerSettings,
      showToolCalls,
      chatShowToolCalls,
      aiDebugLogging,
      showPromptAdditions,
      showUsageIndicator,
      showCodexUsageIndicator,
      showGeminiUsageIndicator,
      customClaudeCodePath,
      autoCommitEnabled,
      trackerAutomation,
      diffPeekSize,
    };
  });

  safeHandle('ai:saveSettings', async (event, settings: any) => {
    // Legacy compat shim: this used to spread the incoming blob over the
    // stored blob (`{...currentProviderSettings, ...settings.providerSettings}`),
    // which silently dropped fields whenever the renderer's view was stale
    // (NIM-801, codex-lost). Now every field is routed through the per-key
    // SettingsService -- one validated write per key, broadcast to every
    // window, no blob in the wire payload to lose anything from.
    //
    // Renderer code that wants to be safe should call `window.electronAPI.settingsSet`
    // directly; this handler stays only for callers that haven't been
    // migrated yet (and as the implementation behind the convenience helpers
    // like `scheduleAIDebugPersist` until those are removed too).
    const svc = getSettingsService();

    const safeSet = (key: string, value: unknown): void => {
      try {
        svc.set(key as any, value as any);
      } catch (err) {
        logger.main.error(`[ai:saveSettings] svc.set(${key}) rejected:`, err);
      }
    };

    if (settings.defaultProvider !== undefined) {
      safeSet('ai.defaultProvider', settings.defaultProvider);
    }

    if (settings.apiKeys) {
      // The renderer sends the masked form of unchanged keys so it can show
      // them in form fields. Don't overwrite real keys with masks; compare
      // each incoming value against the stored mask before writing.
      const stored = (getProviderCredentials().availableKeys()) ?? {};
      const writeApiKey = (name: string, incoming: unknown): void => {
        if (incoming === undefined) return;
        if (!incoming) {
          // Empty string / null clears the key.
          svc.set(`ai.apiKey.${name}` as any, '');
          return;
        }
        if (typeof incoming !== 'string') return;
        if (incoming === SAVED_CREDENTIAL || incoming === ctx.maskApiKey(stored[name] || '')) return; // unchanged
        svc.set(`ai.apiKey.${name}` as any, incoming);

      };
      writeApiKey('anthropic', settings.apiKeys.anthropic);
      writeApiKey('claude-code', settings.apiKeys['claude-code']);
      writeApiKey('openai', settings.apiKeys.openai);
      writeApiKey('openai-codex', settings.apiKeys['openai-codex']);
      if (settings.apiKeys.lmstudio_url !== undefined) {
        // lmstudio_url is a regular setting -- no masking, just write it.
        safeSet('ai.apiKey.lmstudio_url', settings.apiKeys.lmstudio_url);
      }
    }

    if (settings.providerSettings && typeof settings.providerSettings === 'object') {
      // Each incoming slice replaces the stored slice wholesale -- the
      // renderer owns the full config for any provider it sends. By writing
      // per provider id we never touch providers the caller didn't name.
      //
      // normalizeProviderSettings runs per-slice so transient/UI-only fields
      // (testStatus: 'testing', etc.) don't reach disk.
      const normalizedAll = ctx.normalizeProviderSettings(
        settings.providerSettings as Record<string, unknown>,
      ) as Record<string, unknown>;
      for (const [providerId, config] of Object.entries(normalizedAll)) {
        if (config === undefined) continue;
        safeSet(`ai.provider.${providerId}`, config);
      }
      // Provider cache must be invalidated after writes so the next read
      // returns the new value rather than the pre-save snapshot.
      ctx.invalidateNormalizedProviderSettingsCache();
      // Enabling/disabling a provider changes the model list mobile can pick
      // from (e.g. openai-codex). Push a refreshed list so the iOS picker
      // updates without waiting for a restart/reconnect (NIM-976).
      scheduleMobileSettingsSync();
    }

    if (settings.showToolCalls !== undefined)        safeSet('ai.showToolCalls', settings.showToolCalls);
    if (settings.chatShowToolCalls !== undefined)    safeSet('ai.chatShowToolCalls', settings.chatShowToolCalls);
    if (settings.aiDebugLogging !== undefined)       safeSet('ai.aiDebugLogging', settings.aiDebugLogging);
    if (settings.showPromptAdditions !== undefined)  safeSet('ai.showPromptAdditions', settings.showPromptAdditions);
    if (settings.customClaudeCodePath !== undefined) safeSet('ai.customClaudeCodePath', settings.customClaudeCodePath);
    if (settings.autoCommitEnabled !== undefined)    safeSet('ai.autoCommitEnabled', settings.autoCommitEnabled);

    if (settings.showUsageIndicator !== undefined)       safeSet('ai.showUsageIndicator', settings.showUsageIndicator);
    if (settings.showCodexUsageIndicator !== undefined)  safeSet('ai.showCodexUsageIndicator', settings.showCodexUsageIndicator);
    if (settings.showGeminiUsageIndicator !== undefined) safeSet('ai.showGeminiUsageIndicator', settings.showGeminiUsageIndicator);

    if (settings.trackerAutomation !== undefined && typeof settings.trackerAutomation === 'object') {
      // Merge with current for partial updates (callers may send just the
      // toggled field). Whole-object write through SettingsService below.
      const current = (ctx.getSettingsStore().get('trackerAutomation', {
        enabled: false,
        autoCloseOnCommit: true,
      }) as Record<string, unknown>) ?? {};
      safeSet('ai.trackerAutomation', { ...current, ...settings.trackerAutomation });
    }

    if (settings.diffPeekSize !== undefined) {
      // null clears, otherwise expect { width, height }. SettingsService's
      // Zod schema validates the structure too -- safeSet is just additional
      // input shaping.
      if (
        settings.diffPeekSize === null ||
        (typeof settings.diffPeekSize === 'object' &&
          typeof settings.diffPeekSize.width === 'number' &&
          typeof settings.diffPeekSize.height === 'number')
      ) {
        safeSet('ai.diffPeekSize', settings.diffPeekSize);
      }
    }

    return { success: true };
  });

  // Test connection
  safeHandle('ai:testConnection', async (event, provider: string, workspacePath?: string) => {
    const resolvedApiKey = ctx.getApiKeyForProvider(provider, workspacePath);

    // Get the appropriate API key based on provider.
    // Extension-agent providers (aiAgentProviders contributions) handle their
    // own auth inside the extension's backend module (e.g. Antigravity rides
    // ~/.gemini OAuth via AntigravityServerManager.hasGeminiAuth). On the host
    // side we treat them as 'not-required' and return success: the extension's
    // own backend healthcheck would be the ideal probe, but that contract
    // sits behind the seed PR's coordinated host scaffolding work. For now,
    // accepting indicates the extension is installed + the provider is
    // registered, which is what the user sees the green check confirming.
    let apiKey: string | undefined;
    if (isExtensionAgentProvider(provider)) {
      apiKey = 'not-required';
    } else {
      switch (provider) {
        case 'claude':
          apiKey = resolvedApiKey;
          if (!apiKey) {
            return { success: false, error: 'Anthropic API key not configured' };
          }
          break;
        case 'claude-code':
          // Claude Code: API key is optional, uses SSO login if not provided
          apiKey = resolvedApiKey;
          // No error if missing - will use SSO login
          break;
        case 'openai':
          apiKey = resolvedApiKey;
          if (!apiKey) {
            return { success: false, error: 'OpenAI API key not configured' };
          }
          break;
        case 'openai-codex':
          apiKey = resolvedApiKey;
          break;
        case 'opencode':
          // OpenCode: API key is optional, uses its own config
          apiKey = resolvedApiKey || 'not-required';
          break;
        case 'copilot-cli':
          // Copilot uses its own CLI auth, no API key needed
          apiKey = 'not-required';
          break;
        case 'grok-build':
        case 'cursor-agent':
          // CLI login only; no API key to test.
          apiKey = 'not-required';
          break;
        case 'antigravity-gemini-agent':
          // Antigravity CLI (`agy`) login only; no API key to test.
          apiKey = 'not-required';
          break;
        case 'lmstudio':
          // LMStudio doesn't need an API key, just test the connection
          apiKey = 'not-required';
          break;
        default:
          return { success: false, error: `Unknown provider: ${provider}` };
      }
    }

    // Gemini's connectivity probe checks that the `agy` CLI is installed.
    if (provider === 'antigravity-gemini-agent') {
      return GeminiAntigravityProvider.isInstalled()
        ? { success: true, provider }
        : {
          success: false,
          error: GeminiAntigravityProvider.NOT_INSTALLED_MESSAGE,
        };
    }

    // Extension-agent providers: skip the per-provider connectivity probes
    // below and return success directly. The 'try' block below contains
    // provider-specific connectivity logic (list models, run a real SDK
    // request, etc.) tied to each built-in id; none of it applies to an
    // extension-agent and the IDs would all miss the conditional checks.
    if (isExtensionAgentProvider(provider)) {
      return { success: true, provider };
    }

    try {
      // For OpenAI, just try to list models as a connection test
      if (provider === 'openai') {
        // OpenAI's model list is account-scoped, not project-scoped.
        const models = await ModelRegistry.getModelsForProvider('openai', undefined, apiKey);
        return { success: models.length > 0, provider };
      }

      // For OpenAI Codex, run a real SDK request to validate credentials and connectivity
      if (provider === 'openai-codex') {
        const defaultModel = await ModelRegistry.getDefaultModel('openai-codex');
        const testProvider = new OpenAICodexProvider(apiKey ? { apiKey } : undefined);
        // Honor the project rail's active selection (#544). windowStates is
        // keyed by Nimbalyst's window id, not webContents.id, so resolve the
        // window id via getWindowId before the lookup.
        const browserWindow = BrowserWindow.fromWebContents(event.sender);
        const windowId = browserWindow ? getWindowId(browserWindow) : null;
        const effectiveWorkspacePath =
          workspacePath || resolveActiveWorkspacePathForWindowId(windowId);

        if (!effectiveWorkspacePath) {
          return {
            success: false,
            error: 'Open a workspace and trust it to test OpenAI Codex.',
          };
        }

        await testProvider.initialize({
          model: defaultModel,
          maxTokens: 256,
          ...(apiKey ? { apiKey } : {}),
        });

        let sawResponse = false;
        const response = testProvider.sendMessage(
          'Reply with exactly "ok".',
          undefined,
          undefined,
          [],
          effectiveWorkspacePath
        );

        for await (const chunk of response) {
          if (!chunk) continue;
          if (chunk.type === 'error') {
            const raw = chunk.error || 'Unknown Codex error';
            throw new Error(formatCodexTestError(raw, !!apiKey));
          }
          if (chunk.type === 'text' && (chunk.content || '').trim().length > 0) {
            sawResponse = true;
          }
          if (chunk.type === 'complete') {
            break;
          }
        }

        testProvider.destroy();
        if (!sawResponse) {
          throw new Error('No response content received from Codex SDK');
        }

        return { success: true, provider };
      }

      // For OpenCode, verify the CLI is installed. Electron's spawn
      // inherits a restricted PATH that does not include version-manager
      // bin directories (nvm, asdf, Volta, fnm). When the user installs
      // opencode-ai under nvm the binary lives at
      // ~/.nvm/versions/node/<version>/bin/opencode and naked execSync
      // returns "command not found" -- the user sees "OpenCode CLI not
      // found" even though `opencode` resolves fine in their shell.
      // CLIManager.getEnhancedPath() already builds the augmented PATH
      // used by every other CLI check; route through it here too.
      // See nimbalyst#184.
      if (provider === 'opencode') {
        try {
          const { execSync } = await import('child_process');
          const { getEnhancedPath } = await import('../../shellEnvironment');
          const enhancedPath = getEnhancedPath();
          const version = execSync('opencode --version', {
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, PATH: enhancedPath } as Record<string, string>,
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          return { success: true, provider, version };
        } catch {
          return {
            success: false,
            error: 'OpenCode CLI not found. Install it with: npm i -g opencode-ai',
          };
        }
      }

      // For Claude providers, test the API connection
      if (provider === 'claude') {
        console.log('[AIService] testConnection - Testing provider:', provider);

        // Create provider with appropriate config
        const config: any = { apiKey };

        const testProvider = new (await import('@nimbalyst/runtime/ai/server/providers/ClaudeProvider')).ClaudeProvider();

        // Use the provider's default model for testing (already includes prefix)
        const defaultModel = await ModelRegistry.getDefaultModel('claude');
        console.log('[AIService] testConnection - Got default model:', defaultModel);
        config.model = defaultModel;
        console.log('[AIService] testConnection - Initializing with config:', { hasApiKey: !!config.apiKey, model: config.model });
        await testProvider.initialize(config);

        console.log('[AIService] Testing connection by sending a simple message...');
        // Try a simple message
        const response = testProvider.sendMessage('Say "Hello" in one word');
        for await (const chunk of response) {
          if (!chunk) continue;
          if (chunk.type === 'error') {
            throw new Error(chunk.error || 'Unknown error');
          }
        }
        testProvider.destroy();
      }

      // For Claude Code, just verify the API key works with the regular Claude API
      if (provider === 'claude-code') {
        console.log('[AIService] testConnection - Testing Claude Code provider');

        // Test using the regular Claude API to verify the key
        const testProvider = new (await import('@nimbalyst/runtime/ai/server/providers/ClaudeProvider')).ClaudeProvider();
        const config: any = {
          apiKey,
          model: 'claude-haiku-4-5-20251001'
        };

        await testProvider.initialize(config);

        // Quick test message
        const response = testProvider.sendMessage('Say "Hello" in one word');
        for await (const chunk of response) {
          if (!chunk) continue;
          if (chunk.type === 'error') {
            throw new Error(chunk.error || 'Unknown error');
          }
          // Exit after first response
          if (chunk.type === 'text') {
            break;
          }
        }
        testProvider.destroy();
      }

      // For LMStudio, test the endpoint
      if (provider === 'lmstudio') {
        const providerSettings = ctx.getSettingsStore().get('providerSettings', {}) as any;
        const baseUrl = providerSettings['lmstudio']?.baseUrl || 'http://127.0.0.1:8234';
        const response = await fetch(`${baseUrl}/v1/models`);
        if (!response.ok) {
          throw new Error(`LMStudio server not responding at ${baseUrl}`);
        }
      }

      return { success: true, provider };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
