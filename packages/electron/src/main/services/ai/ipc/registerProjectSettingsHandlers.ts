import { withoutProviderConfigCredentials } from '../../../../shared/providerCredentials';
import { getProviderCredentials } from '../../credentials/providerCredentials';
import { safeHandle } from '../../../utils/ipcRegistry';
import {
  getAIProviderOverrides,
  saveAIProviderOverrides,
  clearAIProviderOverrides,
  normalizeAIProviderOverrides,
} from '../../../utils/store';
import { mergeAISettings } from '../../../utils/aiSettingsMerge';
import type { AIServiceContext } from './AIServiceContext';

/**
 * Project-level AI settings override handlers.
 *
 * These read and write the per-workspace overrides that layer on top of the
 * global ai-settings store; `ai:getEffectiveSettings` is the merged view the
 * settings UI renders.
 */
export function registerProjectSettingsHandlers(ctx: AIServiceContext): void {
  // Get project-level AI provider overrides
  safeHandle('ai:getProjectSettings', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      return { success: false, error: 'workspacePath is required' };
    }

    const overrides = getAIProviderOverrides(workspacePath);

    return {
      success: true,
      overrides: overrides || null,
    };
  });

  // Get project-level tracker automation override
  safeHandle('ai:getProjectTrackerAutomation', async (_event, workspacePath: string) => {
    if (!workspacePath) return { success: false, error: 'workspacePath is required' };
    const { getTrackerAutomationOverride } = await import('../../../utils/store');
    return { success: true, override: getTrackerAutomationOverride(workspacePath) ?? null };
  });

  // Save project-level tracker automation override
  safeHandle('ai:saveProjectTrackerAutomation', async (_event, workspacePath: string, override: any) => {
    if (!workspacePath) return { success: false, error: 'workspacePath is required' };
    const { saveTrackerAutomationOverride } = await import('../../../utils/store');
    saveTrackerAutomationOverride(workspacePath, override || undefined);
    return { success: true };
  });

  // Save project-level AI provider overrides
  safeHandle('ai:saveProjectSettings', async (_event, workspacePath: string, overrides: any) => {
    if (!workspacePath) {
      return { success: false, error: 'workspacePath is required' };
    }

    const normalizedOverrides = normalizeAIProviderOverrides(overrides);

    // If overrides is null/undefined or empty, clear the overrides
    if (!normalizedOverrides || (Object.keys(normalizedOverrides).length === 0)) {
      saveAIProviderOverrides(workspacePath, undefined);
    } else {
      saveAIProviderOverrides(workspacePath, normalizedOverrides);
    }

    return { success: true };
  });

  // Get effective (merged) AI settings for a workspace
  safeHandle('ai:getEffectiveSettings', async (_event, workspacePath?: string) => {

    // Get global settings
    const apiKeys = { ...getProviderCredentials().availableKeys(), lmstudio_url: ctx.getSettingsStore().get('apiKeys.lmstudio_url', '') as string };
    const providerSettings = withoutProviderConfigCredentials(ctx.getSettingsStore().get('providerSettings', {}) as any);
    const showToolCalls = ctx.getSettingsStore().get('showToolCalls', false) as boolean;
    const chatShowToolCalls = ctx.getSettingsStore().get('chatShowToolCalls', true) as boolean;
    const aiDebugLogging = ctx.getSettingsStore().get('aiDebugLogging', false) as boolean;
    const showPromptAdditions = ctx.getSettingsStore().get('showPromptAdditions', false) as boolean;
    const defaultProvider = ctx.getSettingsStore().get('defaultProvider', 'claude-code') as string;

    const globalSettings = {
      customClaudeCodePath: ctx.getSettingsStore().get('customClaudeCodePath', '') as string,
      defaultProvider,
      apiKeys: ctx.maskApiKeys(apiKeys),
      providerSettings,
      showToolCalls,
      chatShowToolCalls,
      aiDebugLogging,
      showPromptAdditions,
    };

    // Merge with project overrides
    const effective = mergeAISettings(globalSettings, workspacePath);

    return {
      success: true,
      settings: { ...effective, apiKeys: ctx.maskApiKeys(effective.apiKeys), providerSettings: Object.fromEntries(Object.entries(effective.providerSettings).map(([id, config]) => [id, { ...config, ...(config.apiKey ? { apiKey: ctx.maskApiKey(config.apiKey) } : {}) }])) },
    };
  });

  // Clear project-level AI overrides
  safeHandle('ai:clearProjectSettings', async (_event, workspacePath: string) => {
    if (!workspacePath) {
      return { success: false, error: 'workspacePath is required' };
    }

    clearAIProviderOverrides(workspacePath);

    return { success: true };
  });
}
