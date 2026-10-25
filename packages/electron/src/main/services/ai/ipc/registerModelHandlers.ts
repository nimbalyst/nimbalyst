import { getProviderCredentials } from '../../credentials/providerCredentials';
import { getAgentProviderRegistry } from '../../../extensions/AgentProviderRegistry';
import { safeHandle } from '../../../utils/ipcRegistry';
import { getWindowIdForWindow, resolveActiveWorkspacePathForWindowId } from '../../../window/windowState';
import { getAgentWorkflowService } from '../../AgentWorkflowService';
import { safeSend } from '.././aiServiceUtils';
import { claudeCliSessionSupportsPlugins } from '.././claudeCliLauncherSingleton';
import { isModelEnabled, resolveProviderEnabled } from '.././modelEnablementFilter';
import { type AIServiceContext } from './AIServiceContext';
import { ModelRegistry, ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { type AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import { BrowserWindow } from 'electron';
import { GeminiAntigravityProvider } from '@nimbalyst/runtime/ai/server/providers/GeminiAntigravityProvider';

/**
 * Model catalog and per-provider capability listings.
 *
 * `ai:getAllModels` is the configuration UI's view (everything the providers
 * report); `ai:getModels` is the enabled subset the pickers actually offer.
 */
export function registerModelHandlers(ctx: AIServiceContext): void {
  safeHandle('ai:discoverGeminiModels', async () => {
    try {
      const models = await GeminiAntigravityProvider.discoverModels();
      ModelRegistry.clearCache('antigravity-gemini-agent');
      return { success: true, models };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Get ALL available models for configuration UI
  safeHandle('ai:getAllModels', async (event) => {
    // Clear cache to get fresh models
    ModelRegistry.clearCache();

    // Settings lists OpenCode's discovered models as checkboxes, so this read
    // is scoped to the sending window's project too -- see ai:getModels.
    const workspacePath = resolveActiveWorkspacePathForWindowId(
      getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender)),
    ) ?? undefined;
    const providerSettings = ctx.getNormalizedProviderSettings() as Record<AIProviderType, any>;
    const apiKeys = getProviderCredentials().availableKeys();

    // Only fetch from providers that are enabled (skip LMStudio network call when disabled)
    const enabledSet = new Set<AIProviderType>();
    if (providerSettings['claude']?.enabled === true && !!apiKeys['anthropic']) enabledSet.add('claude');
    if (providerSettings['claude-code']?.enabled !== false) enabledSet.add('claude-code');
    // The terminal-CLI provider is off until the user opts in, so its variants
    // only need fetching once the settings toggle is on.
    if (resolveProviderEnabled('claude-code-cli', providerSettings['claude-code-cli'])) enabledSet.add('claude-code-cli');
    if (providerSettings['openai']?.enabled === true && !!apiKeys['openai']) enabledSet.add('openai');
    if (providerSettings['openai-codex']?.enabled === true) enabledSet.add('openai-codex');
    if (providerSettings['opencode']?.enabled === true) enabledSet.add('opencode');
    // Without these the model picker stays empty for an enabled provider:
    // the catalog is only fetched for ids in this set. Both default to
    // "on if their CLI is installed and signed in", so they must go through
    // resolveProviderEnabled rather than reading the flag directly.
    if (resolveProviderEnabled('grok-build', providerSettings['grok-build'])) enabledSet.add('grok-build');
    if (resolveProviderEnabled('cursor-agent', providerSettings['cursor-agent'])) enabledSet.add('cursor-agent');
    if (resolveProviderEnabled('antigravity-gemini-agent', providerSettings['antigravity-gemini-agent'])) {
      enabledSet.add('antigravity-gemini-agent');
    }
    if (providerSettings['lmstudio']?.enabled === true) enabledSet.add('lmstudio');

    const modelsConfig = {
      ...apiKeys,
      lmstudio_url: providerSettings['lmstudio']?.baseUrl || 'http://127.0.0.1:8234'
    };
    const allModels = await ModelRegistry.getAllModels(modelsConfig, workspacePath, enabledSet);

    // Append extension-contributed agent provider models (see ai:getModels).
    for (const agentEntry of getAgentProviderRegistry().list()) {
      if (agentEntry.status === 'denied') continue;
      for (const m of agentEntry.contribution.models ?? []) {
        allModels.push({
          id: m.id,
          name: m.name,
          provider: agentEntry.contributionId as AIProviderType,
        });
      }
    }

    // Group ALL models by provider (for configuration UI)
    const grouped: Record<string, any[]> = {};
    for (const model of allModels) {
      if (!grouped[model.provider]) {
        grouped[model.provider] = [];
      }
      grouped[model.provider].push(model);
    }

    return {
      success: true,
      models: allModels,
      grouped
    };
  });

  // Clear model cache
  safeHandle('ai:clearModelCache', async () => {
    ModelRegistry.clearCache();
    return { success: true };
  });

  safeHandle('ai:refreshSessionProvider', async (_event, sessionId: string) => {
    ProviderFactory.destroyProvider(sessionId);
    return { success: true };
  });

  safeHandle('ai:getAgentWorkflows', async (
    _event,
    payload?: {
      workspacePath?: string;
      sessionId?: string;
      provider?: string | null;
    }
  ) => {
    try {
      const request = payload ?? {};
      if (!request.workspacePath) {
        throw new Error('ai:getAgentWorkflows requires workspacePath');
      }

      const resolvedProvider = request.provider ?? 'claude-code';
      const nativeCatalog = ctx.getProviderWorkflowCatalog({
        sessionId: request.sessionId,
        provider: resolvedProvider,
      });

      // NIM-845: for a genuine claude-code-cli session, hide extension-plugin
      // (namespaced) commands when the resolved `claude` is too old to accept
      // `--plugin-dir` — those plugins can't load, so the commands would never
      // resolve. The SDK `claude-code` path always loads them in-process.
      const excludePluginCommands =
        resolvedProvider === 'claude-code-cli' && !claudeCliSessionSupportsPlugins();

      const workflows = await getAgentWorkflowService(request.workspacePath).listEntries({
        provider: resolvedProvider,
        nativeCommands: nativeCatalog.commands,
        nativeSkills: nativeCatalog.skills,
        excludePluginCommands,
      });

      return { success: true, workflows };
    } catch (error) {
      console.error('[AIService] Error getting agent workflows:', error);
      return {
        success: false,
        workflows: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  safeHandle('ai:getSlashCommands', async (
    _event,
    payload?: string | { sessionId?: string; provider?: string | null }
  ) => {
    try {
      const request = typeof payload === 'string'
        ? { sessionId: payload, provider: undefined }
        : payload ?? {};
      const { commands, skills } = ctx.getProviderWorkflowCatalog(request);
      return { success: true, commands, skills };
    } catch (error) {
      console.error('[AIService] Error getting slash commands:', error);
      return { success: false, commands: [], skills: [], error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Get ENABLED models for actual use
  safeHandle('ai:getModels', async (event) => {
    // console.log('[AIService] ai:getModels called - fetching enabled models');
    // OpenCode resolves its provider set from project config, so this listing
    // is workspace-scoped even though every other provider is global. Resolve
    // the sender's project rather than threading a path through nine renderer
    // call sites -- same approach TrackerSchemaService takes for #1178.
    const workspacePath = resolveActiveWorkspacePathForWindowId(
      getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender)),
    ) ?? undefined;
    const providerSettings = ctx.getNormalizedProviderSettings() as Record<AIProviderType, any>;
    const apiKeys = getProviderCredentials().availableKeys();
    const claudeCodeSettings = providerSettings['claude-code'] || {};

    // console.log('[AIService] ai:getModels - claude-code settings:', {
    //   enabled: claudeCodeSettings.enabled,
    //   models: claudeCodeSettings.models
    // });

    // Build enabled providers map (needed before fetching to skip disabled providers)
    const enabledProviders: Record<AIProviderType, { enabled: boolean; models?: string[]; hiddenModels?: string[] }> = {
      'claude': {
        enabled: providerSettings['claude']?.enabled === true && !!apiKeys['anthropic'],
        models: providerSettings['claude']?.models,
        hiddenModels: providerSettings['claude']?.hiddenModels
      },
      'claude-code': {
        // Respect the user's toggle but don't require an API key—Claude Code uses CLI auth
        enabled: claudeCodeSettings.enabled !== false,
        models: claudeCodeSettings.models,
        hiddenModels: claudeCodeSettings.hiddenModels
      },
      'claude-code-cli': {
        // Genuine `claude` CLI in a terminal. Off by default — it's a workflow
        // preference, not the way to use a Claude subscription. No API key
        // required; the CLI uses its own login.
        enabled: resolveProviderEnabled('claude-code-cli', providerSettings['claude-code-cli']),
        models: providerSettings['claude-code-cli']?.models,
        hiddenModels: providerSettings['claude-code-cli']?.hiddenModels
      },
      'openai': {
        enabled: providerSettings['openai']?.enabled === true && !!apiKeys['openai'],
        models: providerSettings['openai']?.models,
        hiddenModels: providerSettings['openai']?.hiddenModels
      },
      // These four each authenticate through their own CLI or config, so no
      // API key is required -- but they still need models/hiddenModels
      // forwarded, or hiding a model in Settings does nothing to the session
      // picker (#1382).
      'openai-codex': {
        enabled: providerSettings['openai-codex']?.enabled === true,
        models: providerSettings['openai-codex']?.models,
        hiddenModels: providerSettings['openai-codex']?.hiddenModels
      },
      'openai-codex-acp': {
        enabled: providerSettings['openai-codex-acp']?.enabled === true,
        models: providerSettings['openai-codex-acp']?.models,
        hiddenModels: providerSettings['openai-codex-acp']?.hiddenModels
      },
      'opencode': {
        enabled: providerSettings['opencode']?.enabled === true,
        models: providerSettings['opencode']?.models,
        hiddenModels: providerSettings['opencode']?.hiddenModels
      },
      'copilot-cli': {
        enabled: providerSettings['copilot-cli']?.enabled === true,
        models: providerSettings['copilot-cli']?.models,
        hiddenModels: providerSettings['copilot-cli']?.hiddenModels
      },
      'grok-build': {
        enabled: resolveProviderEnabled('grok-build', providerSettings['grok-build']),
        models: providerSettings['grok-build']?.models,
        hiddenModels: providerSettings['grok-build']?.hiddenModels
      },
      'cursor-agent': {
        enabled: resolveProviderEnabled('cursor-agent', providerSettings['cursor-agent']),
        models: providerSettings['cursor-agent']?.models,
        hiddenModels: providerSettings['cursor-agent']?.hiddenModels
      },
      'antigravity-gemini-agent': {
        enabled: resolveProviderEnabled(
          'antigravity-gemini-agent',
          providerSettings['antigravity-gemini-agent'],
        ),
        models: providerSettings['antigravity-gemini-agent']?.models,
        hiddenModels: providerSettings['antigravity-gemini-agent']?.hiddenModels
      },
      'lmstudio': {
        enabled: providerSettings['lmstudio']?.enabled === true,
        models: providerSettings['lmstudio']?.models,
        hiddenModels: providerSettings['lmstudio']?.hiddenModels
      }
    };

    // Only fetch models from enabled providers (avoids network errors for disabled ones like LMStudio)
    const enabledProviderSet = new Set(
      (Object.entries(enabledProviders) as [AIProviderType, { enabled: boolean }][])
        .filter(([, v]) => v.enabled)
        .map(([k]) => k)
    );
    const modelsConfig = {
      ...apiKeys,
      lmstudio_url: providerSettings['lmstudio']?.baseUrl || 'http://127.0.0.1:8234'
    };
    const allModels = await ModelRegistry.getAllModels(modelsConfig, workspacePath, enabledProviderSet);

    // const claudeCodeModels = allModels.filter(m => m.provider === 'claude-code');
    // console.log('[AIService] ai:getModels - claude-code models from registry:',
    //   claudeCodeModels.map(m => ({ id: m.id, name: m.name })));

    // Filter to only enabled models. The gate is extracted to a pure,
    // unit-tested function so the claude-code family (SDK + CLI) can't silently
    // hide a shipped variant again (NIM-1486).
    const enabledModels = allModels.filter(model =>
      isModelEnabled(model, enabledProviders[model.provider as AIProviderType]),
    );

    // Surface extension-contributed agent providers (aiAgentProviders) in the
    // picker. The built-in `enabledProviders` map is keyed on AIProviderType,
    // so the filter above drops them; append after it. Each registered,
    // non-denied entry contributes its manifest models under its flat
    // contribution id -- the value session.provider carries and the host-side
    // resolver (providerResolution.ts) looks up. Descriptor/affordance shape
    // flagged for Greg's call in the seed PR.
    const providerLabels: Record<string, string> = {};
    const providerIcons: Record<string, string> = {};
    for (const agentEntry of getAgentProviderRegistry().list()) {
      if (agentEntry.status === 'denied') continue;
      providerLabels[agentEntry.contributionId] =
        agentEntry.contribution.displayName || agentEntry.contributionId;
      if (agentEntry.contribution.icon) {
        providerIcons[agentEntry.contributionId] = agentEntry.contribution.icon;
      }
      for (const m of agentEntry.contribution.models ?? []) {
        enabledModels.push({
          id: m.id,
          name: m.name,
          provider: agentEntry.contributionId as AIProviderType,
        });
      }
    }

    // Group ENABLED models by provider (not all models)
    const grouped: Record<string, any[]> = {};
    for (const model of enabledModels) {
      if (!grouped[model.provider]) {
        grouped[model.provider] = [];
      }
      grouped[model.provider].push(model);
    }

    // Debug logging - uncomment if needed. ai:getModels is called on every
    // model-picker render, and this dumps the whole claude-code model array
    // each time; it was ~14% of main.log by volume.
    // const enabledClaudeCodeModels = enabledModels.filter(m => m.provider === 'claude-code');
    // console.log('[AIService] ai:getModels - returning enabled claude-code models:',
    //   enabledClaudeCodeModels.map(m => ({ id: m.id, name: m.name })));

    return {
      success: true,
      models: enabledModels.map(m => ({
        id: m.id,
        display_name: m.name,
        provider: m.provider,
        maxTokens: m.maxTokens
      })),
      grouped,  // This now contains only enabled models
      providers: enabledProviders,
      // Maps of extension contribution id -> manifest displayName / icon, so
      // the picker labels extension agent groups (e.g. "Gemini" + auto_awesome)
      // instead of prettifying the raw contribution id.
      providerLabels,
      providerIcons
    };
  });

  // MCP integration for applyDiff results
  safeHandle('mcp:applyDiff:result', async (event, resultChannel: string, result: any) => {
    // Forward result back through the result channel
    safeSend(event, resultChannel, result);
  });
}
