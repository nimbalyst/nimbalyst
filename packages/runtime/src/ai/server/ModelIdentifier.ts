/**
 * ModelIdentifier Value Object
 *
 * A single source of truth for model identification that enforces validity at construction time.
 * Immutable - once created, cannot be modified.
 *
 * Guarantees:
 * - Provider is always a valid AIProviderType
 * - Model is always appropriate for the provider
 * - Combined format is always "provider:model"
 */

import { AIProviderType, AI_PROVIDER_TYPES } from './types';
import {
  CLAUDE_CODE_ACCEPTED_VARIANT_INPUTS,
  DEFAULT_MODELS,
  normalizeClaudeCodeVariant,
} from '../modelConstants';

/**
 * Valid Claude Code model suffixes (e.g., -1m for 1M context window)
 */
const CLAUDE_CODE_VALID_SUFFIXES = ['-1m'] as const;

export class ModelIdentifier {
  private constructor(
    public readonly provider: AIProviderType,
    public readonly model: string
  ) {
    Object.freeze(this);
  }

  /**
   * The canonical string format: "provider:model"
   * Use this for storage and UI display.
   */
  get combined(): string {
    return `${this.provider}:${this.model}`;
  }

  /**
   * The model part only, for passing to provider APIs.
   * For claude-code, this returns the variant (opus/sonnet/haiku) possibly with suffix.
   */
  get modelForProvider(): string {
    return this.model;
  }

  /**
   * For Claude Code models, returns the base variant without suffixes (e.g., 'sonnet' from 'sonnet-1m')
   * For other providers, returns the model as-is.
   */
  get baseVariant(): string {
    if (this.provider === 'claude-code') {
      // Strip known suffixes
      let variant = this.model.toLowerCase();
      for (const suffix of CLAUDE_CODE_VALID_SUFFIXES) {
        if (variant.endsWith(suffix)) {
          return variant.slice(0, -suffix.length);
        }
      }
      return variant;
    }
    return this.model;
  }

  /**
   * For Claude Code models, returns true if this is a variant with extended context (e.g., -1m)
   */
  get isExtendedContext(): boolean {
    if (this.provider !== 'claude-code') {
      return false;
    }
    return this.model.toLowerCase().endsWith('-1m');
  }

  /**
   * Parse a combined "provider:model" string.
   * Throws if format is invalid.
   */
  static parse(combined: string): ModelIdentifier {
    if (!combined || typeof combined !== 'string') {
      throw new Error(`Invalid model identifier: ${combined}`);
    }

    const colonIndex = combined.indexOf(':');
    if (colonIndex === -1) {
      throw new Error(`Model identifier must be in "provider:model" format: ${combined}`);
    }

    const provider = combined.substring(0, colonIndex);
    const model = combined.substring(colonIndex + 1);

    if (!model) {
      throw new Error(`Model identifier missing model part: ${combined}`);
    }

    return ModelIdentifier.create(provider as AIProviderType, model);
  }

  /**
   * Try to parse, returning null instead of throwing.
   */
  static tryParse(combined: string): ModelIdentifier | null {
    try {
      return ModelIdentifier.parse(combined);
    } catch {
      return null;
    }
  }

  /**
   * Create from separate provider and model.
   * Validates that the combination is valid.
   */
  static create(provider: AIProviderType, model: string): ModelIdentifier {
    // Validate provider
    if (!AI_PROVIDER_TYPES.includes(provider)) {
      throw new Error(`Invalid provider: ${provider}`);
    }

    // Validate model for provider
    if (provider === 'claude-code') {
      const normalizedModel = model.toLowerCase();

      // Strip known suffixes to get base variant
      let baseVariant = normalizedModel;
      let suffix = '';
      for (const validSuffix of CLAUDE_CODE_VALID_SUFFIXES) {
        if (normalizedModel.endsWith(validSuffix)) {
          baseVariant = normalizedModel.slice(0, -validSuffix.length);
          suffix = validSuffix;
          break;
        }
      }

      const normalizedVariant = normalizeClaudeCodeVariant(baseVariant);
      if (!normalizedVariant) {
        throw new Error(
          `Invalid Claude Code variant: ${model}. Must be one of: ${CLAUDE_CODE_ACCEPTED_VARIANT_INPUTS.join(', ')} (optionally with -1m suffix)`
        );
      }

      // Normalize to lowercase for consistency
      return new ModelIdentifier(provider, normalizedVariant + suffix);
    }

    if (provider === 'openai-codex') {
      // Codex accepts raw model IDs (e.g., gpt-5) and provider-prefixed IDs.
      return new ModelIdentifier(provider, model || 'default');
    }

    if (!model) {
      throw new Error(`Model is required for provider: ${provider}`);
    }

    return new ModelIdentifier(provider, model);
  }

  /**
   * Check if this model identifier represents a Claude Code provider.
   */
  isClaudeCode(): boolean {
    return this.provider === 'claude-code';
  }

  /**
   * Check if this model identifier represents an agent provider
   * (providers that support MCP and file system tools).
   */
  isAgentProvider(): boolean {
    return this.provider === 'claude-code' || this.provider === 'openai-codex';
  }

  /**
   * Check equality with another ModelIdentifier.
   */
  equals(other: ModelIdentifier): boolean {
    return this.provider === other.provider && this.model === other.model;
  }

  /**
   * For JSON serialization - returns the combined format.
   */
  toJSON(): string {
    return this.combined;
  }

  toString(): string {
    return this.combined;
  }

  /**
   * Get the default ModelIdentifier for a given provider.
   * This is the single source of truth for default models.
   */
  static getDefaultForProvider(provider: AIProviderType): ModelIdentifier {
    const defaultModelId = DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS];
    if (!defaultModelId) {
      throw new Error(`No default model defined for provider: ${provider}`);
    }
    return ModelIdentifier.parse(defaultModelId);
  }

  /**
   * Get the default model ID string (provider:model format) for a given provider.
   * Convenience method that returns the string directly.
   */
  static getDefaultModelId(provider: AIProviderType): string {
    return ModelIdentifier.getDefaultForProvider(provider).combined;
  }
}
