/**
 * AI Settings Merge Utility
 *
 * Merges global AI settings with project-level overrides.
 * Project settings take precedence over global settings.
 * undefined/null in project settings means "inherit from global".
 */

import { AIProviderOverrides, ProviderOverride, getAIProviderOverrides } from './store';
import { resolveProjectPath } from './workspaceDetection';

/**
 * Global AI settings structure (from ai-settings electron-store)
 */
export interface GlobalAISettings {
  defaultProvider: string;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, ProviderSettings>;
  showToolCalls: boolean;
  collapseIntermediateProgress: boolean;
  aiDebugLogging: boolean;
  showPromptAdditions: boolean;
  /** Path to a custom Claude Code executable. Empty string means "use bundled SDK". */
  customClaudeCodePath?: string;
}

/**
 * Per-provider settings from global config
 */
export interface ProviderSettings {
  enabled?: boolean;
  models?: string[];
  defaultModel?: string;
  baseUrl?: string;
  apiKey?: string;
  authMethod?: string;
}

/**
 * Effective (merged) settings for a provider
 */
export interface EffectiveProviderSettings extends ProviderSettings {
  /** Indicates if this value came from project override */
  isOverridden?: boolean;
}

/**
 * Effective (merged) AI settings for a project
 */
export interface EffectiveAISettings {
  defaultProvider: string;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, EffectiveProviderSettings>;
  showToolCalls: boolean;
  collapseIntermediateProgress: boolean;
  aiDebugLogging: boolean;
  showPromptAdditions: boolean;
  customClaudeCodePath?: string;
  /** Which settings are overridden at project level */
  overrides: {
    defaultProvider: boolean;
    customClaudeCodePath: boolean;
    providers: Record<string, { enabled?: boolean; models?: boolean; defaultModel?: boolean; apiKey?: boolean }>;
  };
}

/**
 * Merge a single provider's settings with its override
 */
function mergeProviderSettings(
  global: ProviderSettings | undefined,
  override: ProviderOverride | undefined
): EffectiveProviderSettings & { overrideInfo: { enabled?: boolean; models?: boolean; defaultModel?: boolean; apiKey?: boolean } } {
  const base: ProviderSettings = global || {};
  const result: EffectiveProviderSettings = { ...base };
  const overrideInfo: { enabled?: boolean; models?: boolean; defaultModel?: boolean; apiKey?: boolean } = {};

  if (!override) {
    return { ...result, overrideInfo };
  }

  // Override enabled state if explicitly set
  if (override.enabled !== undefined) {
    result.enabled = override.enabled;
    overrideInfo.enabled = true;
  }

  // Override models if provided
  if (override.models !== undefined) {
    result.models = override.models;
    overrideInfo.models = true;
  }

  // Override default model if provided
  if (override.defaultModel !== undefined) {
    result.defaultModel = override.defaultModel;
    overrideInfo.defaultModel = true;
  }

  // Override API key if provided (project-specific key)
  if (override.apiKey !== undefined) {
    result.apiKey = override.apiKey;
    overrideInfo.apiKey = true;
  }

  return { ...result, overrideInfo };
}

/**
 * Read AI provider overrides for a workspace, falling back from a worktree path to the
 * parent project path only when the worktree has no direct override of its own.
 */
export function getAIProviderOverridesWithWorktreeFallback(
  workspacePath?: string
): AIProviderOverrides | undefined {
  if (!workspacePath) {
    return undefined;
  }

  const overrides = getAIProviderOverrides(workspacePath);
  if (overrides) {
    return overrides;
  }

  const projectPath = resolveProjectPath(workspacePath);
  if (projectPath === workspacePath) {
    return undefined;
  }

  return getAIProviderOverrides(projectPath);
}

/**
 * Merge global AI settings with project-level overrides.
 *
 * @param globalSettings - The global AI settings from ai-settings store
 * @param workspacePath - The workspace path to get overrides for (optional)
 * @returns Effective settings with project overrides applied
 */
