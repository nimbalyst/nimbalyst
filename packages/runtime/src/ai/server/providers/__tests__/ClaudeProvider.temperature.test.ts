import { describe, it, expect } from 'vitest';
import { ClaudeProvider } from '../ClaudeProvider';

// Regression coverage for nimbalyst#199. Anthropic deprecated `temperature`
// for `claude-opus-4-7`; sending it returns HTTP 400. The default model on
// a fresh install is Opus 4.7, so every new user hit a misleading "Test
// Connection: Failed" until they switched to Sonnet.

describe('ClaudeProvider.supportsTemperature', () => {
  describe('rejects temperature for Opus 4.7+', () => {
    it('returns false for claude-opus-4-7', () => {
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-7')).toBe(false);
    });

    it('returns false for claude-opus-4-8', () => {
      // Anthropic shipped Opus 4.8 with the same temperature-deprecation
      // posture as 4.7 (adaptive thinking, no `temperature` parameter).
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-8')).toBe(false);
    });

    it('returns false for hypothetical future opus-4-9+', () => {
      // Document the forward-compatibility intent: future Opus minors are
      // expected to keep the deprecation pattern.
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-9')).toBe(false);
    });

    it('returns false for two-digit Opus minor (4-10, 4-25)', () => {
      // Without the `\d{1,2}` cap, naive regexes either miss two-digit
      // minors or match the 8-digit date suffix on Opus 4.0.
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-10')).toBe(false);
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-25')).toBe(false);
    });

    it('matches case-insensitively', () => {
      expect(ClaudeProvider.supportsTemperature('CLAUDE-OPUS-4-7')).toBe(false);
      expect(ClaudeProvider.supportsTemperature('Claude-Opus-4-7')).toBe(false);
    });
  });

  describe('rejects temperature for Mythos-class models (Fable 5, Mythos 5)', () => {
    // Fable 5 / Mythos 5 use always-on adaptive thinking and reject
    // `temperature` / `top_p` / `top_k` with a 400, the same posture as Opus 4.7+.
    it('returns false for claude-fable-5', () => {
      expect(ClaudeProvider.supportsTemperature('claude-fable-5')).toBe(false);
    });

    it('returns false for claude-mythos-5 and claude-mythos-preview', () => {
      expect(ClaudeProvider.supportsTemperature('claude-mythos-5')).toBe(false);
      expect(ClaudeProvider.supportsTemperature('claude-mythos-preview')).toBe(false);
    });

    it('matches case-insensitively and trims', () => {
      expect(ClaudeProvider.supportsTemperature('  CLAUDE-FABLE-5  ')).toBe(false);
    });
  });

  describe('accepts temperature for older Opus 4.x', () => {
    it('returns true for Opus 4 (no minor / claude-opus-4-20250514)', () => {
      // The 8-digit date suffix on Opus 4.0 must NOT be parsed as a minor
      // version. A naive regex would capture `2` from `20250514` and treat
      // Opus 4.0 as Opus 4.2, which would still be < 7 and so happen to
      // return true here, but breaks for hypothetical claude-opus-4-99999999.
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-20250514')).toBe(true);
    });

    it('returns true for Opus 4.1', () => {
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-1-20250805')).toBe(true);
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-1')).toBe(true);
    });

    it('returns true for Opus 4.5', () => {
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-5-20251101')).toBe(true);
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-5')).toBe(true);
    });

    it('returns true for Opus 4.6', () => {
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-6')).toBe(true);
    });
  });

  describe('accepts temperature for all Sonnet variants', () => {
    it('returns true for Sonnet 4.6', () => {
      expect(ClaudeProvider.supportsTemperature('claude-sonnet-4-6')).toBe(true);
    });

    it('returns true for Sonnet 4.5', () => {
      expect(ClaudeProvider.supportsTemperature('claude-sonnet-4-5-20250929')).toBe(true);
    });

    it('returns true for Sonnet 4', () => {
      expect(ClaudeProvider.supportsTemperature('claude-sonnet-4-20250514')).toBe(true);
    });

    it('returns true for Sonnet 3.7', () => {
      expect(ClaudeProvider.supportsTemperature('claude-3-7-sonnet-20250219')).toBe(true);
    });

    it('does NOT classify Sonnet 4.7 as Opus 4.7 (different family)', () => {
      // If Anthropic ever ships claude-sonnet-4-7 the regex must NOT match
      // the opus-only pattern. Sonnet has not been reported as deprecating
      // temperature at any version, so this stays true.
      expect(ClaudeProvider.supportsTemperature('claude-sonnet-4-7')).toBe(true);
      expect(ClaudeProvider.supportsTemperature('claude-sonnet-4-99')).toBe(true);
    });
  });

  describe('accepts temperature for Haiku and legacy models', () => {
    it('returns true for Haiku variants', () => {
      expect(ClaudeProvider.supportsTemperature('claude-haiku-4-5')).toBe(true);
      expect(ClaudeProvider.supportsTemperature('claude-3-5-haiku-20241022')).toBe(true);
    });

    it('returns true for legacy Claude 3 Opus', () => {
      expect(ClaudeProvider.supportsTemperature('claude-3-opus-20240229')).toBe(true);
    });
  });

  describe('handles malformed input safely', () => {
    it('treats undefined / null / empty as supporting temperature (no-op)', () => {
      // We cannot strip `temperature` from a request that has no model id;
      // returning true is the conservative choice (preserves existing
      // behaviour for missing-model corner cases). Cast through unknown
      // so the test still exercises the type guard at runtime.
      expect(ClaudeProvider.supportsTemperature(undefined)).toBe(true);
      expect(ClaudeProvider.supportsTemperature(null as unknown as string)).toBe(true);
      expect(ClaudeProvider.supportsTemperature('')).toBe(true);
      expect(ClaudeProvider.supportsTemperature('   ')).toBe(true);
    });

    it('returns true for unrecognised non-Claude ids', () => {
      // Conservative default: include `temperature` for anything we do not
      // explicitly know rejects it. The denylist is the active list; the
      // failure mode of including on a rejecting model is loud (HTTP 400),
      // the failure mode of stripping on a supporting model is silent.
      expect(ClaudeProvider.supportsTemperature('gpt-5')).toBe(true);
      expect(ClaudeProvider.supportsTemperature('not-a-model')).toBe(true);
    });

    it('trims whitespace around the model id before matching', () => {
      expect(ClaudeProvider.supportsTemperature('  claude-opus-4-7  ')).toBe(false);
      expect(ClaudeProvider.supportsTemperature('claude-opus-4-7 ')).toBe(false);
    });
  });
});
