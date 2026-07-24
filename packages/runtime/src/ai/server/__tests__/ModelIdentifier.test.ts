import { describe, it, expect } from 'vitest';
import { ModelIdentifier } from '../ModelIdentifier';

describe('ModelIdentifier', () => {
  describe('parse', () => {
    it('parses valid claude model identifiers', () => {
      const id = ModelIdentifier.parse('claude:claude-3-5-sonnet-20241022');
      expect(id.provider).toBe('claude');
      expect(id.model).toBe('claude-3-5-sonnet-20241022');
      expect(id.combined).toBe('claude:claude-3-5-sonnet-20241022');
    });

    it('parses valid claude-code model identifiers', () => {
      const id = ModelIdentifier.parse('claude-code:opus');
      expect(id.provider).toBe('claude-code');
      expect(id.model).toBe('opus');
      expect(id.combined).toBe('claude-code:opus');
    });

    it('parses claude-code with 1m suffix', () => {
      const id = ModelIdentifier.parse('claude-code:sonnet-1m');
      expect(id.provider).toBe('claude-code');
      expect(id.model).toBe('sonnet-1m');
      expect(id.combined).toBe('claude-code:sonnet-1m');
      expect(id.baseVariant).toBe('sonnet');
      expect(id.isExtendedContext).toBe(true);
    });

    it('normalizes claude-code opus-4-8 alias to canonical opus', () => {
      const id = ModelIdentifier.parse('claude-code:opus-4-8-1m');
      expect(id.provider).toBe('claude-code');
      expect(id.model).toBe('opus-1m');
      expect(id.combined).toBe('claude-code:opus-1m');
      expect(id.baseVariant).toBe('opus');
      expect(id.isExtendedContext).toBe(true);
    });

    it('parses valid openai model identifiers', () => {
      const id = ModelIdentifier.parse('openai:gpt-4o');
      expect(id.provider).toBe('openai');
      expect(id.model).toBe('gpt-4o');
      expect(id.combined).toBe('openai:gpt-4o');
    });

    it('parses valid lmstudio model identifiers', () => {
      const id = ModelIdentifier.parse('lmstudio:local-model');
      expect(id.provider).toBe('lmstudio');
      expect(id.model).toBe('local-model');
      expect(id.combined).toBe('lmstudio:local-model');
    });

    it('parses valid openai-codex model identifiers', () => {
      const id = ModelIdentifier.parse('openai-codex:openai-codex-cli');
      expect(id.provider).toBe('openai-codex');
      expect(id.model).toBe('openai-codex-cli');
      expect(id.combined).toBe('openai-codex:openai-codex-cli');
    });

    it('throws on empty string', () => {
      expect(() => ModelIdentifier.parse('')).toThrow('Invalid model identifier');
    });

    it('throws on missing colon', () => {
      expect(() => ModelIdentifier.parse('claude')).toThrow('must be in "provider:model" format');
    });

    it('throws on missing model part', () => {
      expect(() => ModelIdentifier.parse('claude:')).toThrow('missing model part');
    });

    it('throws on invalid provider', () => {
      expect(() => ModelIdentifier.parse('invalid:gpt-4')).toThrow('Invalid provider');
    });
  });

  describe('tryParse', () => {
    it('returns ModelIdentifier for valid input', () => {
      const id = ModelIdentifier.tryParse('claude:claude-3-5-sonnet-20241022');
      expect(id).not.toBeNull();
      expect(id!.provider).toBe('claude');
    });

    it('returns null for invalid input', () => {
      expect(ModelIdentifier.tryParse('')).toBeNull();
      expect(ModelIdentifier.tryParse('invalid')).toBeNull();
      expect(ModelIdentifier.tryParse('invalid:model')).toBeNull();
    });
  });

  describe('create', () => {
    it('creates valid claude model identifier', () => {
      const id = ModelIdentifier.create('claude', 'claude-3-5-sonnet-20241022');
      expect(id.provider).toBe('claude');
      expect(id.model).toBe('claude-3-5-sonnet-20241022');
    });

    it('creates valid claude-code model identifier with normalization', () => {
      const id = ModelIdentifier.create('claude-code', 'OPUS');
      expect(id.provider).toBe('claude-code');
      expect(id.model).toBe('opus'); // Normalized to lowercase
    });

    it('creates valid claude-code model identifier with 1m suffix', () => {
      const id = ModelIdentifier.create('claude-code', 'Sonnet-1M');
      expect(id.provider).toBe('claude-code');
      expect(id.model).toBe('sonnet-1m'); // Normalized to lowercase
      expect(id.baseVariant).toBe('sonnet');
      expect(id.isExtendedContext).toBe(true);
    });

    it('accepts explicit opus-4-8 alias and normalizes to canonical opus', () => {
      const id = ModelIdentifier.create('claude-code', 'Opus-4-8');
      expect(id.provider).toBe('claude-code');
      expect(id.model).toBe('opus');
      expect(id.combined).toBe('claude-code:opus');
    });

    it('throws on invalid claude-code variant', () => {
      expect(() => ModelIdentifier.create('claude-code', 'invalid-variant')).toThrow('Invalid Claude Code variant');
    });

    it('throws on invalid provider', () => {
      expect(() => ModelIdentifier.create('invalid' as any, 'model')).toThrow('Invalid provider');
    });

    it('throws on missing model for non-claude-code providers', () => {
      expect(() => ModelIdentifier.create('claude', '')).toThrow('Model is required');
    });

    it('allows empty model for openai-codex (uses default)', () => {
      const id = ModelIdentifier.create('openai-codex', '');
      expect(id.provider).toBe('openai-codex');
      expect(id.model).toBe('default');
    });
  });

  describe('baseVariant', () => {
    it('returns base variant for claude-code models', () => {
      expect(ModelIdentifier.parse('claude-code:opus').baseVariant).toBe('opus');
      expect(ModelIdentifier.parse('claude-code:sonnet').baseVariant).toBe('sonnet');
      expect(ModelIdentifier.parse('claude-code:haiku').baseVariant).toBe('haiku');
    });

    it('strips -1m suffix for claude-code models', () => {
      expect(ModelIdentifier.parse('claude-code:sonnet-1m').baseVariant).toBe('sonnet');
    });

    it('returns model as-is for other providers', () => {
      expect(ModelIdentifier.parse('claude:claude-3-5-sonnet-20241022').baseVariant).toBe('claude-3-5-sonnet-20241022');
      expect(ModelIdentifier.parse('openai:gpt-4o').baseVariant).toBe('gpt-4o');
    });
  });

  describe('isExtendedContext', () => {
    it('returns true for claude-code models with -1m suffix', () => {
      expect(ModelIdentifier.parse('claude-code:sonnet-1m').isExtendedContext).toBe(true);
    });

    it('returns false for claude-code models without -1m suffix', () => {
      expect(ModelIdentifier.parse('claude-code:sonnet').isExtendedContext).toBe(false);
      expect(ModelIdentifier.parse('claude-code:opus').isExtendedContext).toBe(false);
    });

    it('returns false for non-claude-code providers', () => {
      expect(ModelIdentifier.parse('claude:claude-3-5-sonnet-20241022').isExtendedContext).toBe(false);
      expect(ModelIdentifier.parse('openai:gpt-4o').isExtendedContext).toBe(false);
    });
  });

  describe('isClaudeCode', () => {
    it('returns true for claude-code provider', () => {
      expect(ModelIdentifier.parse('claude-code:opus').isClaudeCode()).toBe(true);
    });

    it('returns false for other providers', () => {
      expect(ModelIdentifier.parse('claude:model').isClaudeCode()).toBe(false);
      expect(ModelIdentifier.parse('openai:gpt-4o').isClaudeCode()).toBe(false);
    });
  });

  describe('isAgentProvider', () => {
    it('returns true for agent providers', () => {
      expect(ModelIdentifier.parse('claude-code:opus').isAgentProvider()).toBe(true);
      expect(ModelIdentifier.parse('openai-codex:cli').isAgentProvider()).toBe(true);
    });

    it('returns false for chat providers', () => {
      expect(ModelIdentifier.parse('claude:model').isAgentProvider()).toBe(false);
      expect(ModelIdentifier.parse('openai:gpt-4o').isAgentProvider()).toBe(false);
      expect(ModelIdentifier.parse('lmstudio:model').isAgentProvider()).toBe(false);
    });
  });

  describe('equals', () => {
    it('returns true for identical identifiers', () => {
      const id1 = ModelIdentifier.parse('claude:model');
      const id2 = ModelIdentifier.parse('claude:model');
      expect(id1.equals(id2)).toBe(true);
    });

    it('returns false for different providers', () => {
      const id1 = ModelIdentifier.parse('claude:model');
      const id2 = ModelIdentifier.parse('openai:model');
      expect(id1.equals(id2)).toBe(false);
    });

    it('returns false for different models', () => {
      const id1 = ModelIdentifier.parse('claude:model1');
      const id2 = ModelIdentifier.parse('claude:model2');
      expect(id1.equals(id2)).toBe(false);
    });
  });

  describe('serialization', () => {
    it('toJSON returns combined format', () => {
      const id = ModelIdentifier.parse('claude:model');
      expect(id.toJSON()).toBe('claude:model');
    });

    it('toString returns combined format', () => {
      const id = ModelIdentifier.parse('claude:model');
      expect(id.toString()).toBe('claude:model');
    });

    it('JSON.stringify works correctly', () => {
      const id = ModelIdentifier.parse('claude:model');
      expect(JSON.stringify({ model: id })).toBe('{"model":"claude:model"}');
    });
  });

  describe('immutability', () => {
    it('is frozen and cannot be modified', () => {
      const id = ModelIdentifier.parse('claude:model');
      expect(Object.isFrozen(id)).toBe(true);
    });
  });

  describe('modelForProvider', () => {
    it('returns the model part for API calls', () => {
      expect(ModelIdentifier.parse('claude:claude-3-5-sonnet-20241022').modelForProvider).toBe('claude-3-5-sonnet-20241022');
      expect(ModelIdentifier.parse('claude-code:opus').modelForProvider).toBe('opus');
      expect(ModelIdentifier.parse('claude-code:sonnet-1m').modelForProvider).toBe('sonnet-1m');
      expect(ModelIdentifier.parse('openai:gpt-4o').modelForProvider).toBe('gpt-4o');
    });
  });

  describe('getDefaultForProvider', () => {
    it('returns default ModelIdentifier for claude', () => {
      const id = ModelIdentifier.getDefaultForProvider('claude');
      expect(id.provider).toBe('claude');
      expect(id.combined).toBe('claude:claude-opus-4-8');
    });

    it('returns default ModelIdentifier for claude-code', () => {
      const id = ModelIdentifier.getDefaultForProvider('claude-code');
      expect(id.provider).toBe('claude-code');
      // Default is plain `opus` — current-gen runs 1M natively, so `[1m]` is a
      // redundant no-op (GitHub #825).
      expect(id.combined).toBe('claude-code:opus');
    });

    it('returns default ModelIdentifier for openai', () => {
      const id = ModelIdentifier.getDefaultForProvider('openai');
      expect(id.provider).toBe('openai');
      expect(id.combined).toBe('openai:gpt-5.6-sol');
    });

    it('returns default ModelIdentifier for openai-codex', () => {
      const id = ModelIdentifier.getDefaultForProvider('openai-codex');
      expect(id.provider).toBe('openai-codex');
      expect(id.combined).toBe('openai-codex:gpt-5.6-sol');
    });

    it('returns default ModelIdentifier for openai-codex-acp', () => {
      const id = ModelIdentifier.getDefaultForProvider('openai-codex-acp');
      expect(id.provider).toBe('openai-codex-acp');
      expect(id.combined).toBe('openai-codex-acp:gpt-5.6-sol');
    });

    it('returns default ModelIdentifier for lmstudio', () => {
      const id = ModelIdentifier.getDefaultForProvider('lmstudio');
      expect(id.provider).toBe('lmstudio');
      expect(id.combined).toBe('lmstudio:local-model');
    });
  });

  describe('getDefaultModelId', () => {
    it('returns default model ID string for all providers', () => {
      expect(ModelIdentifier.getDefaultModelId('claude')).toBe('claude:claude-opus-4-8');
      expect(ModelIdentifier.getDefaultModelId('claude-code')).toBe('claude-code:opus');
      expect(ModelIdentifier.getDefaultModelId('openai')).toBe('openai:gpt-5.6-sol');
      expect(ModelIdentifier.getDefaultModelId('openai-codex')).toBe('openai-codex:gpt-5.6-sol');
      expect(ModelIdentifier.getDefaultModelId('openai-codex-acp')).toBe('openai-codex-acp:gpt-5.6-sol');
      expect(ModelIdentifier.getDefaultModelId('lmstudio')).toBe('lmstudio:local-model');
    });
  });
});