export function mergeAISettings(
  globalSettings: GlobalAISettings,
  workspacePath?: string
): EffectiveAISettings {
  // If no workspace path, return global settings as-is
  if (!workspacePath) {
    return {
      ...globalSettings,
      overrides: {
        defaultProvider: false,
        customClaudeCodePath: false,
        providers: {},
      },
    };
  }

  // Get project-level overrides
  const projectOverrides = getAIProviderOverridesWithWorktreeFallback(workspacePath);

  // If no overrides, return global settings
  if (!projectOverrides) {
    return {
      ...globalSettings,
      overrides: {
        defaultProvider: false,
        customClaudeCodePath: false,
        providers: {},
      },
    };
  }

  // Start with global settings
  const effective: EffectiveAISettings = {
    defaultProvider: globalSettings.defaultProvider,
    apiKeys: { ...globalSettings.apiKeys },
    providerSettings: {},
    showToolCalls: globalSettings.showToolCalls,
    collapseIntermediateProgress: globalSettings.collapseIntermediateProgress,
    aiDebugLogging: globalSettings.aiDebugLogging,
    showPromptAdditions: globalSettings.showPromptAdditions,
    customClaudeCodePath: globalSettings.customClaudeCodePath,
    overrides: {
      defaultProvider: false,
      customClaudeCodePath: false,
      providers: {},
    },
  };

  // Override default provider if set
  if (projectOverrides.defaultProvider !== undefined) {
    effective.defaultProvider = projectOverrides.defaultProvider;
    effective.overrides.defaultProvider = true;
  }

  // Override custom Claude Code executable path if set
  if (projectOverrides.customClaudeCodePath !== undefined) {
    effective.customClaudeCodePath = projectOverrides.customClaudeCodePath;
    effective.overrides.customClaudeCodePath = true;
  }

  // Get all provider IDs (union of global and override)
  const allProviderIds = new Set([
    ...Object.keys(globalSettings.providerSettings || {}),
    ...Object.keys(projectOverrides.providers || {}),
  ]);

  // Merge each provider's settings
  for (const providerId of allProviderIds) {
    const globalProvider = globalSettings.providerSettings?.[providerId];
    const overrideProvider = projectOverrides.providers?.[providerId];

    const { overrideInfo, ...mergedSettings } = mergeProviderSettings(globalProvider, overrideProvider);

    effective.providerSettings[providerId] = mergedSettings;
    effective.overrides.providers[providerId] = overrideInfo;

    // If provider has a project-specific API key, add it to apiKeys
    if (overrideProvider?.apiKey) {
      // Store under provider-specific key to allow per-project keys
      effective.apiKeys[`${providerId}_project`] = overrideProvider.apiKey;
    }
  }

  return effective;
}

/**
 * Check if a provider is effectively enabled for a workspace
 *
 * @param globalSettings - The global AI settings
 * @param providerId - The provider ID to check
 * @param workspacePath - The workspace path (optional)
 * @returns true if the provider is enabled for this context
 */
export function isProviderEnabled(
  globalSettings: GlobalAISettings,
  providerId: string,
  workspacePath?: string
): boolean {
  const effective = mergeAISettings(globalSettings, workspacePath);
  return effective.providerSettings[providerId]?.enabled ?? false;
}

/**
 * Get the effective API key for a provider in a workspace context
 *
 * @param globalSettings - The global AI settings
 * @param providerId - The provider ID
 * @param workspacePath - The workspace path (optional)
 * @returns The API key to use (project-specific if set, otherwise global)
 */
export function getEffectiveApiKey(
  globalSettings: GlobalAISettings,
  providerId: string,
  workspacePath?: string
): string | undefined {
  const effective = mergeAISettings(globalSettings, workspacePath);

  // Check for project-specific key first
  const projectKey = effective.apiKeys[`${providerId}_project`];
  if (projectKey) {
    return projectKey;
  }

  // Fall back to global key
  // Claude Chat uses the 'anthropic' key; Claude Code has its own auth (SSO)
  if (providerId === 'claude') {
    return effective.apiKeys['anthropic'];
  }
  if (providerId === 'claude-code') {
    return effective.apiKeys['claude-code'];
  }

  return effective.apiKeys[providerId];
}

/**
 * Get the effective model for a provider in a workspace context
 *
 * @param globalSettings - The global AI settings
 * @param providerId - The provider ID
 * @param workspacePath - The workspace path (optional)
 * @returns The default model to use
 */
export function getEffectiveModel(
  globalSettings: GlobalAISettings,
  providerId: string,
  workspacePath?: string
): string | undefined {
  const effective = mergeAISettings(globalSettings, workspacePath);
  return effective.providerSettings[providerId]?.defaultModel;
}

/**
 * Get list of enabled providers for a workspace
 *
 * @param globalSettings - The global AI settings
 * @param workspacePath - The workspace path (optional)
 * @returns Array of enabled provider IDs
 */
export function getEnabledProviders(
  globalSettings: GlobalAISettings,
  workspacePath?: string
): string[] {
  const effective = mergeAISettings(globalSettings, workspacePath);
  return Object.entries(effective.providerSettings)
    .filter(([_, settings]) => settings.enabled)
    .map(([id]) => id);
}
