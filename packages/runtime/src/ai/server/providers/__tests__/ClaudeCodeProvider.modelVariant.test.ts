import { describe, it, expect } from 'vitest';
import { resolveClaudeCodeModelVariant } from '../../types';

const DEFAULT_MODEL = 'claude-code:opus-1m';

describe('resolveClaudeCodeModelVariant', () => {
  it.each(['claude-code', 'claude-code-cli'])('resolves explicit 5.5 and preserves the 5 generation for %s', (provider) => {
    expect(resolveClaudeCodeModelVariant(`${provider}:opus-5-5`, DEFAULT_MODEL)).toBe('claude-opus-5-5');
    expect(resolveClaudeCodeModelVariant(`${provider}:opus-5-5-1m`, DEFAULT_MODEL)).toBe('claude-opus-5-5[1m]');
    expect(resolveClaudeCodeModelVariant(`${provider}:opus-5`, DEFAULT_MODEL)).toBe('claude-opus-5');
    expect(resolveClaudeCodeModelVariant(`${provider}:sonnet-5-5`, DEFAULT_MODEL)).toBe('claude-sonnet-5-5');
    expect(resolveClaudeCodeModelVariant(`${provider}:sonnet-5-5-1m`, DEFAULT_MODEL)).toBe('claude-sonnet-5-5[1m]');
    // Saved sonnet-5 defaults stay on Sonnet 5 after the canonical row moved to 5.5.
    expect(resolveClaudeCodeModelVariant(`${provider}:sonnet-5`, DEFAULT_MODEL)).toBe('claude-sonnet-5');
  });

  describe('standard variants (no extended context)', () => {
    it('resolves sonnet to the pinned Sonnet 5.5 model id', () => {
      expect(resolveClaudeCodeModelVariant('claude-code:sonnet', DEFAULT_MODEL)).toBe('claude-sonnet-5-5');
    });

    it('resolves opus variant', () => {
      expect(resolveClaudeCodeModelVariant('claude-code:opus', DEFAULT_MODEL)).toBe('claude-opus-5-5');
    });

    it('resolves haiku to Haiku 5.5 and keeps haiku-4-5 pinned', () => {
      expect(resolveClaudeCodeModelVariant('claude-code:haiku', DEFAULT_MODEL)).toBe('claude-haiku-5-5');
      expect(resolveClaudeCodeModelVariant('claude-code:haiku-5-5', DEFAULT_MODEL)).toBe('claude-haiku-5-5');
      expect(resolveClaudeCodeModelVariant('claude-code:haiku-4-5', DEFAULT_MODEL)).toBe('claude-haiku-4-5-20251001');
    });

    it('resolves fable to the pinned Fable 5.1 model id', () => {
      expect(resolveClaudeCodeModelVariant('claude-code:fable', DEFAULT_MODEL)).toBe('claude-fable-5-1');
    });

    it('resolves pinned fable-5 to the previous-generation model id', () => {
      expect(resolveClaudeCodeModelVariant('claude-code:fable-5', DEFAULT_MODEL)).toBe('claude-fable-5');
    });

    it('fable-1m resolves to the pinned id with the [1m] suffix', () => {
      expect(resolveClaudeCodeModelVariant('claude-code:fable-1m', DEFAULT_MODEL)).toBe('claude-fable-5-1[1m]');
    });

    it('uses default model when config model is undefined', () => {
      expect(resolveClaudeCodeModelVariant(undefined, DEFAULT_MODEL)).toBe('claude-opus-5-5[1m]');
    });

    it('uses default model when config model is empty string', () => {
      expect(resolveClaudeCodeModelVariant('', DEFAULT_MODEL)).toBe('claude-opus-5-5[1m]');
    });
  });

  describe('extended context (1M) variants', () => {
    it('sonnet-1m resolves to the pinned Sonnet 5.5 id with [1m]', () => {
      // CLI 2.1.284 accepts claude-sonnet-5-5[1m] (native 1M either way).
      const result = resolveClaudeCodeModelVariant('claude-code:sonnet-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-sonnet-5-5[1m]');
    });

    it('sonnet-5-1m preserves the previous generation with [1m]', () => {
      const result = resolveClaudeCodeModelVariant('claude-code:sonnet-5-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-sonnet-5[1m]');
    });

    it('opus-1m resolves to pinned 5.5 with [1m]', () => {
      const result = resolveClaudeCodeModelVariant('claude-code:opus-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-5-5[1m]');
    });

    it('haiku-1m resolves to claude-haiku-5-5[1m]', () => {
      const result = resolveClaudeCodeModelVariant('claude-code:haiku-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-haiku-5-5[1m]');
    });

    it('opus-5-1m preserves the previous generation with [1m]', () => {
      const result = resolveClaudeCodeModelVariant('claude-code:opus-5-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-5[1m]');
    });

    it('opus-4-8-1m pinned variant resolves to claude-opus-4-8[1m]', () => {
      const result = resolveClaudeCodeModelVariant('claude-code:opus-4-8-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-4-8[1m]');
    });
  });

  describe('SDK compatibility', () => {
    it('standard variants are valid SDK model values', () => {
      const validSdkValues = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];
      for (const variant of ['sonnet', 'opus', 'haiku']) {
        const result = resolveClaudeCodeModelVariant(`claude-code:${variant}`, DEFAULT_MODEL);
        expect(validSdkValues).toContain(result);
      }
    });

    it('1M variants include [1m] suffix that SDK uses for beta auto-detection', () => {
      // The SDK checks model.includes("[1m]") to auto-add the context-1m-2025-08-07 beta.
      // This is critical because --betas is ignored for OAuth users.
      const variants = ['sonnet-1m', 'opus-1m', 'haiku-1m'];
      for (const variant of variants) {
        const result = resolveClaudeCodeModelVariant(`claude-code:${variant}`, DEFAULT_MODEL);
        expect(result).toContain('[1m]');
      }
    });

    it('standard variants do NOT include [1m] suffix', () => {
      const variants = ['sonnet', 'opus', 'haiku'];
      for (const variant of variants) {
        const result = resolveClaudeCodeModelVariant(`claude-code:${variant}`, DEFAULT_MODEL);
        expect(result).not.toContain('[1m]');
      }
    });
  });

  describe('pinned-version variants', () => {
    it('opus-4-8 resolves to the full claude-opus-4-8 SDK model ID', () => {
      // Pinned after the canonical `opus` alias was bumped to Opus 5, so users
      // can keep selecting 4.8 explicitly.
      const result = resolveClaudeCodeModelVariant('claude-code:opus-4-8', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-4-8');
    });

    it('opus-4-7 resolves to the full claude-opus-4-7 SDK model ID', () => {
      // Pinned after the canonical `opus` alias was bumped forward, so users
      // can keep selecting 4.7 explicitly.
      const result = resolveClaudeCodeModelVariant('claude-code:opus-4-7', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-4-7');
    });

    it('opus-4-7-1m resolves to claude-opus-4-7[1m]', () => {
      const result = resolveClaudeCodeModelVariant('claude-code:opus-4-7-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-4-7[1m]');
    });

    it('opus-4-6 resolves to the full claude-opus-4-6 SDK model ID', () => {
      // Pinned variants always point at a specific Anthropic model, not
      // whatever "latest opus" happens to be, so users can stay on 4.6
      // after the canonical `opus` alias is bumped.
      const result = resolveClaudeCodeModelVariant('claude-code:opus-4-6', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-4-6');
    });

    it('opus-4-6-1m resolves to claude-opus-4-6[1m]', () => {
      // Opus 4.6 needs the context-1m-2025-08-07 beta header for 1M context;
      // the SDK adds it when it sees the [1m] suffix.
      const result = resolveClaudeCodeModelVariant('claude-code:opus-4-6-1m', DEFAULT_MODEL);
      expect(result).toBe('claude-opus-4-6[1m]');
    });
  });

  describe('fallback behavior', () => {
    it('throws for an unrecognized provider', () => {
      expect(() => resolveClaudeCodeModelVariant('openai:gpt-4', DEFAULT_MODEL)).toThrow(
        'Claude Agent requires a claude-code:* model identifier'
      );
    });

    it('throws for an unrecognized variant', () => {
      expect(() => resolveClaudeCodeModelVariant('claude-code:unknown', DEFAULT_MODEL)).toThrow(
        'Unsupported Claude Agent model'
      );
    });

    it('handles raw variant names without provider prefix', () => {
      expect(resolveClaudeCodeModelVariant('sonnet', DEFAULT_MODEL)).toBe('claude-sonnet-5-5');
    });

    it('handles raw variant names with -1m suffix', () => {
      expect(resolveClaudeCodeModelVariant('opus-1m', DEFAULT_MODEL)).toBe('claude-opus-5-5[1m]');
    });

    it('accepts raw pinned opus-5 without provider prefix', () => {
      expect(resolveClaudeCodeModelVariant('opus-5', DEFAULT_MODEL)).toBe('claude-opus-5');
    });

    it('accepts raw pinned opus-4-8 variant without provider prefix', () => {
      expect(resolveClaudeCodeModelVariant('opus-4-8', DEFAULT_MODEL)).toBe('claude-opus-4-8');
    });
  });
});
