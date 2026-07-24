/**
 * Model display utilities for renderer components.
 *
 * IMPORTANT — keep the iOS Swift mirror in sync:
 *   packages/ios/NimbalystNative/Sources/Utils/ModelLabel.swift
 *
 * When you add/rename/remove a Claude Code variant, a Claude API model, an
 * OpenAI model, or change the provider switch in `parseModelInfo` /
 * `getModelShortName`, apply the equivalent change to ModelLabel.swift and
 * update its tests (`Tests/ModelLabelTests.swift`). The iOS session list
 * badge depends on both sides producing the same short label for a given
 * `(provider, model)` pair. Source-of-truth for the tables themselves is
 * still `packages/runtime/src/ai/modelConstants.ts` — the Swift file mirrors
 * the subset of that file it needs.
 */

import {
  CLAUDE_MODELS,
  OPENAI_MODELS,
  CLAUDE_CODE_VARIANT_VERSIONS,
  CLAUDE_CODE_MODEL_LABELS,
  type ClaudeCodeVariant,
} from '@nimbalyst/runtime/ai/modelConstants';
import { CLAUDE_CODE_VARIANTS, ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import {
  isDeepSeekClaudeAgentModel,
} from '@nimbalyst/runtime/ai/server/deepSeekClaudeAgent';

export { type EffortLevel, type ThinkingMode, EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL, DEFAULT_THINKING_MODE, parseEffortLevel, parseThinkingMode } from '@nimbalyst/runtime/ai/server/effortLevels';

interface ModelInfo {
  providerId: string;
  providerName: string;
  modelName: string;
  shortModelName: string;
}

/**
 * Extract Claude Code variant from a model ID using ModelIdentifier.
 * Returns the base variant (without suffix) or null if not a valid Claude Code model.
 */
export function extractClaudeCodeVariant(modelId?: string): ClaudeCodeVariant | null {
  if (!modelId) return null;

  // Try parsing with ModelIdentifier
  const parsed = ModelIdentifier.tryParse(modelId);
  if (parsed && parsed.provider === 'claude-code') {
    // baseVariant strips suffixes like -1m. Membership is checked against the
    // shared CLAUDE_CODE_VARIANTS array so pinned variants (opus-4-6, ...)
    // aren't silently dropped and fall back to sonnet in the picker label.
    const variant = parsed.baseVariant;
    if ((CLAUDE_CODE_VARIANTS as readonly string[]).includes(variant)) {
      return variant as ClaudeCodeVariant;
    }
  }

  // Legacy case: bare 'claude-code' without variant defaults to sonnet
  if (modelId.toLowerCase() === 'claude-code') {
    return 'sonnet';
  }

  return null;
}

function formatVariantLabel(variant: ClaudeCodeVariant): string {
  return CLAUDE_CODE_MODEL_LABELS[variant] ?? variant.charAt(0).toUpperCase() + variant.slice(1);
}

export function getClaudeCodeModelLabel(modelId?: string): string {
  if (isDeepSeekClaudeAgentModel(modelId)) return 'Claude agent - DeepSeek';
  const variant = extractClaudeCodeVariant(modelId) ?? 'sonnet';
  const parsed = modelId ? ModelIdentifier.tryParse(modelId) : null;
  const version = CLAUDE_CODE_VARIANT_VERSIONS[variant];
  const suffix = parsed?.isExtendedContext ? ' (1M)' : '';
  return `Claude Agent · ${formatVariantLabel(variant)} ${version}${suffix}`;
}

export function getClaudeCodeModelShortLabel(modelId?: string): string {
  if (isDeepSeekClaudeAgentModel(modelId)) return 'DeepSeek';
  const variant = extractClaudeCodeVariant(modelId) ?? 'sonnet';
  const parsed = modelId ? ModelIdentifier.tryParse(modelId) : null;
  const version = CLAUDE_CODE_VARIANT_VERSIONS[variant];
  const suffix = parsed?.isExtendedContext ? ' (1M)' : '';
  return `${formatVariantLabel(variant)} ${version}${suffix}`;
}

/**
 * Parse and format model information for display
 */
export function parseModelInfo(modelId?: string): ModelInfo | null {
  if (!modelId) return null;

  // Try parsing with ModelIdentifier
  const parsed = ModelIdentifier.tryParse(modelId);
  if (parsed) {
    // Special case for Claude Code
    if (parsed.provider === 'claude-code') {
      const modelName = getClaudeCodeModelShortLabel(modelId);
      return {
        providerId: 'claude-code',
        providerName: 'Claude Agent',
        modelName,
        shortModelName: modelName
      };
    }

    // Get provider display name
    const providerName = getProviderDisplayName(parsed.provider);

    // Get model display names
    const modelName = getModelDisplayName(parsed.provider, parsed.model);
    const shortModelName = getModelShortName(parsed.provider, parsed.model);

    return {
      providerId: parsed.provider,
      providerName,
      modelName,
      shortModelName
    };
  }

  // Fallback for legacy/non-standard formats
  // Try to parse as provider:model format manually
  if (modelId.includes(':')) {
    const [provider, ...modelParts] = modelId.split(':');
    const model = modelParts.join(':');
    const providerName = getProviderDisplayName(provider);
    const modelName = getModelDisplayName(provider, model);
    const shortModelName = getModelShortName(provider, model);

    return {
      providerId: provider,
      providerName,
      modelName,
      shortModelName
    };
  }

  // If no colon, treat the whole string as a provider name (fallback display)
  return {
    providerId: modelId,
    providerName: getProviderDisplayName(modelId),
    modelName: modelId,
    shortModelName: modelId
  };
}

/**
 * Get provider display name
 */
export function getProviderDisplayName(provider: string): string {
  switch (provider) {
    case 'claude': return 'Claude';
    case 'claude-code': return 'Claude Agent';
    case 'openai': return 'OpenAI';
    case 'lmstudio': return 'LMStudio';
    case 'copilot-cli': return 'GitHub Copilot';
    default: return provider;
  }
}

/**
 * Get provider short label for dropdowns
 */
export function getProviderLabel(provider: string): string {
  switch (provider) {
    case 'claude': return 'Chat';
    case 'claude-code': return 'CODE';
    case 'openai': return 'GPT';
    case 'lmstudio': return 'LOCAL';
    default: return provider.toUpperCase();
  }
}

/**
 * Get model display name based on provider knowledge
 */
export function getModelDisplayName(provider: string, modelId: string): string {
  if (provider === 'claude') {
    const model = CLAUDE_MODELS.find(m => m.id === modelId);
    if (model) return model.displayName;
    // Fallback for unknown models
    return modelId.replace('claude-', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
  
  if (provider === 'openai') {
    const model = OPENAI_MODELS.find(m => m.id === modelId);
    if (model) return model.displayName;
    // Fallback
    return modelId.toUpperCase().replace(/-/g, ' ');
  }

  if (provider === 'lmstudio') {
    // Format local model names
    return modelId
      .replace(/-GGUF$/i, '')
      .replace(/-Q[0-9]_K_[A-Z]/i, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }

  return modelId;
}

/**
 * Get short model name for compact displays
 */
export function getModelShortName(provider: string, modelId: string): string {
  if (provider === 'claude') {
    const model = CLAUDE_MODELS.find(m => m.id === modelId);
    if (model) return model.shortName;
    return modelId.replace('claude-', '');
  }
  
  if (provider === 'openai') {
    const model = OPENAI_MODELS.find(m => m.id === modelId);
    if (model) return model.shortName;
    return modelId;
  }

  if (provider === 'lmstudio') {
    // Truncate long local model names
    const clean = modelId.replace(/-GGUF$/i, '').replace(/-Q[0-9]_K_[A-Z]/i, '');
    if (clean.length > 15) return clean.substring(0, 12) + '...';
    return clean;
  }

  // Default truncation for unknown providers
  if (modelId.length > 15) return modelId.substring(0, 12) + '...';
  return modelId;
}

/**
 * Check if a model supports effort level configuration.
 * Supported: Claude Code Opus, Sonnet, and Fable variants that expose Claude
 * Code effort levels, plus OpenAI Codex models.
 */
export function supportsEffortLevel(modelId?: string): boolean {
  if (!modelId) return false;
  if (isDeepSeekClaudeAgentModel(modelId)) return true;
  const variant = extractClaudeCodeVariant(modelId);
  if (variant === 'opus' || variant === 'opus-4-6' || variant === 'sonnet' || variant === 'sonnet-5' || variant === 'fable-5') return true;
  // OpenAI Codex models support reasoning effort (both SDK and ACP transports)
  const parsed = ModelIdentifier.tryParse(modelId);
  if (parsed?.provider === 'openai-codex' || parsed?.provider === 'openai-codex-acp') return true;
  if (modelId.startsWith('openai-codex:') || modelId.startsWith('openai-codex-acp:')) return true;
  return false;
}

/**
 * Check if a Claude Code model supports disabling extended thinking.
 * Fable variants always require thinking on, and non-Claude-Code providers use
 * their own reasoning controls.
 */
export function supportsThinkingToggle(modelId?: string): boolean {
  if (!modelId) return false;
  if (isDeepSeekClaudeAgentModel(modelId)) return true;
  const normalized = modelId.toLowerCase();
  if (normalized.includes('fable')) return false;
  if (normalized.includes('sonnet-5')) return false;

  const variant = extractClaudeCodeVariant(modelId);
  return variant === 'opus' || variant === 'opus-4-6' || variant === 'sonnet';
}
